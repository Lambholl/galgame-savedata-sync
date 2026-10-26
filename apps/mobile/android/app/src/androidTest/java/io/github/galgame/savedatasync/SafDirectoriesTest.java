package io.github.galgame.savedatasync;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

import android.app.Instrumentation;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.MatrixCursor;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.provider.DocumentsContract.Document;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * 真机测试默认仅使用私有夹具；select/read/cancel 交互模式要求人工操作真实系统选择器，
 * 不使用 root 或伪造授权注入。
 * 所有源访问均为只读；报告仅含计数，不包含源路径、名称或哈希。
 */
@RunWith(AndroidJUnit4.class)
public class SafDirectoriesTest {
    private static final String EVIDENCE = "saf-test-read-evidence";

    private Context context() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    private boolean mode(String expected) {
        return expected.equals(InstrumentationRegistry.getArguments().getString("safMode"));
    }











    @Test public void pickerSelectionAndNativeRead() throws Exception {
        assumeTrue(mode("select"));
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            awaitBridge(scenario);
            JSONObject selected = invoke(scenario, "chooseDirectory", "{}", 240000);
            assertEquals("System picker must return selected", "selected", selected.getString("status"));
            JSONObject directory = selected.getJSONObject("directory");
            assertEquals("granted", directory.getString("authorization"));
            assertFalse(directory.has("treeUri"));
            String expectedName = InstrumentationRegistry.getArguments().getString("safExpectedName");
            assertTrue("The selected directory must match the requested test source",
                expectedName == null || expectedName.equals(directory.getString("displayName")));
            SharedPreferences evidence = context().getSharedPreferences(EVIDENCE, Context.MODE_PRIVATE);
            assertTrue(evidence.edit().putString("rootId", directory.getString("rootId"))
                .putString("deviceId", directory.getString("deviceId")).commit());
            assertEquals("success", invoke(scenario, "listRoots", "{}", 10000).getString("status"));
            JSONObject request = new JSONObject();
            request.put("rootId", directory.getString("rootId"));
            request.put("parentId", JSONObject.NULL);
            JSONObject listing = invoke(scenario, "listDirectory", request.toString(), 15000);
            assertEquals("success", listing.getString("status"));
            verifyReadOnly(directory.getString("rootId"));
        }
    }





    private void verifyReadOnly(String rootId) throws Exception {
        SafDirectoryStore store = new SafDirectoryStore(context());
        JSONObject before = store.listDirectory(rootId, null, new CancellationSignal());
        JSONArray entries = before.getJSONArray("entries");
        Map<String, byte[]> hashes = new HashMap<>();
        int files = 0;
        for (int index = 0; index < entries.length(); index++) {
            JSONObject entry = entries.getJSONObject(index);
            JSONObject capabilities = entry.getJSONObject("capabilities");
            assertEquals("unsupported", capabilities.getString("canCreate"));
            assertEquals("unsupported", capabilities.getString("canRename"));
            assertEquals("unsupported", capabilities.getString("canDelete"));
            if ("directory".equals(entry.getString("kind"))) {
                assertTrue(entry.isNull("sizeBytes"));
                continue;
            }
            if (!"supported".equals(capabilities.getString("canRead"))) continue;
            hashes.put(entry.getString("entryId"), digest(store, rootId, entry.getString("entryId")));
            files++;
        }
        for (Map.Entry<String, byte[]> item : hashes.entrySet()) {
            assertTrue("File content changed during read-only validation",
                MessageDigest.isEqual(item.getValue(), digest(store, rootId, item.getKey())));
        }
        JSONObject after = store.listDirectory(rootId, null, new CancellationSignal());
        assertTrue("Directory metadata changed during read-only validation",
            entries.toString().equals(after.getJSONArray("entries").toString()));
        SafFailure invalid = assertThrows(SafFailure.class,
            () -> store.openFile(rootId, "unknown-entry", new CancellationSignal()));
        assertEquals("not-found", invalid.code);
        // 新原生实例不保留旧条目表，必须重新枚举。
        if (entries.length() > 0) {
            SafDirectoryStore restored = new SafDirectoryStore(context());
            SafFailure stale = assertThrows(SafFailure.class,
                () -> restored.openFile(rootId, entries.getJSONObject(0).getString("entryId"), new CancellationSignal()));
            assertEquals("not-found", stale.code);
        }
        Bundle report = new Bundle();
        report.putString("stream", "SAF read-only validation: entries=" + entries.length() + ", files=" + files);
        InstrumentationRegistry.getInstrumentation().sendStatus(0, report);
    }

    private byte[] digest(SafDirectoryStore store, String rootId, String entryId) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[32768];
        try (InputStream stream = store.openFile(rootId, entryId, new CancellationSignal())) {
            int count;
            while ((count = stream.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        return digest.digest();
    }

    private void awaitBridge(ActivityScenario<MainActivity> scenario) throws Exception {
        long deadline = System.currentTimeMillis() + 20000;
        while (System.currentTimeMillis() < deadline) {
            Object ready = evaluate(scenario, "Boolean(window.Capacitor && window.Capacitor.nativePromise)");
            if (Boolean.TRUE.equals(ready)) return;
            Thread.sleep(150);
        }
        fail("Capacitor bridge did not become ready");
    }

    private JSONObject invoke(ActivityScenario<MainActivity> scenario, String method, String arguments, long timeout) throws Exception {
        evaluate(scenario, "window.__safResult = null; window.Capacitor.nativePromise('SafDirectories', '" + method + "', " + arguments + ")" +
            ".then(value => { window.__safResult = value; }).catch(() => { window.__safResult = {status:'bridge-error'}; }); true");
        long deadline = System.currentTimeMillis() + timeout;
        while (System.currentTimeMillis() < deadline) {
            Object value = evaluate(scenario, "JSON.stringify(window.__safResult)");
            if (value instanceof String && !"null".equals(value)) return new JSONObject((String) value);
            Thread.sleep(200);
        }
        throw new AssertionError("Native bridge timed out; complete the system picker on the device");
    }

    private Object evaluate(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(script, value -> {
            result.set(value);
            latch.countDown();
        }));
        assertTrue("WebView evaluation timed out", latch.await(10, TimeUnit.SECONDS));
        return new JSONTokener(result.get()).nextValue();
    }
}
