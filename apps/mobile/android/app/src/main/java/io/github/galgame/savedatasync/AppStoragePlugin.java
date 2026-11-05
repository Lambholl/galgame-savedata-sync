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

/**
 * 应用配置（游戏、目录引用、设备关联）保存在应用私有 SharedPreferences，不随 WebView 数据清除。
 * 只接受登记过的键；值为网页校验过的 JSON 文本，原生端只限制长度。
 */
@CapacitorPlugin(name = "AppStorage")
public class AppStoragePlugin extends Plugin {

  private static final String FILE = "app-storage";
  private static final String LIBRARY = "savedata-sync:library:1";
  private static final Set<String> KEYS = Collections.singleton(LIBRARY);
  /** 配置只含 ID、名称和目录引用，正常远小于此上限。 */
  private static final int MAX_LENGTH = 4 * 1024 * 1024;

  /** 原生任务不经过网页，直接读游戏名；找不到或配置不可读时返回 null。 */
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

  private SharedPreferences store() {
    return getContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
  }

  @PluginMethod
  public void read(PluginCall call) {
    String key = call.getString("key");
    if (!KEYS.contains(key)) {
      call.reject("invalid-request");
      return;
    }
    JSObject result = new JSObject();
    String value = store().getString(key, null);
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
    if (!store().edit().putString(key, value).commit()) {
      call.reject("io-failure");
      return;
    }
    call.resolve();
  }
}
