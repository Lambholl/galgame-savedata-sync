package io.github.galgame.savedatasync;

import static org.junit.Assert.*;

import android.content.Context;
import android.os.Bundle;
import android.os.CancellationSignal;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * WP-013 实际设备验收；必须显式传入已通过系统选择器 READ 授权的合成目录显示名。
 * 没有目录或授权时失败而非跳过。源仅原生读取；所有写入在应用私有缓存中。
 * 固定格式/Windows 互通测试无需交互，SAF 测试需要先执行既有选择器用例。
 */
@RunWith(AndroidJUnit4.class)
public class ArchiveSafTest {
    private Context context() { return InstrumentationRegistry.getInstrumentation().getTargetContext(); }
    private Context tests() { return InstrumentationRegistry.getInstrumentation().getContext(); }

    private static byte[] smallBytes(InputStream input) throws Exception {
        try (InputStream stream = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[65536]; int n;
            while ((n = stream.read(buffer)) != -1) {
                assertTrue("Only small format fixtures may be collected", out.size() + n < 16384);
                out.write(buffer, 0, n);
            }
            return out.toByteArray();
        }
    }
    private String digest(InputStream input) throws Exception {
        MessageDigest hash = ArchiveFormat.sha256(); byte[] buffer = new byte[65536];
        try (InputStream stream = input) { int n; while ((n = stream.read(buffer)) != -1) hash.update(buffer, 0, n); }
        return ArchiveFormat.hex(hash.digest());
    }
    private ArchiveModel.Manifest fixedManifest(JSONObject json) throws Exception {
        List<ArchiveModel.PreparedFile> files = new ArrayList<>(); JSONArray records = json.getJSONArray("files");
        for (int i = 0; i < records.length(); i++) {
            JSONObject f = records.getJSONObject(i);
            files.add(new ArchiveModel.PreparedFile(f.getString("fileId"), new ArchiveModel.Observation("fixture-" + i,
                f.getString("sourceEntryId"), f.isNull("sourceParentId") ? null : f.getString("sourceParentId"),
                f.getString("sourceName"), null, f.isNull("sourceModifiedAt") ? null : f.getLong("sourceModifiedAt")),
                f.getLong("sizeBytes"), f.getString("sha256")));
        }
        JSONObject archive = json.getJSONObject("archive");
        return new ArchiveModel.Manifest(json.getString("transferId"), json.getString("sourceDeviceId"),
            json.getString("sourceRootId"), files, json.getLong("totalFileBytes"),
            new ArchiveModel.Descriptor(archive.getLong("sizeBytes"), archive.getLong("tarSizeBytes"), archive.getString("sha256")));
    }
    private JSONObject fixture() throws Exception {
        return new JSONObject(new String(smallBytes(tests().getAssets().open("archive-v1.json")), StandardCharsets.UTF_8));
    }

    @Test public void androidConsumesPythonAndWindowsNativeArchivesAndExportsJavaArchive() throws Exception {
        JSONObject fixture = fixture(); ArchiveAdapter adapter = SafArchiveSource.createAdapter(context());
        byte[][] contents = new byte[3][];
        for (int i = 0; i < 3; i++) contents[i] = Base64.getDecoder().decode(fixture.getJSONArray("contentsBase64").getString(i));
        ArchiveModel.Manifest python = fixedManifest(fixture.getJSONObject("manifest"));
        try (ArchiveAdapter.Artifact artifact = adapter.receive(python,
            new ByteArrayInputStream(Base64.getDecoder().decode(fixture.getString("archiveBase64"))), new ArchiveControl(), null)) {
            for (int i = 0; i < 3; i++) assertArrayEquals(contents[i], smallBytes(artifact.openFile(ArchiveModel.id(i))));
        }
        JSONObject windows = new JSONObject(new String(smallBytes(tests().getAssets().open("windows-manifest.json")), StandardCharsets.UTF_8));
        try (ArchiveAdapter.Artifact artifact = adapter.receive(fixedManifest(windows), tests().getAssets().open("windows-archive.bin"), new ArchiveControl(), null)) {
            for (int i = 0; i < 3; i++) assertArrayEquals(contents[i], smallBytes(artifact.openFile(ArchiveModel.id(i))));
        }
        JSONObject largeManifest = new JSONObject(new String(smallBytes(tests().getAssets().open("windows-large.json")), StandardCharsets.UTF_8));
        byte[] large = new byte[131073];
        for (int i = 0; i < large.length; i++) large[i] = (byte) (i * 31 + 7);
        try (ArchiveAdapter.Artifact artifact = adapter.receive(fixedManifest(largeManifest), tests().getAssets().open("windows-large.bin"), new ArchiveControl(), null)) {
            assertEquals(ArchiveFormat.hex(ArchiveFormat.sha256().digest(large)), digest(artifact.openFile("f000001")));
        }
        List<ArchiveModel.Source> sources = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            final int index = i;
            sources.add(new ArchiveModel.Source() {
                @Override public ArchiveModel.Observation observe(ArchiveControl control) {
                    return new ArchiveModel.Observation("fixture-" + index, "fixture-" + (index + 1), null, "固定夹具", null, null);
                }
                @Override public InputStream open(ArchiveControl control) { return new ByteArrayInputStream(contents[index]); }
            });
        }
        try (ArchiveAdapter.Artifact artifact = adapter.prepare("device-interop", "device-fixture", "root-fixture", sources, new ArchiveControl(), null)) {
            byte[] bytes = smallBytes(artifact.openArchive());
            assertArrayEquals(Base64.getDecoder().decode(fixture.getString("tarBase64")),
                smallBytes(new java.util.zip.GZIPInputStream(new ByteArrayInputStream(bytes))));
            // 仅保留独立合成格式产物，供主机 Windows 原生解码复验；不含真实数据。
            Files.write(context().getCacheDir().toPath().resolve("archive-device-java.gz"), bytes);
        }
        assertCleanCache();
    }

    private final class Selected {
        final SafDirectoryStore store = new SafDirectoryStore(context());
        final String rootId;
        final String deviceId;
        final List<JSONObject> entries = new ArrayList<>();
        Selected() throws Exception {
            String expected = InstrumentationRegistry.getArguments().getString("archiveExpectedName");
            assertNotNull("Pass archiveExpectedName for the explicitly selected synthetic directory", expected);
            assertTrue(expected.startsWith("SaveDataSync-Archive-"));
            JSONArray roots = store.listRoots(new CancellationSignal()); JSONObject selected = null;
            for (int i = 0; i < roots.length(); i++) {
                JSONObject root = roots.getJSONObject(i);
                if (expected.equals(root.getString("displayName"))) { assertNull(selected); selected = root; }
            }
            assertNotNull("Select the exact synthetic directory through the system READ picker first", selected);
            assertEquals("granted", selected.getString("authorization"));
            rootId = selected.getString("rootId"); deviceId = selected.getString("deviceId");
            JSONArray top = store.listDirectory(rootId, null, new CancellationSignal()).getJSONArray("entries");
            assertEquals(4, top.length());
            for (int i = 0; i < top.length(); i++) {
                JSONObject item = top.getJSONObject(i);
                if (item.getString("kind").equals("directory")) {
                    JSONArray child = store.listDirectory(rootId, item.getString("entryId"), new CancellationSignal()).getJSONArray("entries");
                    assertEquals(1, child.length()); entries.add(child.getJSONObject(0));
                } else entries.add(item);
            }
            assertEquals(4, entries.size()); entries.sort(Comparator.comparing(item -> item.optString("name")));
        }
        List<ArchiveModel.Source> sources(boolean unknown) throws Exception {
            List<ArchiveModel.Source> sources = new ArrayList<>();
            for (JSONObject entry : entries) {
                SafArchiveSource source = new SafArchiveSource(store, rootId, entry.getString("entryId"));
                sources.add(unknown ? new ArchiveModel.Source() {
                    @Override public void validateRoot(String rootId) throws ArchiveFailure { source.validateRoot(rootId); }
                    @Override public ArchiveModel.Observation observe(ArchiveControl control) throws Exception {
                        ArchiveModel.Observation observed = source.observe(control);
                        return new ArchiveModel.Observation(observed.identity, observed.entryId, observed.parentId,
                            observed.name, null, observed.modified);
                    }
                    @Override public InputStream open(ArchiveControl control) throws Exception { return source.open(control); }
                } : source);
            }
            return sources;
        }
    }

    @Test public void actualSafStreamsSnapshotKnownAndUnknownLengthsWithoutChangingSource() throws Exception {
        Selected selected = new Selected(); Map<String, String> before = new HashMap<>();
        for (JSONObject entry : selected.entries) before.put(entry.getString("entryId"),
            digest(selected.store.openFile(selected.rootId, entry.getString("entryId"), new CancellationSignal())));
        ArchiveAdapter adapter = SafArchiveSource.createAdapter(context());
        Path staged = context().getCacheDir().toPath().resolve("archive-saf-roundtrip.gz");
        try {
            for (boolean unknown : new boolean[] { false, true }) {
                ArchiveModel.Manifest manifest;
                try (ArchiveAdapter.Artifact prepared = adapter.prepare("saf-transfer", selected.deviceId, selected.rootId,
                    selected.sources(unknown), new ArchiveControl(), null)) {
                    manifest = prepared.manifest;
                    assertEquals(131073 + 12 + 11, manifest.totalFileBytes);
                    assertEquals(4, manifest.files.size());
                    try (InputStream input = prepared.openArchive(); OutputStream output = Files.newOutputStream(staged)) {
                        byte[] buffer = new byte[65536]; int n;
                        while ((n = input.read(buffer)) != -1) output.write(buffer, 0, n);
                    }
                    // 保留本轮合成 SAF 原生快照供 Windows 独立解包，不保存真实目录内容。
                    Files.copy(staged, context().getCacheDir().toPath().resolve("archive-device-saf.gz"),
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                    JSONObject exported = new JSONObject();
                    exported.put("protocolVersion", 1); exported.put("transferId", manifest.transferId);
                    exported.put("sourceDeviceId", manifest.sourceDeviceId); exported.put("sourceRootId", manifest.sourceRootId);
                    exported.put("totalFileBytes", manifest.totalFileBytes); JSONArray records = new JSONArray();
                    for (ArchiveModel.PreparedFile file : manifest.files) {
                        JSONObject record = new JSONObject(); record.put("fileId", file.fileId);
                        record.put("sourceEntryId", file.sourceEntryId);
                        record.put("sourceParentId", file.sourceParentId == null ? JSONObject.NULL : file.sourceParentId);
                        record.put("sourceName", file.sourceName);
                        record.put("sourceModifiedAt", file.sourceModifiedAt == null ? JSONObject.NULL : file.sourceModifiedAt);
                        record.put("sizeBytes", file.sizeBytes); record.put("sha256", file.sha256); records.put(record);
                    }
                    exported.put("files", records); JSONObject descriptor = new JSONObject();
                    descriptor.put("format", "tar.gz"); descriptor.put("compressionLevel", 1);
                    descriptor.put("sizeBytes", manifest.archive.sizeBytes); descriptor.put("tarSizeBytes", manifest.archive.tarSizeBytes);
                    descriptor.put("sha256", manifest.archive.sha256); exported.put("archive", descriptor);
                    Files.write(context().getCacheDir().toPath().resolve("archive-device-saf.json"), exported.toString().getBytes(StandardCharsets.UTF_8));
                }
                try (ArchiveAdapter.Artifact received = adapter.receive(manifest, Files.newInputStream(staged), new ArchiveControl(), null)) {
                    for (ArchiveModel.PreparedFile file : manifest.files) {
                        assertEquals(before.get(file.sourceEntryId), file.sha256);
                        assertEquals(file.sha256, digest(received.openFile(file.fileId)));
                    }
                }
                assertCleanCache();
            }
        } finally { Files.deleteIfExists(staged); adapter.retryCleanup(); }
        for (JSONObject entry : selected.entries) {
            assertEquals(before.get(entry.getString("entryId")), digest(selected.store.openFile(selected.rootId,
                entry.getString("entryId"), new CancellationSignal())));
            selected.store.archiveObservation(selected.rootId, entry.getString("entryId"), new CancellationSignal());
        }
        report("实际 SAF 已验证：4 文件、含已有子目录，已知/未知长度两轮，源内容/属性保持，缓存释放");
    }







    private void assertCleanCache() throws Exception {
        Path root = context().getCacheDir().toPath().resolve("transfer-archives-v1");
        try (java.nio.file.DirectoryStream<Path> entries = Files.newDirectoryStream(root)) {
            List<String> names = new ArrayList<>(); for (Path entry : entries) names.add(entry.getFileName().toString());
            assertEquals(Collections.singletonList("owner"), names);
        }
    }
    private void report(String message) {
        Bundle report = new Bundle(); report.putString("stream", message);
        InstrumentationRegistry.getInstrumentation().sendStatus(0, report);
    }
}
