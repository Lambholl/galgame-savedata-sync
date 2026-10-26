package io.github.galgame.savedatasync;

import static org.junit.Assert.*;
import static io.github.galgame.savedatasync.PublicationModel.*;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.After;
import org.junit.Test;

/** 发布状态与所有权的受控故障测试；真实 ContentResolver 另由设备测试覆盖。 */
public class NewFilePublisherTest {
    private final List<NewFilePublisher> publishers = new ArrayList<>();
    private final List<Fake> backends = new ArrayList<>();
    private static final byte[] BYTES = {1, 2, 3, 4};
    private static final class Node {
        String id, name;
        byte[] bytes = {};
        boolean directory, virtual;
        Node(String id, String name) { this.id = id; this.name = name; }
        Document document() { return new Document(id, name, directory, virtual, (long) bytes.length, 123L); }
    }
    private static class Fake implements NewFilePublisher.Backend, NewFilePublisher.Directory {
        final Map<String, Node> nodes = new LinkedHashMap<>();
        boolean permission = true, rename, existingId, missing, wrongType, changedIdentity, cleanupFail, closeFail, corrupt, closed;
        String createError, writeError;
        int creates, writes, deletes, opens, reads;
        long modified = 123L;
        Runnable creating, closing, reading;
        Node add(String id, String name, byte[] bytes) { Node node = new Node(id, name); node.bytes = bytes.clone(); nodes.put(id, node); return node; }
        @Override public NewFilePublisher.Directory locate(String root, String parent, ArchiveControl control) throws Exception {
            control.check();
            if (!permission) throw new ArchiveFailure("authorization-expired", "模拟撤权");
            if (!"root-1".equals(root) || (parent != null && !"parent-1".equals(parent))) throw new ArchiveFailure("not-found", "模拟越界引用");
            return this;
        }
        @Override public List<Document> children(NewFilePublisher.Directory directory, ArchiveControl control) throws Exception {
            control.check(); List<Document> result = new ArrayList<>();
            for (Node n : nodes.values()) result.add(n.document());
            return result;
        }
        @Override public String create(NewFilePublisher.Directory directory, String name) throws Exception {
            creates++;
            if (creating != null) creating.run();
            Node node = add("new-" + creates, rename ? name + " (1)" : name, new byte[0]);
            node.directory = wrongType;
            if (createError != null) throw new ArchiveFailure(createError, "模拟创建结果丢失");
            return existingId ? "existing" : missing ? "absent" : node.id;
        }
        @Override public NewFilePublisher.Owned claim(NewFilePublisher.Directory directory, Document document) {
            Node node = nodes.get(document.id);
            return new NewFilePublisher.Owned() {
                boolean deleted;
                @Override public OutputStream openOutput(long size, ArchiveControl control) throws Exception {
                    opens++; verify(control);
                    return new ByteArrayOutputStream() {
                        @Override public void write(byte[] bytes, int offset, int length) {
                            writes++; super.write(bytes, offset, length);
                        }
                        @Override public void close() throws IOException {
                            node.bytes = toByteArray();
                            if (writeError != null) { String code = writeError; writeError = null; throw new ArchiveFailure(code, "模拟写入失败"); }
                        }
                    };
                }
                @Override public InputStream openRead(ArchiveControl control) throws Exception {
                    reads++; verify(control); if (reading != null) reading.run();
                    byte[] bytes = node.bytes.clone(); if (corrupt && bytes.length > 0) bytes[0] ^= 1;
                    return new ByteArrayInputStream(bytes);
                }
                @Override public void verify(ArchiveControl control) throws Exception {
                    control.check();
                    if (changedIdentity) throw new ArchiveFailure("result-unknown", "模拟替换");
                }
                @Override public Entry entry(ArchiveControl control) throws Exception {
                    control.check(); return new Entry("root-1", null, "public-" + node.id, node.name, (long) node.bytes.length, modified);
                }
                @Override public void delete() throws Exception {
                    if (deleted) return;
                    if (cleanupFail || changedIdentity) throw new IOException("模拟清理失败");
                    deletes++; nodes.remove(node.id); deleted = true;
                }
                @Override public void close() throws IOException {
                    if (closing != null) closing.run();
                    if (closeFail) throw new IOException("模拟句柄关闭失败");
                    closed = true;
                }
            };
        }
    }
    private NewFilePublisher publisher(Fake backend) throws Exception {
        NewFilePublisher p = new NewFilePublisher(backend); publishers.add(p); backends.add(backend); p.grant("root-1"); return p;
    }
    private static String hash(byte[] bytes) { return NewFilePublisher.hex(ArchiveFormat.sha256().digest(bytes)); }
    private static Request request(String name, byte[] bytes) { return new Request("f000001", "root-1", null, name, bytes.length, hash(bytes)); }
    private Result run(NewFilePublisher p, byte[] bytes) throws Exception {
        return p.publish(request("存档 😀.sav", bytes), () -> new ByteArrayInputStream(bytes), null, new ArchiveControl());
    }
    @After public void cleanup() {
        for (Fake b : backends) { b.cleanupFail = false; b.changedIdentity = false; b.closeFail = false; b.writeError = null; b.closing = null; }
        for (NewFilePublisher p : publishers) assertTrue(p.stop());
    }

    @Test public void succeedsOnlyAfterWriteCloseAndFullReadback() throws Exception {
        Fake b = new Fake(); NewFilePublisher p = publisher(b);
        List<String> stages = new ArrayList<>();
        Result result = p.publish(request("存档.sav", BYTES), () -> new ByteArrayInputStream(BYTES),
            (stage, count, total) -> { assertEquals(4L, total.longValue()); stages.add(stage); }, new ArchiveControl());
        assertEquals("succeeded", result.status); assertEquals("complete", result.cleanup);
        assertEquals(4, result.bytesWritten); assertEquals(hash(BYTES), result.sha256);
        assertEquals("存档.sav", result.entry.name); assertTrue(result.residualEntries.isEmpty());
        assertArrayEquals(BYTES, b.nodes.get("new-1").bytes); assertEquals(0, b.deletes);
        assertEquals(Arrays.asList("writing", "verifying"), stages); assertTrue(b.closed);
    }
    @Test public void supportsEmptyUnicodeAndMultipleBuffers() throws Exception {
        for (int size : new int[] {0, 65537, 131073}) {
            Fake b = new Fake(); NewFilePublisher p = publisher(b); byte[] bytes = new byte[size];
            for (int i = 0; i < size; i++) bytes[i] = (byte) (i * 31 + 7);
            assertEquals("succeeded", run(p, bytes).status); assertArrayEquals(bytes, b.nodes.get("new-1").bytes);
        }
    }
    @Test public void rejectsUnsafeNamesAndMalformedRequestsBeforeMutation() throws Exception {
        Fake b = new Fake(); NewFilePublisher p = publisher(b);
        for (String name : new String[] {"", ".", "..", "a/b", "a\\b", "CON", "nul.sav", "com¹.foo", "a ", "a.", "a\u0000b", "a\u007fb", "a\ud800", "a?b"}) {
            ArchiveFailure f = assertThrows(ArchiveFailure.class, () -> p.publish(request(name, BYTES), () -> new ByteArrayInputStream(BYTES), null, new ArchiveControl()));
            assertEquals(name, "invalid-request", f.code);
        }
        for (Request r : Arrays.asList(new Request("bad/", "root-1", null, "a", 0, hash(BYTES)),
            new Request("f000001", "root-1", "../", "a", 0, hash(BYTES)), new Request("f000001", "root-1", null, "a", -1, hash(BYTES)),
            new Request("f000001", "root-1", null, "a", 0, "BAD"), new Request("f000001", "root-1", null, "a", 268435457L, hash(BYTES)),
            new Request("f1", "root-1", null, "a", 0, hash(BYTES)), new Request("f000000", "root-1", null, "a", 0, hash(BYTES)),
            new Request("f001025", "root-1", null, "a", 0, hash(BYTES)))) {
            assertThrows(ArchiveFailure.class, () -> p.publish(r, () -> new ByteArrayInputStream(BYTES), null, new ArchiveControl()));
        }
        assertTrue(portableName("存档😀.sav")); assertEquals(0, b.creates);
    }
    @Test public void systemWriteDoesNotGrantNativePublication() throws Exception {
        Fake b = new Fake(); NewFilePublisher p = new NewFilePublisher(b); publishers.add(p);
        assertEquals("permission-denied", assertThrows(ArchiveFailure.class, () -> run(p, BYTES)).code);
        b.permission = false;
        assertEquals("authorization-expired", assertThrows(ArchiveFailure.class, () -> p.grant("root-1")).code);
        assertEquals(0, b.creates);
    }
    @Test public void rechecksPermissionAndParentBoundary() throws Exception {
        Fake b = new Fake(); NewFilePublisher p = publisher(b); b.permission = false;
        assertEquals("authorization-expired", run(p, BYTES).errorCode); b.permission = true;
        Result result = p.publish(new Request("f000001", "root-1", "other-parent", "a", 4, hash(BYTES)), () -> new ByteArrayInputStream(BYTES), null, new ArchiveControl());
        assertEquals("not-found", result.errorCode); assertEquals(0, b.creates);
    }
    @Test public void refusesSameOrEquivalentNameWithoutOpeningExistingFile() throws Exception {
        for (String name : new String[] {"存档 😀.sav", "存档 😀.SAV"}) {
            Fake b = new Fake(); b.add("existing", name, BYTES); NewFilePublisher p = publisher(b);
            assertEquals("name-conflict", run(p, BYTES).errorCode);
            assertEquals(0, b.creates); assertEquals(0, b.opens); assertArrayEquals(BYTES, b.nodes.get("existing").bytes);
        }
        assertEquals(nameKey("é.sav"), nameKey("e\u0301.SAV"));
    }
    @Test public void providerRenameIsCleanedWithoutWriting() throws Exception {
        Fake b = new Fake(); b.rename = true; NewFilePublisher p = publisher(b);
        Result r = run(p, BYTES); assertEquals("failed", r.status); assertEquals("name-conflict", r.errorCode);
        assertEquals("complete", r.cleanup); assertEquals(0, b.opens); assertTrue(b.nodes.isEmpty());
    }
    @Test public void racingCompetitorIsPreservedAndOnlyOwnedDocumentDeleted() throws Exception {
        Fake b = new Fake(); b.creating = () -> b.add("competitor", "存档 😀.sav", BYTES); NewFilePublisher p = publisher(b);
        Result r = run(p, BYTES); assertEquals("name-conflict", r.errorCode); assertEquals(0, b.opens);
        assertEquals(1, b.nodes.size()); assertArrayEquals(BYTES, b.nodes.get("competitor").bytes);
    }
    @Test public void returnedExistingIdentityIsNeverWrittenOrDeleted() throws Exception {
        Fake b = new Fake(); b.add("existing", "control.sav", BYTES); b.existingId = true; NewFilePublisher p = publisher(b);
        Result r = run(p, BYTES); assertEquals("unknown", r.status); assertEquals("unknown", r.cleanup);
        assertEquals(0, b.opens); assertEquals(0, b.deletes); assertArrayEquals(BYTES, b.nodes.get("existing").bytes);
    }
    @Test public void missingIdentityAndLostCreateResponseRemainUnknown() throws Exception {
        for (boolean lost : new boolean[] {false, true}) {
            Fake b = new Fake(); b.missing = !lost; b.createError = lost ? "io-failure" : null; NewFilePublisher p = publisher(b);
            Result r = run(p, BYTES); assertEquals("unknown", r.status); assertEquals("result-unknown", r.errorCode);
            assertEquals(0, b.opens); assertEquals(0, b.deletes); assertEquals(1, b.nodes.size());
        }
    }
    @Test public void refusesNonFileCreatedObject() throws Exception {
        Fake b = new Fake(); b.wrongType = true; NewFilePublisher p = publisher(b);
        assertEquals("unsupported-operation", run(p, BYTES).errorCode); assertEquals(0, b.opens);
    }
    @Test public void validatesSourceLengthAndHashAndCleansOnlyNewDocument() throws Exception {
        for (byte[] source : new byte[][] {{1}, {1,2,3,4,5}, {9,2,3,4}}) {
            Fake b = new Fake(); b.add("existing", "control", BYTES); NewFilePublisher p = publisher(b);
            Result r = p.publish(request("new.sav", BYTES), () -> new ByteArrayInputStream(source), null, new ArchiveControl());
            assertEquals("checksum-mismatch", r.errorCode); assertEquals("complete", r.cleanup); assertEquals(0, b.reads);
            assertEquals(1, b.nodes.size()); assertArrayEquals(BYTES, b.nodes.get("existing").bytes);
        }
    }
    @Test public void readbackCorruptionCannotSucceed() throws Exception {
        Fake b = new Fake(); b.corrupt = true; NewFilePublisher p = publisher(b);
        assertEquals("checksum-mismatch", run(p, BYTES).errorCode); assertTrue(b.nodes.isEmpty());
    }
    @Test public void propagatesSpaceAndIoFailureSeparatelyFromCleanup() throws Exception {
        for (String code : new String[] {"insufficient-space", "io-failure"}) {
            Fake b = new Fake(); b.writeError = code; NewFilePublisher p = publisher(b);
            Result r = run(p, BYTES); assertEquals(code, r.errorCode); assertEquals("complete", r.cleanup);
        }
    }
    @Test public void cancellationBeforeCreateDoesNotMutate() throws Exception {
        Fake b = new Fake(); NewFilePublisher p = publisher(b); ArchiveControl c = new ArchiveControl(); c.cancel();
        Result r = p.publish(request("a", BYTES), () -> new ByteArrayInputStream(BYTES), null, c);
        assertEquals("cancelled", r.status); assertEquals("not-needed", r.cleanup); assertEquals(0, b.creates);
    }
    @Test public void cancellationDuringCreateWaitsAndCleansReturnedOwnedIdentity() throws Exception {
        Fake b = new Fake(); NewFilePublisher p = publisher(b); b.creating = p::cancel;
        Result r = run(p, BYTES); assertEquals("cancelled", r.status); assertEquals("complete", r.cleanup);
        assertEquals(0, b.opens); assertTrue(b.nodes.isEmpty());
    }
    @Test public void cancellationDuringWriteAndReadbackClosesStreamsAndCleans() throws Exception {
        for (String phase : new String[] {"writing", "verifying"}) {
            Fake b = new Fake(); NewFilePublisher p = publisher(b);
            Result r = p.publish(request("a", BYTES), () -> new ByteArrayInputStream(BYTES),
                (stage, count, total) -> { if (stage.equals(phase)) p.cancel(); }, new ArchiveControl());
            assertEquals("cancelled", r.status); assertEquals("complete", r.cleanup); assertTrue(b.nodes.isEmpty());
        }
    }
    @Test public void confirmedSuccessWinsLateCancellation() throws Exception {
        Fake b = new Fake(); NewFilePublisher p = publisher(b); b.closing = p::cancel;
        Result r = run(p, BYTES); assertEquals("succeeded", r.status); assertEquals(0, b.deletes); assertEquals(1, b.nodes.size());
    }
    @Test public void cleanupFailureRetainsGlobalSlotUntilExplicitRetry() throws Exception {
        Fake b = new Fake(); b.corrupt = true; b.cleanupFail = true; NewFilePublisher p = publisher(b);
        Result r = run(p, BYTES); assertEquals("failed", r.status); assertEquals("incomplete", r.cleanup);
        assertEquals("cleanup-failed", r.cleanupError); assertEquals(1, r.residualEntries.size());
        NewFilePublisher other = publisher(new Fake());
        assertEquals("busy", assertThrows(ArchiveFailure.class, () -> run(other, BYTES)).code);
        assertFalse(p.retryCleanup()); b.cleanupFail = false; assertTrue(p.retryCleanup());
        assertEquals("succeeded", run(other, BYTES).status);
    }
    @Test public void successCloseFailureNeverDeletesFinalFileOnRetry() throws Exception {
        Fake b = new Fake(); b.closeFail = true; NewFilePublisher p = publisher(b);
        Result r = run(p, BYTES); assertEquals("succeeded", r.status); assertEquals("incomplete", r.cleanup);
        assertTrue(r.residualEntries.isEmpty()); b.closeFail = false; assertTrue(p.retryCleanup());
        assertEquals(0, b.deletes); assertArrayEquals(BYTES, b.nodes.get("new-1").bytes);
    }
    @Test public void identityChangeRemainsUnknownAndCleanupDoesNotTouchReplacement() throws Exception {
        Fake b = new Fake(); NewFilePublisher p = publisher(b); b.reading = () -> b.changedIdentity = true;
        Result r = run(p, BYTES); assertEquals("unknown", r.status); assertEquals("incomplete", r.cleanup);
        assertEquals(0, b.deletes); assertEquals(1, r.residualEntries.size());
    }
    @Test public void deadlineIsNotRefreshedByProgress() throws Exception {
        Fake b = new Fake(); NewFilePublisher p = publisher(b); AtomicLong now = new AtomicLong();
        ArchiveControl control = new ArchiveControl(now::get, 100);
        Result r = p.publish(request("a", BYTES), () -> new ByteArrayInputStream(BYTES),
            (stage, count, total) -> now.set(101), control);
        assertEquals("timeout", r.errorCode); assertEquals("complete", r.cleanup);
    }
    @Test public void revokeAndStopCancelActiveCallWithoutReleasingItsSlotEarly() throws Exception {
        Fake b = new Fake(); NewFilePublisher p = publisher(b); CountDownLatch started = new CountDownLatch(1), resume = new CountDownLatch(1);
        b.creating = () -> { started.countDown(); try { assertTrue(resume.await(5, TimeUnit.SECONDS)); } catch (InterruptedException e) { throw new AssertionError(e); } };
        AtomicReference<Result> result = new AtomicReference<>(); AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread worker = new Thread(() -> { try { result.set(run(p, BYTES)); } catch (Throwable t) { failure.set(t); } });
        worker.start(); assertTrue(started.await(5, TimeUnit.SECONDS)); p.revoke("root-1"); assertFalse(p.stop());
        NewFilePublisher other = publisher(new Fake()); assertEquals("busy", assertThrows(ArchiveFailure.class, () -> run(other, BYTES)).code);
        resume.countDown(); worker.join(5000); assertFalse(worker.isAlive()); assertNull(failure.get());
        assertEquals("cancelled", result.get().status); assertTrue(p.stop());
        assertEquals("permission-denied", assertThrows(ArchiveFailure.class, () -> run(p, BYTES)).code);
        assertEquals("succeeded", run(other, BYTES).status);
    }

    @Test public void preflightIsReadOnlyAndDoesNotReserveOrCreate() throws Exception {
        Fake b = new Fake(); NewFilePublisher p = publisher(b);
        p.preflight(request("new.sav", BYTES), new ArchiveControl()); assertEquals(0, b.creates);
        b.add("existing", "new.sav", BYTES);
        assertEquals("name-conflict", assertThrows(ArchiveFailure.class,
            () -> p.preflight(request("new.sav", BYTES), new ArchiveControl())).code);
        assertEquals(0, b.opens); assertEquals(0, b.deletes);
    }
    @Test public void sourceCloseFailureRetainsStreamsAndSlotUntilRetry() throws Exception {
        Fake b = new Fake(); NewFilePublisher p = publisher(b); AtomicBoolean fault = new AtomicBoolean(true);
        Result result = p.publish(request("new.sav", BYTES), () -> new ByteArrayInputStream(BYTES) {
            @Override public void close() throws IOException { if (fault.get()) throw new IOException("仍未关闭"); super.close(); }
        }, null, new ArchiveControl());
        try {
            assertEquals("failed", result.status); assertEquals("incomplete", result.cleanup);
            assertEquals(1, result.residualEntries.size()); assertEquals(0, b.deletes);
            NewFilePublisher other = publisher(new Fake());
            assertEquals("busy", assertThrows(ArchiveFailure.class, () -> run(other, BYTES)).code);
        } finally { fault.set(false); assertTrue(p.retryCleanup()); }
        assertTrue(b.nodes.isEmpty());
    }
    @Test public void cancellationClosesBlockedSourceAndWaitsForWorkerCleanup() throws Exception {
        Fake b = new Fake(); NewFilePublisher p = publisher(b); CountDownLatch reading = new CountDownLatch(1), closed = new CountDownLatch(1);
        AtomicReference<Result> result = new AtomicReference<>(); AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread worker = new Thread(() -> {
            try {
                result.set(p.publish(request("blocked.sav", BYTES), () -> new InputStream() {
                    @Override public int read() throws IOException { throw new IOException("只使用有限缓冲读取"); }
                    @Override public int read(byte[] bytes, int offset, int length) throws IOException {
                        reading.countDown();
                        try { if (!closed.await(5, TimeUnit.SECONDS)) throw new IOException("取消未关闭阻塞流"); }
                        catch (InterruptedException e) { throw new IOException(e); }
                        throw new IOException("已关闭");
                    }
                    @Override public void close() { closed.countDown(); }
                }, null, new ArchiveControl()));
            } catch (Throwable t) { failure.set(t); }
        });
        worker.start(); assertTrue(reading.await(5, TimeUnit.SECONDS)); p.cancel(); worker.join(5000);
        assertFalse(worker.isAlive()); assertNull(failure.get()); assertEquals("cancelled", result.get().status);
        assertEquals("complete", result.get().cleanup); assertTrue(b.nodes.isEmpty());
    }
    @Test public void contradictoryAndOverBudgetDirectoryObservationsFailBeforeCreate() throws Exception {
        for (boolean overBudget : new boolean[] {false, true}) {
            Fake b = new Fake() {
                @Override public List<Document> children(NewFilePublisher.Directory d, ArchiveControl c) {
                    List<Document> result = new ArrayList<>();
                    int count = overBudget ? MAX_DIRECTORY_ENTRIES + 1 : 2;
                    for (int i = 0; i < count; i++) result.add(new Document(overBudget ? "id-" + i : "duplicate", "control", false, false, 0L, null));
                    return result;
                }
            };
            NewFilePublisher p = publisher(b); Result result = run(p, BYTES);
            assertEquals(overBudget ? "failed" : "unknown", result.status);
            assertEquals(overBudget ? "resource-limit" : "result-unknown", result.errorCode); assertEquals(0, b.creates);
        }
    }
    @Test public void metadataChangeDuringFinalReadbackCannotSucceed() throws Exception {
        Fake b = new Fake(); NewFilePublisher p = publisher(b); b.reading = () -> b.modified++;
        Result result = run(p, BYTES); assertEquals("unknown", result.status);
        assertEquals("result-unknown", result.errorCode); assertEquals("complete", result.cleanup);
        assertTrue(b.nodes.isEmpty());
    }
}
