package io.github.galgame.savedatasync;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.os.LocaleList;
import androidx.appcompat.app.AppCompatDelegate;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/** 界面偏好（主题、语言）的原生插件：偏好保存在应用私有 SharedPreferences，主题同时设置 AppCompat 夜间模式。 */
@CapacitorPlugin(name = "AppPreferences")
public class AppPreferencesPlugin extends Plugin {

  private static final String FILE = "app-preferences";
  private static final List<String> THEMES = Arrays.asList("system", "light", "dark");
  private static final List<String> LOCALES = Arrays.asList(
    "system",
    "zh-CN",
    "zh-TW",
    "en-US",
    "ja-JP"
  );

  private static SharedPreferences store(Context context) {
    return context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
  }

  private static String stored(SharedPreferences store, String key, List<String> allowed) {
    String value = store.getString(key, "system");
    return allowed.contains(value) ? value : "system";
  }

  /** 返回按已保存的界面语言本地化的 Context；每次调用都重新读取语言。 */
  static Context localizedContext(Context context) {
    String locale = stored(store(context), "locale", LOCALES);
    Configuration configuration = new Configuration(context.getResources().getConfiguration());
    configuration.setLocales(
      "system".equals(locale)
        ? Resources.getSystem().getConfiguration().getLocales()
        : new LocaleList(Locale.forLanguageTag(locale))
    );
    return context.createConfigurationContext(configuration);
  }

  /** 按已保存的主题设置夜间模式；没有保存时跟随系统。 */
  static void applyStoredTheme(Context context) {
    applyTheme(stored(store(context), "theme", THEMES));
  }

  private static void applyTheme(String theme) {
    int mode = "light".equals(theme)
      ? AppCompatDelegate.MODE_NIGHT_NO
      : "dark".equals(theme)
        ? AppCompatDelegate.MODE_NIGHT_YES
        : AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM;
    if (AppCompatDelegate.getDefaultNightMode() != mode) {
      AppCompatDelegate.setDefaultNightMode(mode);
    }
  }

  private static JSObject snapshot(SharedPreferences store) {
    JSObject value = new JSObject();
    value.put("theme", stored(store, "theme", THEMES));
    value.put("locale", stored(store, "locale", LOCALES));
    return value;
  }

  @PluginMethod
  public void read(PluginCall call) {
    call.resolve(snapshot(store(getContext())));
  }

  /** 保存偏好，只接受已知取值；保存成功后在界面线程切换夜间模式，返回保存后的值。 */
  @PluginMethod
  public void write(PluginCall call) {
    String theme = call.getString("theme");
    String locale = call.getString("locale");
    if (!THEMES.contains(theme) || !LOCALES.contains(locale)) {
      call.reject("invalid-request");
      return;
    }
    SharedPreferences store = store(getContext());
    if (!store.edit().putString("theme", theme).putString("locale", locale).commit()) {
      call.reject("io-failure");
      return;
    }
    getActivity().runOnUiThread(() -> applyTheme(theme));
    call.resolve(snapshot(store));
  }
}
