package io.github.galgame.savedatasync;

import android.os.Bundle;
import android.content.res.Configuration;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SafDirectoriesPlugin.class);
        registerPlugin(HttpTransfersPlugin.class);
        super.onCreate(savedInstanceState);
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
