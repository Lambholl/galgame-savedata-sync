package io.github.galgame.savedatasync;

import android.os.Bundle;
import android.content.res.Configuration;
import android.webkit.WebView;
import android.view.ViewGroup;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private LaunchAnimation launchAnimation;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 先按已保存主题设置夜间模式，窗口背景和启动画面随之取 values / values-night。
        AppPreferencesPlugin.applyStoredTheme(this);
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        launchAnimation = new LaunchAnimation();
        if (savedInstanceState != null) launchAnimation.stop();
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
        super.onCreate(savedInstanceState);
        launchAnimation.prepare((ViewGroup) getWindow().getDecorView());
    }

    /** 由首屏就绪插件调用；WebView 确认可绘制后再让开屏淡出，避免露出尚未渲染的背景。 */
    void onStartupContentReady() {
        if (getBridge() == null) return;
        getBridge().getWebView().postVisualStateCallback(0, new WebView.VisualStateCallback() {
            @Override public void onComplete(long requestId) {
                if (launchAnimation != null) launchAnimation.contentReady();
            }
        });
    }

    @Override public void onStop() {
        if (launchAnimation != null) launchAnimation.stop();
        super.onStop();
    }

    @Override public void onDestroy() {
        if (launchAnimation != null) launchAnimation.stop();
        super.onDestroy();
    }

    /**
     * Capacitor 保留 Activity 处理 uiMode；部分 WebView 不刷新媒体查询，
     * 因此由实际原生配置通知页面主题。事件仅含布尔值，不暴露平台文件接口。
     */
    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (getBridge() != null) {
            boolean dark = (configuration.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
            getBridge().triggerWindowJSEvent("savedata:theme-change", "{\"dark\":" + dark + "}");
        }
    }
}
