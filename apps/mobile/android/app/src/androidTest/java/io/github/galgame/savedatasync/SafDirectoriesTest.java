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
 * Device tests. Default run uses private fixtures only. Interactive modes select/read/cancel
 * require a human using the real system picker; they never use root or synthetic grant injection.
 * All source access is read-only. Reports contain counts, never source paths, names or hashes.
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

    @Test public void providerNullsEmptyFilesAndDirectoriesRemainDistinct() throws Exception {
        String[] columns = { Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS };
        try (MatrixCursor cursor = new MatrixCursor(columns)) {
            cursor.addRow(new Object[] { "unknown", "未知", "application/octet-stream", null, 0L, null });
            cursor.addRow(new Object[] { "empty", "空文件", "application/octet-stream", 0L, 1L, 0L });
            cursor.addRow(new Object[] { "dir", "子目录", Document.MIME_TYPE_DIR, Long.MAX_VALUE, null, 0L });
            cursor.moveToFirst();
            JSONObject unknown = SafDirectoryStore.metadata("root-1", "entry-1", null, SafDirectoryStore.decode(cursor));
            assertTrue(unknown.isNull("sizeBytes"));
            assertTrue(unknown.isNull("modifiedAt"));
            assertTrue(unknown.isNull("parentId"));
            assertEquals("unknown", unknown.getJSONObject("capabilities").getString("canRead"));
            cursor.moveToNext();
            JSONObject empty = SafDirectoryStore.metadata("root-1", "entry-2", null, SafDirectoryStore.decode(cursor));
            assertEquals(0, empty.getLong("sizeBytes"));
            assertEquals(1, empty.getLong("modifiedAt"));
            cursor.moveToNext();
            JSONObject directory = SafDirectoryStore.metadata("root-1", "entry-3", null, SafDirectoryStore.decode(cursor));
            assertEquals("directory", directory.getString("kind"));
            assertTrue(directory.isNull("sizeBytes"));
        }
    }

    @Test public void nativeBridgeRejectsExtraFieldsAndRawUris() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            awaitBridge(scenario);
            for (String method : new String[] { "chooseDirectory", "listRoots", "listDirectory" }) {
                JSONObject result = invoke(scenario, method, "{\"path\":\"content://invalid.test/tree/root\"}", 10000);
                assertEquals("invalid-request", result.getJSONObject("error").getString("code"));
            }
            JSONObject result = invoke(scenario, "listDirectory", "{\"rootId\":\"../outside\",\"parentId\":null}", 10000);
            assertEquals("invalid-request", result.getJSONObject("error").getString("code"));
        }
    }

    @Test public void malformedProviderNumbersNeverBecomeZero() {
        String[] columns = { Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED };
        try (MatrixCursor cursor = new MatrixCursor(columns)) {
            cursor.addRow(new Object[] { "id-1", "fixture", "application/octet-stream", "not-a-number", 1L });
            cursor.addRow(new Object[] { "id-2", "fixture", "application/octet-stream", Long.MAX_VALUE, 1L });
            cursor.moveToFirst();
            assertThrows(IllegalArgumentException.class, () -> SafDirectoryStore.decode(cursor));
            cursor.moveToNext();
            assertThrows(IllegalArgumentException.class, () -> SafDirectoryStore.decode(cursor));
        }
    }

    @Test public void malformedRegistryFailsWithoutResettingIt() throws Exception {
        String name = "saf-fixture-" + UUID.randomUUID();
        SharedPreferences settings = context().getSharedPreferences(name, Context.MODE_PRIVATE);
        try {
            assertTrue(settings.edit().putString("registry", "{broken").commit());
            SafFailure failure = assertThrows(SafFailure.class, () -> new SafDirectoryStore(context(), name));
            assertEquals("io-failure", failure.code);
            assertEquals("{broken", settings.getString("registry", null));
        } finally {
            context().deleteSharedPreferences(name);
        }
    }

    @Test public void missingGrantIsExpiredRatherThanAnEmptyDirectory() throws Exception {
        String name = "saf-fixture-" + UUID.randomUUID();
        SharedPreferences settings = context().getSharedPreferences(name, Context.MODE_PRIVATE);
        try {
            String registry = "{\"schemaVersion\":1,\"deviceId\":\"device-fixture\",\"roots\":[" +
                "{\"rootId\":\"root-fixture\",\"treeUri\":\"content://invalid.test/tree/root\",\"displayName\":\"fixture\"}]}";
            assertTrue(settings.edit().putString("registry", registry).commit());
            SafDirectoryStore store = new SafDirectoryStore(context(), name);
            assertEquals("expired", store.listRoots(new CancellationSignal()).getJSONObject(0).getString("authorization"));
            SafFailure failure = assertThrows(SafFailure.class,
                () -> store.listDirectory("root-fixture", null, new CancellationSignal()));
            assertEquals("authorization-expired", failure.code);
        } finally {
            context().deleteSharedPreferences(name);
        }
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

    @Test public void processRestartRestoresTheReadGrantAndIdentity() throws Exception {
        assumeTrue(mode("restore"));
        SharedPreferences evidence = context().getSharedPreferences(EVIDENCE, Context.MODE_PRIVATE);
        String rootId = evidence.getString("rootId", null);
        assertNotNull("Run selection mode before restarting the process", rootId);
        SafDirectoryStore store = new SafDirectoryStore(context());
        JSONArray roots = store.listRoots(new CancellationSignal());
        boolean found = false;
        for (int index = 0; index < roots.length(); index++) {
            JSONObject root = roots.getJSONObject(index);
            if (!rootId.equals(root.getString("rootId"))) continue;
            found = true;
            assertEquals("granted", root.getString("authorization"));
            assertTrue("Device identity changed", evidence.getString("deviceId", "").equals(root.getString("deviceId")));
        }
        assertTrue("Saved root was lost", found);
        verifyReadOnly(rootId);
    }

    @Test public void pickerCancellationPreservesRoots() throws Exception {
        assumeTrue(mode("cancel"));
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            awaitBridge(scenario);
            String before = invoke(scenario, "listRoots", "{}", 10000).toString();
            assertEquals("cancelled", invoke(scenario, "chooseDirectory", "{}", 120000).getString("status"));
            assertTrue("Cancelling changed saved references", before.equals(invoke(scenario, "listRoots", "{}", 10000).toString()));
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
        // A new native instance has no old entry table; it requires fresh enumeration.
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
