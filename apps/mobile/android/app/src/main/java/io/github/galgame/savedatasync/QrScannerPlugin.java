package io.github.galgame.savedatasync;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import androidx.annotation.Nullable;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 扫码的原生桥：网页调用 start 和 stop 控制 {@link QrCameraSession}，识别出文本时发 qrDetected 事件。
 * 文本的校验由网页的 shared 函数完成。相机权限用 Capacitor 内置的 checkPermissions 查询，别名是 camera。
 */
@CapacitorPlugin(
  name = "QrScanner",
  permissions = @Permission(
    alias = QrScannerPlugin.CAMERA_ALIAS,
    strings = Manifest.permission.CAMERA
  )
)
public class QrScannerPlugin extends Plugin {

  static final String CAMERA_ALIAS = "camera";

  /** 只在主线程读写。 */
  @Nullable
  private QrCameraSession session;

  @PluginMethod
  public void start(PluginCall call) {
    if (getPermissionState(CAMERA_ALIAS) == PermissionState.GRANTED) {
      startCamera(call);
    } else {
      requestPermissionForAlias(CAMERA_ALIAS, call, "onCameraPermission");
    }
  }

  @PermissionCallback
  private void onCameraPermission(PluginCall call) {
    if (getPermissionState(CAMERA_ALIAS) == PermissionState.GRANTED) {
      startCamera(call);
    } else {
      resolveStatus(call, "denied");
    }
  }

  @PluginMethod
  public void stop(PluginCall call) {
    getBridge().executeOnMainThread(() -> {
      closeSession();
      call.resolve();
    });
  }

  @PluginMethod
  public void openAppSettings(PluginCall call) {
    getActivity().startActivity(
      new Intent(
        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        Uri.fromParts("package", getContext().getPackageName(), null)
      )
    );
    call.resolve();
  }

  @Override
  protected void handleOnDestroy() {
    closeSession();
  }

  private void startCamera(PluginCall call) {
    getBridge().executeOnMainThread(() -> {
      closeSession();
      QrCameraSession opened = new QrCameraSession(
        getActivity(),
        getBridge().getWebView(),
        this::publishDetected
      );
      session = opened;
      opened.open(isOpened -> resolveStatus(call, isOpened ? "started" : "failed"));
    });
  }

  private void closeSession() {
    if (session != null) {
      session.close();
      session = null;
    }
  }

  private void publishDetected(String text) {
    JSObject detected = new JSObject();
    detected.put("text", text);
    notifyListeners("qrDetected", detected);
  }

  private static void resolveStatus(PluginCall call, String status) {
    JSObject result = new JSObject();
    result.put("status", status);
    call.resolve(result);
  }
}
