package com.getcapacitor.myapp;

import static org.junit.Assert.*;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * 在 Android 设备上执行的仪器测试。
 *
 * @see <a href="http://d.android.com/tools/testing">测试文档</a>
 */
@RunWith(AndroidJUnit4.class)
public class ExampleInstrumentedTest {

    @Test
    public void useAppContext() throws Exception {
        // 被测应用的上下文。
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();

        assertEquals("io.github.galgame.savedatasync", appContext.getPackageName());
    }
}
