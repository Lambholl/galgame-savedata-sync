package io.github.galgame.savedatasync;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SafDirectoriesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
