package io.github.galgame.savedatasync;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 开屏动画的原生插件。 */
@CapacitorPlugin(name = "LaunchAnimation")
public class LaunchAnimationPlugin extends Plugin {

  /** 通知网页首屏已提交，WebView 完成绘制后开屏动画淡出；可以重复调用，Activity 销毁后忽略。 */
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
