package io.github.galgame.savedatasync;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 网页提交首屏后调用 ready，重复调用安全。 */
@CapacitorPlugin(name = "LaunchAnimation")
public class LaunchAnimationPlugin extends Plugin {

  /** 切到 UI 线程，等 WebView 已提交的内容可绘制后允许开屏淡出；Activity 销毁后忽略通知。 */
  @PluginMethod
  public void ready(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      if (getActivity() instanceof MainActivity && !getActivity().isDestroyed()) {
        ((MainActivity) getActivity()).onStartupContentReady();
      }
      call.resolve();
    });
  }
}
