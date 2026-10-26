package io.github.galgame.savedatasync;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;
import static io.github.galgame.savedatasync.PublicationModel.*;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.CancellationSignal;
import android.provider.DocumentsContract;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * 真实系统 WRITE 选择器和外部存储提供者集成，仅接受本轮新建的精确合成夹具。
 * 默认不运行交互用例；显式传 publicationToken 时，未授权/未验证必须失败而非跳过。
 * 原生结果与 SAF 实际内容均保存到私有报告，供主机独立比对。
 */
@RunWith(AndroidJUnit4.class)
public class SafPublicationTest {
    private Context context() { return InstrumentationRegistry.getInstrumentation().getTargetContext(); }
    private static String hash(byte[] bytes) { return NewFilePublisher.hex(ArchiveFormat.sha256().digest(bytes)); }
    private String token() {
        String value = InstrumentationRegistry.getArguments().getString("publicationToken");
        assumeTrue(value != null);
        assertTrue(value.matches("[a-f0-9]{16}")); return value;
    }
    @Test public void selectExactIsolatedPublicationFixture() throws Exception {
        String token = token();
        SharedPreferences preferences = context().getSharedPreferences(PublicationGrantActivity.SETTINGS, Context.MODE_PRIVATE);
        // 旧 READ 回执不能冒充本轮 WRITE 选择完成；必须在启动 Activity 前清除。
        assertTrue(preferences.edit().clear().commit());
        try (ActivityScenario<MainActivity> main = ActivityScenario.launch(MainActivity.class)) {
            main.onActivity(activity -> activity.startActivity(new Intent(activity, PublicationGrantActivity.class).putExtra("token", token)));
            long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.MINUTES.toNanos(4);
            while (preferences.getString("uri", null) == null && !preferences.getBoolean("failed", false) && System.nanoTime() < deadline) {
                Thread.sleep(200);
            }
            assertFalse("系统选择器取消或选择了其他目录", preferences.getBoolean("failed", false));
            String uri = preferences.getString("uri", null); assertNotNull("必须通过真实系统选择器授权", uri);
            assertEquals("primary:Download/SaveDataSync-Publish-" + token, DocumentsContract.getTreeDocumentId(Uri.parse(uri)));
        }
    }

    private JSONObject find(SafDirectoryStore store, String rootId, String parentId, String name) throws Exception {
        JSONArray entries = store.listDirectory(rootId, parentId, new CancellationSignal()).getJSONArray("entries");
        for (int i = 0; i < entries.length(); i++) if (name.equals(entries.getJSONObject(i).getString("name"))) return entries.getJSONObject(i);
        return null;
    }
    private String readHash(SafDirectoryStore store, String rootId, JSONObject entry) throws Exception {
        java.security.MessageDigest digest = ArchiveFormat.sha256();
        try (InputStream input = store.openFile(rootId, entry.getString("entryId"), new CancellationSignal())) {
            byte[] buffer = new byte[65536]; int n; while ((n = input.read(buffer)) != -1) digest.update(buffer, 0, n);
        }
        return NewFilePublisher.hex(digest.digest());
    }
    private Result publish(NewFilePublisher publisher, String root, String parent, String name, byte[] bytes,
                           ArchiveModel.Progress progress) throws Exception {
        return publisher.publish(new Request("f000001", root, parent, name, bytes.length, hash(bytes)),
            () -> new ByteArrayInputStream(bytes), progress, new ArchiveControl());
    }
    /** 在实际提供者操作前插入受控竞争；其余 IO 完整走正式后端。 */
    private static class Forward implements NewFilePublisher.Backend {
        final NewFilePublisher.Backend delegate;
        Forward(NewFilePublisher.Backend delegate) { this.delegate = delegate; }
        @Override public NewFilePublisher.Directory locate(String root, String parent, ArchiveControl c) throws Exception { return delegate.locate(root, parent, c); }
        @Override public List<Document> children(NewFilePublisher.Directory d, ArchiveControl c) throws Exception { return delegate.children(d, c); }
        @Override public String create(NewFilePublisher.Directory d, String name) throws Exception { return delegate.create(d, name); }
        @Override public NewFilePublisher.Owned claim(NewFilePublisher.Directory d, Document document) throws Exception { return delegate.claim(d, document); }
    }
    private static class OwnedForward implements NewFilePublisher.Owned {
        final NewFilePublisher.Owned delegate;
        OwnedForward(NewFilePublisher.Owned delegate) { this.delegate = delegate; }
        @Override public OutputStream openOutput(long size, ArchiveControl c) throws Exception { return delegate.openOutput(size, c); }
        @Override public InputStream openRead(ArchiveControl c) throws Exception { return delegate.openRead(c); }
        @Override public void verify(ArchiveControl c) throws Exception { delegate.verify(c); }
        @Override public Entry entry(ArchiveControl c) throws Exception { return delegate.entry(c); }
        @Override public void delete() throws Exception { delegate.delete(); }
        @Override public void close() throws java.io.IOException { delegate.close(); }
    }
    @Test public void actualSafPublicationPermissionCollisionCancellationAndArchiveIntegration() throws Exception {
        String token = token(); Context context = context();
        SharedPreferences preferences = context.getSharedPreferences(PublicationGrantActivity.SETTINGS, Context.MODE_PRIVATE);
        Uri uri = Uri.parse(preferences.getString("uri", ""));
        assertEquals("com.android.externalstorage.documents", uri.getAuthority());
        assertEquals("primary:Download/SaveDataSync-Publish-" + token, DocumentsContract.getTreeDocumentId(uri));
        String settings = "publication-fixture-" + UUID.randomUUID();
        SafDirectoryStore store = new SafDirectoryStore(context, settings);
        String root = store.register(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
            new CancellationSignal()).getString("rootId");
        SafPublicationBackend backend = new SafPublicationBackend(context, store);
        List<NewFilePublisher> publishers = new ArrayList<>();
        NewFilePublisher publisher = new NewFilePublisher(backend); publishers.add(publisher);
        JSONArray reports = new JSONArray();
        String prefix = "r-" + UUID.randomUUID().toString().substring(0, 8) + "-";
        try {
            JSONObject control = find(store, root, null, "control.sav"); assertNotNull(control);
            JSONObject original = new JSONObject(control.toString()); String controlHash = readHash(store, root, control);
            JSONObject subdirectory = find(store, root, null, "existing-parent"); assertNotNull(subdirectory);
            String parent = subdirectory.getString("entryId");
            assertEquals("permission-denied", assertThrows(ArchiveFailure.class,
                () -> publish(publisher, root, null, "unauthorized.sav", new byte[0], null)).code);
            assertNull(find(store, root, null, "unauthorized.sav"));
            publisher.grant(root);
            publisher.preflight(new Request("f000001", root, null, prefix + "preflight.sav", 0, hash(new byte[0])), new ArchiveControl());
            assertNull(find(store, root, null, prefix + "preflight.sav"));
            for (int size : new int[] {0, 4, 131073}) {
                byte[] bytes = new byte[size]; for (int i = 0; i < size; i++) bytes[i] = (byte) (i * 31 + 7);
                String name = prefix + (size == 4 ? "存档 😀.sav" : "size-" + size + ".sav");
                Result result = publish(publisher, root, size == 4 ? parent : null, name, bytes, null);
                reports.put(PublicationJson.result(result)); assertEquals(PublicationJson.result(result).toString(), "succeeded", result.status);
                assertEquals("complete", result.cleanup);
                JSONObject actual = find(store, root, size == 4 ? parent : null, name); assertNotNull(actual);
                assertEquals(size, actual.getLong("sizeBytes")); assertEquals(hash(bytes), readHash(store, root, actual));
            }
            Result collision = publish(publisher, root, null, "control.sav", new byte[] {99}, null);
            reports.put(PublicationJson.result(collision)); assertEquals("name-conflict", collision.errorCode);
            for (String phase : new String[] {"writing", "verifying"}) {
                String name = prefix + "cancel-" + phase + ".sav";
                Result result = publish(publisher, root, null, name, new byte[131073],
                    (stage, count, total) -> { if (phase.equals(stage)) publisher.cancel(); });
                reports.put(PublicationJson.result(result)); assertEquals("cancelled", result.status); assertEquals("complete", result.cleanup);
                assertNull(find(store, root, null, name));
            }
            Result checksum = publisher.publish(new Request("f000001", root, null, prefix + "bad-source.sav", 4, hash(new byte[4])),
                () -> new ByteArrayInputStream(new byte[] {1,2,3,4}), null, new ArchiveControl());
            reports.put(PublicationJson.result(checksum)); assertEquals("checksum-mismatch", checksum.errorCode);
            assertEquals("complete", checksum.cleanup); assertNull(find(store, root, null, prefix + "bad-source.sav"));

            NewFilePublisher renamed = new NewFilePublisher(new Forward(backend) {
                @Override public String create(NewFilePublisher.Directory d, String name) throws Exception {
                    // 竞争者先占名，正式 createDocument 必须处理提供者实际自动改名。
                    String competitor = delegate.create(d, name);
                    Uri target = DocumentsContract.buildDocumentUriUsingTree(uri, competitor);
                    try (OutputStream output = context.getContentResolver().openOutputStream(target, "w")) { assertNotNull(output); output.write(new byte[] {77}); }
                    return delegate.create(d, name);
                }
            });
            publishers.add(renamed); renamed.grant(root);
            Result race = publish(renamed, root, null, prefix + "race.sav", new byte[] {42}, null);
            reports.put(PublicationJson.result(race)); assertEquals("name-conflict", race.errorCode); assertEquals("complete", race.cleanup);
            assertEquals(hash(new byte[] {77}), readHash(store, root, find(store, root, null, prefix + "race.sav")));

            NewFilePublisher existing = new NewFilePublisher(new Forward(backend) {
                @Override public String create(NewFilePublisher.Directory d, String name) throws Exception {
                    for (Document doc : delegate.children(d, new ArchiveControl())) if (doc.name.equals("control.sav")) return doc.id;
                    throw new AssertionError("控制文件必须存在");
                }
            });
            publishers.add(existing); existing.grant(root);
            Result existingResult = publish(existing, root, null, prefix + "existing-id.sav", new byte[0], null);
            reports.put(PublicationJson.result(existingResult)); assertEquals("unknown", existingResult.status);
            assertEquals("unknown", existingResult.cleanup); assertNull(find(store, root, null, prefix + "existing-id.sav"));
            assertEquals(controlHash, readHash(store, root, find(store, root, null, "control.sav")));

            java.util.concurrent.atomic.AtomicReference<NewFilePublisher> cancelling = new java.util.concurrent.atomic.AtomicReference<>();
            NewFilePublisher cancelCreate = new NewFilePublisher(new Forward(backend) {
                @Override public String create(NewFilePublisher.Directory d, String name) throws Exception {
                    String id = delegate.create(d, name); cancelling.get().cancel(); return id;
                }
            });
            cancelling.set(cancelCreate); publishers.add(cancelCreate); cancelCreate.grant(root);
            Result createCancelled = publish(cancelCreate, root, null, prefix + "cancel-create.sav", new byte[0], null);
            reports.put(PublicationJson.result(createCancelled)); assertEquals("cancelled", createCancelled.status);
            assertEquals("complete", createCancelled.cleanup); assertNull(find(store, root, null, prefix + "cancel-create.sav"));

            java.util.concurrent.atomic.AtomicBoolean cleanupFault = new java.util.concurrent.atomic.AtomicBoolean(true);
            NewFilePublisher failingCleanup = new NewFilePublisher(new Forward(backend) {
                @Override public NewFilePublisher.Owned claim(NewFilePublisher.Directory d, Document document) throws Exception {
                    return new OwnedForward(delegate.claim(d, document)) {
                        @Override public void delete() throws Exception {
                            if (cleanupFault.get()) throw new java.io.IOException("注入删除失败");
                            super.delete();
                        }
                    };
                }
            });
            publishers.add(failingCleanup); failingCleanup.grant(root);
            try {
                Result failed = failingCleanup.publish(new Request("f000001", root, null, prefix + "cleanup-failed.sav", 4, hash(new byte[4])),
                    () -> new ByteArrayInputStream(new byte[] {1,2,3,4}), null, new ArchiveControl());
                reports.put(PublicationJson.result(failed)); assertEquals("failed", failed.status);
                assertEquals("incomplete", failed.cleanup); assertEquals(1, failed.residualEntries.size());
                assertEquals("busy", assertThrows(ArchiveFailure.class,
                    () -> publish(publisher, root, null, prefix + "busy.sav", new byte[0], null)).code);
                assertFalse(failingCleanup.retryCleanup());
            } finally { cleanupFault.set(false); assertTrue(failingCleanup.retryCleanup()); }
            assertNull(find(store, root, null, prefix + "cleanup-failed.sav"));

            // 归档句柄保持活动，发布器消费私有原文流；两个模块使用独立进程名额。
            ArchiveAdapter archives = SafArchiveSource.createAdapter(context);
            List<ArchiveModel.Source> sources = new ArrayList<>(); sources.add(new SafArchiveSource(store, root, control.getString("entryId")));
            try (ArchiveAdapter.Artifact artifact = archives.prepare("publication-interop", "fixture-device", root, sources, new ArchiveControl(), null)) {
                ArchiveModel.PreparedFile file = artifact.manifest.files.get(0);
                Result result = publisher.publish(new Request(file.fileId, root, parent, prefix + "archive-copy.sav", file.sizeBytes, file.sha256),
                    () -> artifact.openFile(file.fileId), null, new ArchiveControl());
                reports.put(PublicationJson.result(result)); assertEquals("succeeded", result.status); assertEquals("complete", result.cleanup);
                assertEquals(controlHash, readHash(store, root, find(store, root, parent, prefix + "archive-copy.sav")));
            }
            archives.retryCleanup();
            JSONObject finalControl = find(store, root, null, "control.sav");
            assertEquals(original.getString("entryId"), finalControl.getString("entryId"));
            assertEquals(original.getLong("sizeBytes"), finalControl.getLong("sizeBytes"));
            assertEquals(original.get("modifiedAt"), finalControl.get("modifiedAt"));
            assertEquals(controlHash, readHash(store, root, finalControl));

            publisher.revoke(root);
            assertEquals("permission-denied", assertThrows(ArchiveFailure.class,
                () -> publish(publisher, root, null, "revoked.sav", new byte[0], null)).code);
            // 只释放本轮独立夹具的 WRITE，不改变既有读取根或用户授权。
            context.getContentResolver().releasePersistableUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            SafFailure permission = assertThrows(SafFailure.class, () -> publisher.grant(root));
            assertEquals("permission-denied", permission.code);
            assertNotNull(find(store, root, null, "control.sav"));
            JSONObject report = new JSONObject(); report.put("cases", reports); report.put("prefix", prefix);
            report.put("controlUnchanged", true); report.put("writeGrantReleased", true);
            Files.write(context.getCacheDir().toPath().resolve("publication-device-results.json"), report.toString(2).getBytes(StandardCharsets.UTF_8));
        } finally {
            for (NewFilePublisher item : publishers) assertTrue("发布句柄必须完成清理", item.stop());
            context.getContentResolver().releasePersistableUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            context.deleteSharedPreferences(settings);
        }
    }
}
