package io.github.galgame.savedatasync;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Collections;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** 应用配置的原生插件：配置保存在应用私有 SharedPreferences，只接受登记过的键，值只限制长度。 */
@CapacitorPlugin(name = "AppStorage")
public class AppStoragePlugin extends Plugin {

  static final String FILE = "app-storage";
  static final String LIBRARY = "savedata-sync:library:1";
  private static final Set<String> KEYS = Collections.singleton(LIBRARY);
  /** 一个值的最大长度；配置只含 ID、名称和目录引用，正常远小于此上限。 */
  private static final int MAX_LENGTH = 4 * 1024 * 1024;
  private static final Object LIBRARY_LOCK = new Object();

  /** 从已保存的配置读取游戏名；找不到或配置不可读时返回 null。 */
  static String gameName(Context context, String projectId) {
    try {
      String saved = context
        .getSharedPreferences(FILE, Context.MODE_PRIVATE)
        .getString(LIBRARY, null);
      if (saved == null) {
        return null;
      }
      JSONArray games = new JSONObject(saved).getJSONArray("games");
      for (int i = 0; i < games.length(); i++) {
        JSONObject game = games.getJSONObject(i);
        if (projectId.equals(game.getString("id"))) {
          return game.getString("name");
        }
      }
    } catch (JSONException unreadable) {
      /* 备份文件夹退回使用游戏 ID。 */
    }
    return null;
  }

  private static SharedPreferences store(Context context) {
    return context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
  }

  /** 读取游戏库配置的 JSON 文本；从没保存过时返回 null。 */
  static String readLibrary(Context context) {
    synchronized (LIBRARY_LOCK) {
      return store(context).getString(LIBRARY, null);
    }
  }

  /**
   * 保存游戏库配置的 JSON 文本，同步写入存储后返回；线程安全，与 {@link #readLibrary} 互斥。
   *
   * @throws ArchiveFailure 写入失败时抛出 io-failure。
   */
  static void writeLibrary(Context context, String value) throws ArchiveFailure {
    synchronized (LIBRARY_LOCK) {
      if (!store(context).edit().putString(LIBRARY, value).commit()) {
        throw new ArchiveFailure("io-failure", "The game configuration cannot be saved.");
      }
    }
  }

  @PluginMethod
  public void read(PluginCall call) {
    String key = call.getString("key");
    if (!KEYS.contains(key)) {
      call.reject("invalid-request");
      return;
    }
    JSObject result = new JSObject();
    String value = readLibrary(getContext());
    result.put("value", value == null ? JSObject.NULL : value);
    call.resolve(result);
  }

  @PluginMethod
  public void write(PluginCall call) {
    String key = call.getString("key");
    String value = call.getString("value");
    if (!KEYS.contains(key) || value == null || value.length() > MAX_LENGTH) {
      call.reject("invalid-request");
      return;
    }
    try {
      writeLibrary(getContext(), value);
    } catch (ArchiveFailure failed) {
      call.reject("io-failure");
      return;
    }
    call.resolve();
  }

  @PluginMethod
  public void dataResets(PluginCall call) {
    JSObject result = new JSObject();
    result.put("items", new JSONArray(AppDataRecovery.resets()));
    call.resolve(result);
  }

  @PluginMethod
  public void newerData(PluginCall call) {
    JSObject result = new JSObject();
    result.put("items", new JSONArray(AppDataRecovery.newerData()));
    call.resolve(result);
  }

  @PluginMethod
  public void dismissDataResets(PluginCall call) {
    AppDataRecovery.dismiss();
    call.resolve();
  }
}
