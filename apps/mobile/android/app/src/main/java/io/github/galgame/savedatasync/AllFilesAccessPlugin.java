package io.github.galgame.savedatasync;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 所有文件访问权限的状态查询、系统授权页入口和开启提示的记录；接口说明见网页接口 AllFilesAccessApi。 */
@CapacitorPlugin(name = "AllFilesAccess")
public class AllFilesAccessPlugin extends Plugin {

  private static final String FILE = "all-files-access";
  private static final String PROMPTED = "prompted";

  private SharedPreferences store() {
    return getContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
  }

  private JSObject state() {
    JSObject value = new JSObject();
    value.put("isGranted", FileDocumentAccess.isGranted());
    value.put("wasPrompted", store().getBoolean(PROMPTED, false));
    return value;
  }

  @PluginMethod
  public void status(PluginCall call) {
    call.resolve(state());
  }

  @PluginMethod
  public void markPrompted(PluginCall call) {
    if (!store().edit().putBoolean(PROMPTED, true).commit()) {
      call.reject("The prompt state cannot be saved.", "io-failure");
      return;
    }
    call.resolve(state());
  }

  @PluginMethod
  public void openSettings(PluginCall call) {
    Intent intent = new Intent(
      Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
      Uri.fromParts("package", getContext().getPackageName(), null)
    );
    try {
      startActivityForResult(call, intent, "onSettingsClosed");
    } catch (ActivityNotFoundException missing) {
      // 有些系统没有按应用跳转的页面，只有所有应用的列表。
      try {
        startActivityForResult(
          call,
          new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION),
          "onSettingsClosed"
        );
      } catch (ActivityNotFoundException unsupported) {
        call.reject("The system has no all-files access settings page.", "unsupported-operation");
      }
    }
  }

  @ActivityCallback
  private void onSettingsClosed(PluginCall call, ActivityResult result) {
    // 授权页不返回结果，回来后重新查询权限。
    call.resolve(state());
  }
}
