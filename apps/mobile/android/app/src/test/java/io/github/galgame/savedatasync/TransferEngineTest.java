package io.github.galgame.savedatasync;

import static org.junit.Assert.*;
import static io.github.galgame.savedatasync.TransferJson.*;
import static io.github.galgame.savedatasync.TransferSchema.*;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** 实际归档/发布模块加可注入对端，覆盖两角色结果、零提前发布、生命周期及清理所有权。 */
public class TransferEngineTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private final List<TransferEngine> engines = new ArrayList<>();
    private final List<MemoryTarget> targets = new ArrayList<>();
    private final byte[][] contents = {new byte[0], "存档 😀".getBytes(StandardCharsets.UTF_8), new byte[131073]};
    private ArchiveAdapter archive() throws Exception { return new ArchiveAdapter(new ArchiveCache(temporary.newFolder().toPath().toRealPath())); }
    private List<ArchiveModel.Source> sources(String root) {
        List<ArchiveModel.Source> result = new ArrayList<>();
        for (int i = 0; i < contents.length; i++) {
            final int index = i;
            result.add(new ArchiveModel.Source() {
                @Override public ArchiveModel.Observation observe(ArchiveControl c) { return new ArchiveModel.Observation("identity-" + index, "entry-" + index, null, "source-" + index, (long) contents[index].length, 123L); }
                @Override public InputStream open(ArchiveControl c) { return new ByteArrayInputStream(contents[index]); }
                @Override public void validateRoot(String value) throws ArchiveFailure { require(root.equals(value)); }
            });
        }
        return result;
    }
    private final class MemoryTarget implements NewFilePublisher.Backend, NewFilePublisher.Directory {
        final Map<String, byte[]> files = new HashMap<>();
        boolean cleanupFault, corrupt;
        int creates;
        @Override public NewFilePublisher.Directory locate(String root, String parent, ArchiveControl c) throws Exception { c.check(); require("mobile-root".equals(root) && parent == null); return this; }
        @Override public List<PublicationModel.Document> children(NewFilePublisher.Directory d, ArchiveControl c) throws Exception {
            c.check(); List<PublicationModel.Document> result = new ArrayList<>();
            for (String name : files.keySet()) result.add(new PublicationModel.Document(name, name, false, false, (long) files.get(name).length, 123L)); return result;
        }
        @Override public String create(NewFilePublisher.Directory d, String name) { creates++; files.put(name, new byte[0]); return name; }
        @Override public NewFilePublisher.Owned claim(NewFilePublisher.Directory d, PublicationModel.Document document) {
            String name = document.name;
            return new NewFilePublisher.Owned() {
                @Override public OutputStream openOutput(long size, ArchiveControl c) { return new ByteArrayOutputStream() { @Override public void close() { files.put(name, toByteArray()); } }; }
                @Override public InputStream openRead(ArchiveControl c) { byte[] bytes = files.get(name).clone(); if (corrupt && bytes.length > 0) bytes[0] ^= 1; return new ByteArrayInputStream(bytes); }
                @Override public void verify(ArchiveControl c) throws Exception { c.check(); }
                @Override public PublicationModel.Entry entry(ArchiveControl c) { return new PublicationModel.Entry("mobile-root", null, "published-" + creates, name, (long) files.get(name).length, 123L); }
                @Override public void delete() throws Exception { if (cleanupFault) throw new java.io.IOException("注入清理失败"); files.remove(name); }
                @Override public void close() {}
            };
        }
    }
    private Map<String, Object> metadata(int index) {
        return object("rootId", "windows-root", "entryId", "entry-" + index, "parentId", null, "name", "source-" + index, "kind", "file", "sizeBytes", (long) contents[index].length,
            "modifiedAt", 123L, "capabilities", object("canRead", "supported", "canList", "unsupported", "canCreate", "unsupported", "canRename", "unsupported", "canDelete", "unsupported"));
    }
    private final class Peer implements TransferHttp {
        ArchiveModel.Manifest manifest;
        byte[] packed;
        Map<String, Object> receive;
        int posts, puts, gets, deletes;
        boolean corrupt, wrongManifest, postLost, putLost, receiverFailed, block, terminal;
        final CountDownLatch reading = new CountDownLatch(1), closed = new CountDownLatch(1);
        Peer() throws Exception {
            for (int i = 0; i < contents[2].length; i++) contents[2][i] = (byte) (i * 31 + 7);
            try (ArchiveAdapter.Artifact artifact = archive().prepare("transfer-1", "windows-device", "windows-root", sources("windows-root"), new ArchiveControl(), null);
                 InputStream input = artifact.openArchive(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[65536]; int n; while ((n = input.read(buffer)) >= 0) bytes.write(buffer, 0, n);
                packed = bytes.toByteArray(); manifest = artifact.manifest;
            }
        }
        Map<String, Object> state(boolean upload, boolean done) throws Exception {
            String direction = upload ? "android-to-windows" : "windows-to-android";
            List<Object> results = new ArrayList<>();
            if (upload && done) {
                ArchiveModel.Manifest m = TransferSchema.manifest(receive.get("manifest"));
                for (int i = 0; i < m.files.size(); i++) {
                    ArchiveModel.PreparedFile f = m.files.get(i); Map<String, Object> target = TransferSchema.target(list(receive.get("targets")), f.fileId);
                    if (receiverFailed) results.add(i == 0 ? object("fileId", f.fileId, "status", "failed", "error", error("io-failure"), "residualEntries", new ArrayList<>()) : object("fileId", f.fileId, "status", "not-attempted", "reason", "prior-failure"));
                    else results.add(outcome(new PublicationModel.Result(new PublicationModel.Request(f.fileId, "windows-root", null, string(target.get("name")), f.sizeBytes, f.sha256), "succeeded", null,
                        new PublicationModel.Entry("windows-root", null, "result-" + i, string(target.get("name")), f.sizeBytes, 123L), null, "complete", null)));
                }
            }
            Map<String, Object> result = object("transferId", manifest.transferId, "direction", direction, "role", upload ? "receiver" : "sender", "updatedAt", System.currentTimeMillis(),
                "status", done ? upload ? receiverFailed ? "failed" : "succeeded" : "sent" : "running", "fileResults", upload ? results : null);
            if (done) { result.put("error", receiverFailed && upload ? error("io-failure") : null); result.put("cleanupStatus", "complete"); result.put("cleanupError", null); }
            else {
                result.put("stage", upload ? "awaiting-content" : "ready"); result.put("cancelRequested", false);
                ArchiveModel.Manifest m = upload ? TransferSchema.manifest(receive.get("manifest")) : manifest;
                result.put("progress", object("sourceBytesRead", upload ? 0 : m.totalFileBytes, "archiveBytesTransferred", 0, "fileBytesVerified", 0, "fileBytesPublished", 0,
                    "totalFileBytes", m.totalFileBytes, "totalArchiveBytes", m.archive.sizeBytes, "totalFiles", m.files.size(), "verifiedFiles", 0, "publishedFiles", 0));
            }
            return result;
        }
        @Override public Object json(String method, String path, String session, Object body, int expected, ArchiveControl c) throws Exception {
            c.check();
            if (path.equals("/v1/device")) return object("device", object("protocolVersion", 1, "deviceId", "windows-device", "displayName", "测试电脑", "platform", "windows",
                "capabilities", object("canListRoots", "supported", "canReadFiles", "supported", "canReceiveFiles", "supported", "canQueryTransfers", "supported", "canCancelTransfers", "supported")),
                "sessionId", "session-1", "limits", limits());
            assertEquals("session-1", session);
            if (path.equals("/v1/roots")) return Arrays.asList(object("rootId", "windows-root", "deviceId", "windows-device", "displayName", "测试根", "authorization", "granted"));
            if (path.endsWith("/entries")) { List<Object> files = new ArrayList<>(); for (int i = 0; i < 3; i++) files.add(metadata(i)); return object("rootId", "windows-root", "parentId", null, "observedAt", 123L, "entries", files); }
            if (method.equals("POST")) {
                posts++; boolean upload = path.endsWith("uploads"); if (upload) receive = map(body);
                String id = upload ? string(map(receive.get("manifest")).get("transferId")) : string(map(body).get("transferId"));
                manifest = new ArchiveModel.Manifest(id, manifest.sourceDeviceId, manifest.sourceRootId, manifest.files, manifest.totalFileBytes, manifest.archive);
                if (postLost) { postLost = false; throw TransferJson.fail("network-failure"); } return state(upload, false);
            }
            if (method.equals("DELETE")) { deletes++; Map<String, Object> result = state(false, true); result.put("status", "cancelled"); return result; }
            if (path.endsWith("/manifest")) { Map<String, Object> m = manifestJson(manifest); if (wrongManifest) m.put("sourceRootId", "wrong-root"); return m; }
            return state(receive != null, terminal);
        }
        @Override public InputStream download(String path, String session, ArchiveModel.Descriptor descriptor, ArchiveControl c, ArchiveModel.Progress progress) throws Exception {
            gets++; byte[] bytes = packed.clone(); if (corrupt) bytes[bytes.length / 2] ^= 1;
            if (block) return new InputStream() {
                @Override public int read() throws java.io.IOException { throw new java.io.IOException("仅有限缓冲"); }
                @Override public int read(byte[] b, int o, int l) throws java.io.IOException {
                    reading.countDown(); try { if (!closed.await(5, TimeUnit.SECONDS)) throw new java.io.IOException("未取消"); } catch (InterruptedException cause) { throw new java.io.IOException(cause); }
                    throw new java.io.IOException("已关闭");
                }
                @Override public void close() { closed.countDown(); }
            };
            return new ByteArrayInputStream(bytes);
        }
        @Override public Object upload(String path, String session, ArchiveModel.Descriptor descriptor, InputStream input, ArchiveControl c, ArchiveModel.Progress progress) throws Exception {
            puts++; long count = 0; try (InputStream stream = input) { byte[] b = new byte[65536]; int n; while ((n = stream.read(b)) >= 0) { count += n; progress.update("transferring", count, descriptor.sizeBytes); } }
            assertEquals(descriptor.sizeBytes, count); terminal = true; if (putLost) throw TransferJson.fail("network-failure"); return state(true, true);
        }
    }
    private TransferEngine engine(Peer peer, boolean grant, long retention) throws Exception {
        MemoryTarget target = new MemoryTarget(); targets.add(target); NewFilePublisher publisher = new NewFilePublisher(target); if (grant) publisher.grant("mobile-root");
        TransferEngine engine = new TransferEngine(archive(), publisher, new TransferEngine.Local() {
            @Override public String deviceId() { return "mobile-device"; }
            @Override public List<ArchiveModel.Source> sources(String root, List<Object> files) { return TransferEngineTest.this.sources(root); }
        }, null, 10000, retention, 1);
        engines.add(engine); engine.foreground(true); engine.connect(peer, new ArchiveControl()); engine.roots(new ArchiveControl()); engine.directory("windows-root", null, new ArchiveControl()); return engine;
    }
    private Map<String, Object> options(boolean upload, String id) {
        List<Object> files = new ArrayList<>(), targets = new ArrayList<>();
        for (int i = 0; i < 3; i++) { files.add(object("fileId", ArchiveModel.id(i), "entryId", "entry-" + i)); targets.add(object("fileId", ArchiveModel.id(i), "parentId", null, "name", "target-" + i + ".sav")); }
        return object("request", object("protocolVersion", 1, "transferId", id, "sourceRootId", upload ? "mobile-source" : "windows-root", "files", files), "targetRootId", upload ? "windows-root" : "mobile-root", "targets", targets);
    }
    private void idle(TransferEngine engine) throws Exception { long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10); while (!engine.retryCleanup() && System.nanoTime() < until) Thread.sleep(5); assertTrue(engine.retryCleanup()); }
    @After public void cleanup() throws Exception {
        for (MemoryTarget target : targets) target.cleanupFault = false;
        for (TransferEngine engine : engines) { engine.close(); idle(engine); }
    }
    @Test public void downloadVerifiesEverythingBeforePublishingAndReportsExactResults() throws Exception {
        Peer peer = new Peer(); TransferEngine engine = engine(peer, true, 600000); engine.start(options(false, "transfer-1"), false); idle(engine);
        Map<String, Object> result = engine.query("transfer-1"); assertEquals("succeeded", result.get("status"));
        TransferSchema.state(result, "transfer-1", "windows-to-android", "receiver", peer.manifest, "mobile-root", list(options(false, "transfer-1").get("targets")), 3);
        assertEquals(1, peer.gets); assertEquals(3, targets.get(0).creates); for (int i = 0; i < 3; i++) assertArrayEquals(contents[i], targets.get(0).files.get("target-" + i + ".sav"));
    }


    @Test public void requiresSeparateNativeWriteAuthorizationBeforeContent() throws Exception {
        Peer peer = new Peer(); TransferEngine engine = engine(peer, false, 600000); engine.start(options(false, "transfer-1"), false); idle(engine);
        assertEquals("permission-denied", map(engine.query("transfer-1").get("error")).get("code")); assertEquals(0, peer.gets);
    }

    @Test public void lostPostAndPutReceiptsUseQueriesWithoutReplayingWrites() throws Exception {
        Peer peer = new Peer(); peer.postLost = true; peer.putLost = true; TransferEngine engine = engine(peer, true, 600000); engine.start(options(true, "transfer-1"), true); idle(engine);
        assertEquals("sent", engine.query("transfer-1").get("status")); assertEquals("succeeded", engine.remoteState("transfer-1", false, new ArchiveControl()).get("status"));
        assertEquals(1, peer.posts); assertEquals(1, peer.puts);
    }
    @Test public void pauseKeepsActiveTransferAndOnlyExplicitNotificationActionCancels() throws Exception {
        Peer peer = new Peer(); peer.block = true; TransferEngine engine = engine(peer, true, 600000); engine.start(options(false, "transfer-1"), false);
        assertTrue(peer.reading.await(5, TimeUnit.SECONDS)); engine.foreground(false);
        assertEquals("unsupported-operation", assertThrows(ArchiveFailure.class, () -> engine.query("transfer-1")).code);
        Thread.sleep(100); assertEquals(1, peer.closed.getCount()); assertEquals(0, peer.deletes);
        assertTrue(engine.hasWork()); assertEquals("transfer-1", engine.activeId());
        engine.cancelActive("stale-notification-id", false); assertEquals(1, peer.closed.getCount());
        engine.cancelActive("transfer-1", false);
        idle(engine); engine.foreground(true); assertEquals("cancelled", engine.query("transfer-1").get("status"));
        assertEquals(1, peer.deletes); assertEquals(1, peer.gets); assertEquals(0, targets.get(0).creates);
    }

    @Test public void duplicateTargetsRejectedBeforeIdReservationOrRemotePost() throws Exception {
        Peer peer = new Peer(); TransferEngine engine = engine(peer, true, 600000); Map<String, Object> options = options(false, "transfer-1");
        map(list(options.get("targets")).get(1)).put("name", "TARGET-0.SAV");
        assertEquals("invalid-request", assertThrows(ArchiveFailure.class, () -> engine.start(options, false)).code); assertEquals(0, peer.posts);
        engine.start(options(false, "transfer-1"), false); idle(engine); assertEquals("succeeded", engine.query("transfer-1").get("status"));
    }


    @Test public void foregroundViewCanReattachExistingContextWithoutStartingAnotherTask() throws Exception {
        Peer peer = new Peer(); TransferEngine engine = engine(peer, true, 600000);
        assertNull(engine.current()); engine.start(options(false, "transfer-1"), false); idle(engine);
        Map<String, Object> current = map(engine.current()); assertEquals(Boolean.FALSE, current.get("upload"));
        assertEquals("transfer-1", map(map(current.get("options")).get("request")).get("transferId"));
        device(current.get("device")); assertEquals(1, peer.posts); assertEquals(1, peer.gets);
    }
}
