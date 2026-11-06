package io.github.galgame.savedatasync;

import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.activity.EdgeToEdge;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

/** 应用主 Activity：按已保存主题启动，注册原生插件，并管理开屏动画的显示和退出。 */
public class MainActivity extends BridgeActivity {

  /** 屏幕最短边不小于这个值（dp）的设备支持横竖屏，其余设备锁竖屏。 */
  private static final int ROTATABLE_SMALLEST_WIDTH_DP = 600;

  private LaunchAnimation launchAnimation;
  private boolean isStartupContentReady;
  private boolean isSystemPickerOpen;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    applyOrientationPolicy(getResources().getConfiguration());
    // 先按已保存主题设置夜间模式，窗口背景和启动画面随之取 values / values-night。
    AppPreferencesPlugin.applyStoredTheme(this);
    SplashScreen splash = SplashScreen.installSplashScreen(this);
    launchAnimation = new LaunchAnimation();
    splash.setOnExitAnimationListener(launchAnimation::start);
    registerPlugin(LaunchAnimationPlugin.class);
    registerPlugin(AppPreferencesPlugin.class);
    registerPlugin(AppStoragePlugin.class);
    registerPlugin(SafDirectoriesPlugin.class);
    registerPlugin(HttpTransfersPlugin.class);
    registerPlugin(SyncScansPlugin.class);
    registerPlugin(SyncBackupsPlugin.class);
    registerPlugin(SyncWritesPlugin.class);
    registerPlugin(SyncTransfersPlugin.class);
    registerPlugin(DeviceDiscoveryPlugin.class);
    super.onCreate(savedInstanceState);
    // Android 15 起系统强制窗口铺满，更低版本要主动开启；否则页面画不到系统栏下面，状态栏显示系统自己的颜色。
    EdgeToEdge.enable(this);
    // 系统从后台恢复窗口时会先显示任务快照，也就是离开前的页面，然后才轮到开屏覆盖层。
    if (Build.VERSION.SDK_INT >= 33) {
      setRecentsScreenshotEnabled(false);
    }
    ViewGroup decor = (ViewGroup) getWindow().getDecorView();
    // 系统回收后重建时，启动窗口可能是任务快照，开屏退出回调不一定到达。
    if (savedInstanceState == null) {
      launchAnimation.prepare(decor);
    } else {
      launchAnimation.replay(decor);
    }
  }

  /**
   * 记录应用自己打开了系统界面（文件夹选择器），从那里返回时 onRestart 不播放开屏动画。
   * Capacitor 插件的 startActivityForResult 最终都经过这个方法。
   */
  @Override
  @SuppressWarnings("deprecation")
  public void startActivityForResult(Intent intent, int requestCode, Bundle options) {
    isSystemPickerOpen = true;
    try {
      super.startActivityForResult(intent, requestCode, options);
    } catch (RuntimeException cause) {
      // 界面没有打开，Activity 也就不会停止，留着标记会吞掉下一次从后台返回的动画。
      isSystemPickerOpen = false;
      throw cause;
    }
  }

  /** 由首屏就绪插件调用；WebView 确认可绘制后再让开屏淡出，避免露出尚未渲染的背景。 */
  void onStartupContentReady() {
    if (getBridge() == null) {
      return;
    }
    getBridge().getWebView().postVisualStateCallback(
      0,
      new WebView.VisualStateCallback() {
        @Override
        public void onComplete(long requestId) {
          isStartupContentReady = true;
          if (launchAnimation != null) {
            launchAnimation.contentReady();
          }
        }
      }
    );
  }

  /** 从后台返回时在下一次绘制前重新播放开屏动画；从文件夹选择器返回时跳过。 */
  @Override
  public void onRestart() {
    super.onRestart();
    if (isSystemPickerOpen) {
      isSystemPickerOpen = false;
      return;
    }
    launchAnimation = new LaunchAnimation();
    launchAnimation.replay((ViewGroup) getWindow().getDecorView());
    // 网页首屏就绪只通知一次；还没就绪时由 onStartupContentReady 继续。
    if (isStartupContentReady) {
      launchAnimation.contentReady();
    }
  }

  @Override
  public void onStop() {
    if (launchAnimation != null) {
      launchAnimation.stop();
    }
    super.onStop();
  }

  @Override
  public void onDestroy() {
    if (launchAnimation != null) {
      launchAnimation.stop();
    }
    super.onDestroy();
  }

  /** 按屏幕最短边决定是否允许旋转；折叠屏展开或合上时最短边会变，配置变化时要重新判断。 */
  private void applyOrientationPolicy(Configuration configuration) {
    setRequestedOrientation(
      configuration.smallestScreenWidthDp >= ROTATABLE_SMALLEST_WIDTH_DP
        ? ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    );
  }

  /**
   * 重新判断是否允许旋转，并把原生配置的明暗状态通知页面。
   * Capacitor 保留 Activity 处理 uiMode，部分 WebView 不刷新媒体查询，所以由这里发事件，事件只含布尔值。
   */
  @Override
  public void onConfigurationChanged(Configuration configuration) {
    super.onConfigurationChanged(configuration);
    applyOrientationPolicy(configuration);
    if (getBridge() != null) {
      boolean isDark =
        (configuration.uiMode & Configuration.UI_MODE_NIGHT_MASK) ==
        Configuration.UI_MODE_NIGHT_YES;
      getBridge().triggerWindowJSEvent("savedata:theme-change", "{\"dark\":" + isDark + "}");
    }
  }
}
