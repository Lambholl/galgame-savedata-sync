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


    @Test public void refusesSameOrEquivalentNameWithoutOpeningExistingFile() throws Exception {
        for (String name : new String[] {"存档 😀.sav", "存档 😀.SAV"}) {
            Fake b = new Fake(); b.add("existing", name, BYTES); NewFilePublisher p = publisher(b);
            assertEquals("name-conflict", run(p, BYTES).errorCode);
            assertEquals(0, b.creates); assertEquals(0, b.opens); assertArrayEquals(BYTES, b.nodes.get("existing").bytes);
        }
        assertEquals(nameKey("é.sav"), nameKey("e\u0301.SAV"));
    }






    @Test public void readbackCorruptionCannotSucceed() throws Exception {
        Fake b = new Fake(); b.corrupt = true; NewFilePublisher p = publisher(b);
        assertEquals("checksum-mismatch", run(p, BYTES).errorCode); assertTrue(b.nodes.isEmpty());
    }



    @Test public void cancellationDuringWriteAndReadbackClosesStreamsAndCleans() throws Exception {
        for (String phase : new String[] {"writing", "verifying"}) {
            Fake b = new Fake(); NewFilePublisher p = publisher(b);
            Result r = p.publish(request("a", BYTES), () -> new ByteArrayInputStream(BYTES),
                (stage, count, total) -> { if (stage.equals(phase)) p.cancel(); }, new ArchiveControl());
            assertEquals("cancelled", r.status); assertEquals("complete", r.cleanup); assertTrue(b.nodes.isEmpty());
        }
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










}
