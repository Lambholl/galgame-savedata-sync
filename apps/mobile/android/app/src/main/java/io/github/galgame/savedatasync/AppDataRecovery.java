package io.github.galgame.savedatasync;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 应用私有数据的启动检查。
 *
 * <p>有数据由更新版本的应用写入时，所有数据都不改动，只记下这些数据项；否则内容读不懂的数据直接删除，之后读取它的模块按没有保存过处理，用默认值。
 *
 * <p>数据项名称和 shared 的 DataResetItem 一致。线程安全。
 */
final class AppDataRecovery {

  private static final String TAG = "AppDataRecovery";
  private static final Object LOCK = new Object();
  // 下面三个字段由 LOCK 保护。
  private static boolean wasChecked;
  private static final List<String> resets = new ArrayList<>();
  private static final List<String> newer = new ArrayList<>();

  private AppDataRecovery() {}

  /**
   * 按 DataResetItem 的顺序检查各项数据，同一进程只检查一次。
   *
   * <p>某一项检查或删除失败时写日志并继续检查下一项，读取这项数据的模块之后照常报错。会读写私有存储，阻塞调用线程。
   */
  static void checkOnce(Context context) {
    Context application = context.getApplicationContext();
    synchronized (LOCK) {
      if (wasChecked) {
        return;
      }
      wasChecked = true;
      findNewer(application);
      if (!newer.isEmpty()) {
        Log.w(TAG, "Data was written by a newer app version: " + newer);
        return;
      }
      check("device-identity", () -> checkIdentity(application));
      check("directories", () -> checkDirectories(application));
      check("library", () -> checkLibrary(application));
      check("backup-settings", () -> checkBackupSettings(application));
      check("service-settings", () -> checkServiceSettings(application));
      check("preferences", () -> checkPreferences(application));
    }
  }

  /** 返回这次启动时重置的数据项；{@link #dismiss} 之后返回空列表。 */
  static List<String> resets() {
    synchronized (LOCK) {
      return new ArrayList<>(resets);
    }
  }

  /** 返回由更新版本的应用写入的数据项，按 DataResetItem 的顺序排列；不为空时没有任何数据被改动。 */
  static List<String> newerData() {
    synchronized (LOCK) {
      return new ArrayList<>(newer);
    }
  }

  /** 清空重置的数据项列表。 */
  static void dismiss() {
    synchronized (LOCK) {
      resets.clear();
    }
  }

  private interface Check {
    /** 检查一项数据；返回是否删除或改写了数据。 */
    boolean run() throws Exception;
  }

  private static void check(String item, Check work) {
    try {
      if (work.run()) {
        Log.w(TAG, "Deleted unreadable data and used defaults: " + item);
        resets.add(item);
      }
    } catch (Exception failure) {
      Log.e(TAG, "Failed to check data: " + item, failure);
    }
  }

  private static void findNewer(Context context) {
    Object directories = context
      .getSharedPreferences(DirectoryStore.PREFERENCES, Context.MODE_PRIVATE)
      .getAll()
      .get(DirectoryStore.REGISTRY);
    if (isNewer(directories, DirectoryStore.REGISTRY_VERSION)) {
      newer.add("directories");
    }
    Object library = context
      .getSharedPreferences(AppStoragePlugin.FILE, Context.MODE_PRIVATE)
      .getAll()
      .get(AppStoragePlugin.LIBRARY);
    if (isNewer(library, ListenerLibrary.LIBRARY_VERSION)) {
      newer.add("library");
    }
    Path settings = new File(context.getFilesDir(), BackupStore.SETTINGS_FILE).toPath();
    try {
      if (
        Files.isRegularFile(settings, LinkOption.NOFOLLOW_LINKS) &&
        Files.size(settings) <= TransferJson.MAX_BYTES &&
        isNewer(
          new String(Files.readAllBytes(settings), StandardCharsets.UTF_8),
          BackupModel.SETTINGS_VERSION
        )
      ) {
        newer.add("backup-settings");
      }
    } catch (IOException unreadable) {
      // 读取失败时判断不了版本；checkBackupSettings 读取时遇到同样的错误只写日志，不删除文件。
      Log.w(TAG, "Failed to read backup settings while checking versions", unreadable);
    }
  }

  /**
   * 判断保存的值是否由更新版本写入：值是 JSON 对象字符串，整数 schemaVersion 大于 currentVersion。
   *
   * <p>规则与 shared 的 isNewerSchemaVersion 相同。
   */
  static boolean isNewer(Object saved, int currentVersion) {
    if (!(saved instanceof String)) {
      return false;
    }
    try {
      Object version = new JSONObject((String) saved).opt("schemaVersion");
      return (
        (version instanceof Integer || version instanceof Long) &&
        ((Number) version).longValue() > currentVersion
      );
    } catch (JSONException unreadable) {
      return false;
    }
  }

  private static void remove(SharedPreferences store, String key) throws IOException {
    if (!store.edit().remove(key).commit()) {
      throw new IOException("Unreadable data could not be deleted.");
    }
  }

  private static boolean checkIdentity(Context context) throws IOException {
    SharedPreferences store = DeviceIdentity.store(context);
    Object saved = store.getAll().get(DeviceIdentity.KEY);
    if (saved == null || DeviceIdentity.isValid(saved)) {
      return false;
    }
    remove(store, DeviceIdentity.KEY);
    return true;
  }

  private static boolean checkDirectories(Context context) throws Exception {
    SharedPreferences store = context.getSharedPreferences(
      DirectoryStore.PREFERENCES,
      Context.MODE_PRIVATE
    );
    Object saved = store.getAll().get(DirectoryStore.REGISTRY);
    if (saved == null) {
      return false;
    }
    DirectoryStore.SavedRegistry registry =
      saved instanceof String ? DirectoryStore.SavedRegistry.parse((String) saved) : null;
    if (registry == null) {
      remove(store, DirectoryStore.REGISTRY);
      return true;
    }
    if (registry.isComplete) {
      return false;
    }
    // 只有部分根目录读不出时，改写成只含读得出的根目录。
    if (!store.edit().putString(DirectoryStore.REGISTRY, registry.serialize()).commit()) {
      throw new IOException("The directory registry could not be rewritten.");
    }
    return true;
  }

  private static boolean checkLibrary(Context context) throws IOException {
    SharedPreferences store = context.getSharedPreferences(
      AppStoragePlugin.FILE,
      Context.MODE_PRIVATE
    );
    Object saved = store.getAll().get(AppStoragePlugin.LIBRARY);
    if (saved == null) {
      return false;
    }
    try {
      ListenerLibrary.checkConfig(
        TransferJson.parse(((String) saved).getBytes(StandardCharsets.UTF_8))
      );
      return false;
    } catch (Exception unreadable) {
      remove(store, AppStoragePlugin.LIBRARY);
      return true;
    }
  }

  private static boolean checkBackupSettings(Context context) throws IOException {
    Path path = new File(context.getFilesDir(), BackupStore.SETTINGS_FILE).toPath();
    if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
      return false;
    }
    boolean isReadable =
      Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) &&
      Files.size(path) <= TransferJson.MAX_BYTES;
    if (isReadable) {
      byte[] bytes = Files.readAllBytes(path);
      try {
        BackupModel.settings(TransferJson.parse(bytes));
        return false;
      } catch (Exception unreadable) {
        isReadable = false;
      }
    }
    Files.delete(path);
    return true;
  }

  // 端口超出范围时由 ListenerRuntime 重新生成，这里只删除类型不对、读取时会抛错的值。
  private static boolean checkServiceSettings(Context context) throws IOException {
    SharedPreferences store = context.getSharedPreferences(
      ListenerRuntime.SETTINGS,
      Context.MODE_PRIVATE
    );
    Object saved = store.getAll().get(ListenerRuntime.PORT);
    if (saved == null || saved instanceof Integer) {
      return false;
    }
    remove(store, ListenerRuntime.PORT);
    return true;
  }

  // 不认识的主题和语言由 AppPreferencesPlugin 读成跟随系统，保留原值供更新版本使用；这里只删除类型不对、读取时会抛错的值。
  private static boolean checkPreferences(Context context) throws IOException {
    SharedPreferences store = context.getSharedPreferences(
      AppPreferencesPlugin.FILE,
      Context.MODE_PRIVATE
    );
    Map<String, ?> saved = store.getAll();
    boolean wasSetAside = false;
    for (String key : List.of("theme", "locale")) {
      Object value = saved.get(key);
      if (value != null && !(value instanceof String)) {
        remove(store, key);
        wasSetAside = true;
      }
    }
    Object addNomedia = saved.get(AppPreferencesPlugin.ADD_NOMEDIA);
    if (addNomedia != null && !(addNomedia instanceof Boolean)) {
      remove(store, AppPreferencesPlugin.ADD_NOMEDIA);
      wasSetAside = true;
    }
    return wasSetAside;
  }
}
