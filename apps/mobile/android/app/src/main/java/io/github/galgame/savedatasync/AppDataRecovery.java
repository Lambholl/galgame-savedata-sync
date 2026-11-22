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

/**
 * 应用私有数据的启动检查：内容读不懂的数据直接删除，之后读取它的模块按没有保存过处理，用默认值。
 *
 * <p>重置的数据项名称和 shared 的 DataResetItem 一致。线程安全。
 */
final class AppDataRecovery {

  private static final String TAG = "AppDataRecovery";
  private static final Object LOCK = new Object();
  // 下面两个字段由 LOCK 保护。
  private static boolean wasChecked;
  private static final List<String> resets = new ArrayList<>();

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

  private static boolean checkServiceSettings(Context context) throws IOException {
    SharedPreferences store = context.getSharedPreferences(
      ListenerRuntime.SETTINGS,
      Context.MODE_PRIVATE
    );
    Object saved = store.getAll().get(ListenerRuntime.PORT);
    if (
      saved == null ||
      (saved instanceof Integer && (Integer) saved >= 1 && (Integer) saved <= 65535)
    ) {
      return false;
    }
    remove(store, ListenerRuntime.PORT);
    return true;
  }

  private static boolean checkPreferences(Context context) throws IOException {
    SharedPreferences store = context.getSharedPreferences(
      AppPreferencesPlugin.FILE,
      Context.MODE_PRIVATE
    );
    Map<String, ?> saved = store.getAll();
    boolean wasSetAside = false;
    for (Map.Entry<String, List<String>> rule : Map.of(
      "theme",
      AppPreferencesPlugin.THEMES,
      "locale",
      AppPreferencesPlugin.LOCALES
    ).entrySet()) {
      Object value = saved.get(rule.getKey());
      if (value != null && !rule.getValue().contains(value)) {
        remove(store, rule.getKey());
        wasSetAside = true;
      }
    }
    return wasSetAside;
  }
}
