package io.github.galgame.savedatasync;

import static org.junit.Assert.*;

import android.graphics.Bitmap;
import android.content.res.Configuration;
import android.graphics.drawable.ColorDrawable;
import androidx.appcompat.app.AppCompatDelegate;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;

/** 验证 WebView 主题和原生系统栏共同切换；只改当前应用日夜模式，结束时恢复。 */
public class ThemeTest {
    @Test public void pageAndSystemBarsFollowApplicationNightModeInBothDirections() throws Exception {
        int original = AppCompatDelegate.getDefaultNightMode();
        setMode(AppCompatDelegate.MODE_NIGHT_YES);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            awaitTheme(scenario, true);
            screenshot("theme-dark.png");
            setMode(AppCompatDelegate.MODE_NIGHT_NO);
            awaitTheme(scenario, false);
            screenshot("theme-light.png");
            setMode(AppCompatDelegate.MODE_NIGHT_YES);
            awaitTheme(scenario, true);
        } finally {
            // 未指定的默认值等价于跟随系统；setter 不接受 MODE_NIGHT_UNSPECIFIED。
            int restored = original == AppCompatDelegate.MODE_NIGHT_UNSPECIFIED ? AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM : original;
            setMode(restored);
            assertEquals(restored, AppCompatDelegate.getDefaultNightMode());
        }
    }

    private void setMode(int mode) {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> AppCompatDelegate.setDefaultNightMode(mode));
    }

    private void awaitTheme(ActivityScenario<MainActivity> scenario, boolean dark) throws Exception {
        long deadline = System.currentTimeMillis() + 20000;
        JSONObject last = null;
        while (System.currentTimeMillis() < deadline) {
            CountDownLatch latch = new CountDownLatch(1);
            AtomicReference<String> result = new AtomicReference<>();
            AtomicReference<Boolean> lightStatus = new AtomicReference<>();
            AtomicReference<Boolean> lightNavigation = new AtomicReference<>();
            AtomicReference<Integer> nativeBackground = new AtomicReference<>();
            AtomicReference<Integer> nativeMode = new AtomicReference<>();
            scenario.onActivity(activity -> {
                nativeMode.set(activity.getResources().getConfiguration().uiMode);
                WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(activity.getWindow(), activity.getWindow().getDecorView());
                lightStatus.set(bars.isAppearanceLightStatusBars());
                lightNavigation.set(bars.isAppearanceLightNavigationBars());
                if (activity.getWindow().getDecorView().getBackground() instanceof ColorDrawable) {
                    nativeBackground.set(((ColorDrawable) activity.getWindow().getDecorView().getBackground()).getColor());
                }
                activity.getBridge().getWebView().evaluateJavascript("JSON.stringify((() => {" +
                    "const empty=document.querySelector('.empty-description');if(!empty)return null;" +
                    "return {dark:matchMedia('(prefers-color-scheme:dark)').matches," +
                    "theme:document.documentElement.dataset.prefersColorScheme," +
                    "colorScheme:getComputedStyle(document.documentElement).colorScheme," +
                    "background:getComputedStyle(document.body).backgroundColor," +
                    "text:getComputedStyle(document.body).color," +
                    "description:getComputedStyle(empty).color}})())", value -> {
                    result.set(value); latch.countDown();
                });
            });
            assertTrue("WebView did not respond", latch.await(10, TimeUnit.SECONDS));
            Object decoded = new JSONTokener(result.get()).nextValue();
            if (decoded instanceof String && !"null".equals(decoded)) {
                last = new JSONObject((String) decoded);
                last.put("nativeMode", nativeMode.get());
                last.put("lightStatus", lightStatus.get()); last.put("lightNavigation", lightNavigation.get());
                last.put("nativeBackground", nativeBackground.get() == null ? JSONObject.NULL : nativeBackground.get());
                int expectedBackground = dark ? 0xff000000 : 0xffffffff;
                boolean nativeDark = (nativeMode.get() & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
                if (nativeDark == dark && last.optString("theme").equals(dark ? "dark" : "light") &&
                    last.optString("colorScheme").equals(dark ? "dark" : "light") &&
                    last.optString("background").equals(dark ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)") &&
                    Boolean.valueOf(!dark).equals(lightStatus.get()) && Boolean.valueOf(!dark).equals(lightNavigation.get()) &&
                    Integer.valueOf(expectedBackground).equals(nativeBackground.get())) {
                    assertEquals(dark ? "rgb(230, 230, 230)" : "rgb(51, 51, 51)", last.getString("text"));
                    assertEquals(dark ? "rgb(179, 179, 179)" : "rgb(102, 102, 102)", last.getString("description"));
                    return;
                }
            }
            Thread.sleep(100);
        }
        fail("Theme or native bars failed to update: " + last);
    }

    private void screenshot(String name) throws Exception {
        Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull(bitmap);
        File file = new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(), name);
        try (FileOutputStream output = new FileOutputStream(file)) {
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output));
        } finally { bitmap.recycle(); }
    }
}
