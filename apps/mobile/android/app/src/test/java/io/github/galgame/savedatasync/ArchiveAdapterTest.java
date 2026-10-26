package io.github.galgame.savedatasync;

import static org.junit.Assert.*;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** 独立 Python 格式期望、实际 IO 和受控故障；不以 writer/reader 自我往返替代格式证据。 */
public class ArchiveAdapterTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private final List<ArchiveAdapter> adapters = new ArrayList<>();
    private final List<AtomicBoolean> faults = new ArrayList<>();

    @After public void cleanup() throws Exception {
        for (AtomicBoolean fault : faults) fault.set(false);
        for (ArchiveAdapter adapter : adapters) adapter.retryCleanup();
        ArchiveCache.retryOrphanCleanup();
    }
    private ArchiveAdapter adapter() throws Exception { return adapter(new ArchiveModel.Limits(), new ArchiveCache.Io() {}); }
    private ArchiveAdapter adapter(ArchiveModel.Limits limits, ArchiveCache.Io io) throws Exception {
        ArchiveAdapter result = new ArchiveAdapter(new ArchiveCache(temporary.newFolder().toPath(), io), limits);
        adapters.add(result); return result;
    }
    private ArchiveAdapter.Artifact prepare(ArchiveAdapter adapter, byte[]... contents) throws Exception {
        return prepare(adapter, new ArchiveControl(), null, contents);
    }
    private ArchiveAdapter.Artifact prepare(ArchiveAdapter adapter, ArchiveControl control,
                                            ArchiveModel.Progress progress, byte[]... contents) throws Exception {
        List<ArchiveModel.Source> sources = new ArrayList<>();
        for (int i = 0; i < contents.length; i++) sources.add(source(i, contents[i], true));
        return adapter.prepare("test-transfer", "test-device", "test-root", sources, control, progress);
    }
    private ArchiveModel.Source source(int i, byte[] bytes, boolean unknown) {
        return new ArchiveModel.Source() {
            @Override public ArchiveModel.Observation observe(ArchiveControl control) {
                return new ArchiveModel.Observation("identity-" + i, "entry-" + i, i % 2 == 0 ? null : "parent-1",
                    "存档 😀 " + i + ".sav", unknown ? null : (long) bytes.length, null);
            }
            @Override public InputStream open(ArchiveControl control) { return new ByteArrayInputStream(bytes); }
        };
    }
    private static String hash(byte[] bytes) { return ArchiveFormat.hex(ArchiveFormat.sha256().digest(bytes)); }
    private static byte[] collect(InputStream input) throws IOException {
        try (InputStream stream = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[ArchiveModel.BUFFER];
            int n; while ((n = stream.read(buffer)) != -1) out.write(buffer, 0, n);
            return out.toByteArray();
        }
    }
    private String fixture() throws IOException {
        InputStream input = getClass().getResourceAsStream("/archive-v1.json");
        assertNotNull("Shared fixture missing", input);
        return new String(collect(input), StandardCharsets.UTF_8);
    }
    private byte[] fixtureBytes(String name) throws IOException {
        Matcher match = Pattern.compile("\"" + name + "\"\\s*:\\s*\"([^\"]*)\"").matcher(fixture());
        assertTrue(match.find()); return Base64.getDecoder().decode(match.group(1));
    }
    private byte[][] contents() {
        byte[] binary = new byte[513];
        for (int i = 0; i < 512; i++) binary[i] = (byte) i;
        binary[512] = '!';
        return new byte[][] { new byte[0], "固定夹具".getBytes(StandardCharsets.UTF_8), binary };
    }
    private ArchiveModel.Manifest manifest(byte[] archive) {
        List<ArchiveModel.PreparedFile> files = new ArrayList<>();
        byte[][] contents = contents();
        for (int i = 0; i < contents.length; i++) {
            files.add(new ArchiveModel.PreparedFile(ArchiveModel.id(i),
                new ArchiveModel.Observation("identity-" + i, "fixture-" + (i + 1), null,
                    "固定夹具 " + (i + 1) + ".sav", null, null), contents[i].length, hash(contents[i])));
        }
        return new ArchiveModel.Manifest("fixed-fixture", "fixture-source", "fixture-root", files, 525,
            new ArchiveModel.Descriptor(archive.length, 4096, hash(archive)));
    }
    private static byte[] gzip(byte[] bytes) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ArchiveFormat.GzipWriter gzip = new ArchiveFormat.GzipWriter(out)) { gzip.write(bytes); }
        return out.toByteArray();
    }
    private void reject(ArchiveAdapter adapter, byte[] bytes, String code) throws Exception {
        ArchiveFailure failure = assertThrows(ArchiveFailure.class,
            () -> adapter.receive(manifest(bytes), new ByteArrayInputStream(bytes), new ArchiveControl(), null));
        assertEquals(code, failure.code); assertNull(failure.cleanupFailure);
    }

    @Test public void pythonFixtureDecodesAndJavaWriterMatchesExactIndependentTar() throws Exception {
        ArchiveAdapter adapter = adapter();
        byte[] bytes = fixtureBytes("archiveBase64");
        assertEquals(438, bytes.length);
        assertEquals("5a5ce8f22d561895ce0e149e470b6e743efb964b6625525b6b99ec6095000779", hash(bytes));
        try (ArchiveAdapter.Artifact artifact = adapter.receive(manifest(bytes), new ByteArrayInputStream(bytes), new ArchiveControl(), null)) {
            for (int i = 0; i < 3; i++) assertArrayEquals(contents()[i], collect(artifact.openFile(ArchiveModel.id(i))));
        }
        try (ArchiveAdapter.Artifact artifact = prepare(adapter, contents())) {
            byte[] encoded = collect(artifact.openArchive());
            assertArrayEquals(fixtureBytes("tarBase64"), collect(new GZIPInputStream(new ByteArrayInputStream(encoded))));
            assertEquals(encoded.length, artifact.manifest.archive.sizeBytes);
            assertEquals(hash(encoded), artifact.manifest.archive.sha256);
            // 供 verify-archive-interop.mjs 使用 Windows 原生 receiver 复验 Java 产物。
            Path report = new java.io.File("build/reports/archive-interop").toPath();
            Files.createDirectories(report); Files.write(report.resolve("java.gz"), encoded);
        }
    }

    @Test public void unknownLengthEmptyAndLargeContentUseBoundedReadsAndMonotoneProgress() throws Exception {
        ArchiveAdapter adapter = adapter();
        byte[] large = new byte[131073]; new java.util.Random(13).nextBytes(large);
        java.util.Map<String, Long> counters = new java.util.HashMap<>();
        ArchiveModel.Progress progress = (stage, done, total) -> {
            assertTrue(done >= counters.getOrDefault(stage, 0L)); counters.put(stage, done);
            if (total != null) assertTrue(done <= total);
        };
        byte[] archive;
        ArchiveModel.Manifest manifest;
        try (ArchiveAdapter.Artifact artifact = prepare(adapter, new ArchiveControl(), progress, new byte[0], large)) {
            manifest = artifact.manifest; archive = collect(artifact.openArchive());
            assertEquals(large.length, manifest.totalFileBytes);
            assertThrows(UnsupportedOperationException.class, () -> manifest.files.clear());
        }
        counters.clear();
        try (ArchiveAdapter.Artifact received = adapter.receive(manifest, new ByteArrayInputStream(archive), new ArchiveControl(), progress)) {
            assertArrayEquals(large, collect(received.openFile("f000002")));
            assertArrayEquals(new byte[0], collect(received.openFile("f000001")));
        }
        ArchiveModel.Source bounded = new ArchiveModel.Source() {
            @Override public ArchiveModel.Observation observe(ArchiveControl control) throws Exception { return source(0, large, true).observe(control); }
            @Override public InputStream open(ArchiveControl control) {
                return new ByteArrayInputStream(large) {
                    @Override public synchronized int read(byte[] b, int off, int len) {
                        assertTrue(len <= 65536); return super.read(b, off, Math.min(len, 7));
                    }
                };
            }
        };
        try (ArchiveAdapter.Artifact ignored = adapter.prepare("t", "d", "r", Collections.singletonList(bounded), new ArchiveControl(), null)) {
            assertEquals(large.length, ignored.manifest.totalFileBytes);
        }
    }

    @Test public void windowsNativeArchiveIsConsumedByJavaWithIndependentContentExpectation() throws Exception {
        Path path = new java.io.File("build/reports/archive-interop/windows.gz").toPath();
        assertTrue("Run pnpm android:test to prepare Windows native output", Files.isRegularFile(path));
        byte[] bytes = Files.readAllBytes(path);
        try (ArchiveAdapter.Artifact artifact = adapter().receive(manifest(bytes), new ByteArrayInputStream(bytes), new ArchiveControl(), null)) {
            for (int i = 0; i < 3; i++) assertArrayEquals(contents()[i], collect(artifact.openFile(ArchiveModel.id(i))));
        }
        byte[] large = new byte[131073];
        for (int i = 0; i < large.length; i++) large[i] = (byte) (i * 31 + 7);
        byte[] compressed = Files.readAllBytes(new java.io.File("build/reports/archive-interop/windows-large.gz").toPath());
        ArchiveModel.PreparedFile file = new ArchiveModel.PreparedFile("f000001",
            new ArchiveModel.Observation("large", "large", null, "large.sav", null, null), large.length, hash(large));
        ArchiveModel.Manifest manifest = new ArchiveModel.Manifest("windows-large", "device", "root", Collections.singletonList(file),
            large.length, new ArchiveModel.Descriptor(compressed.length, 512 + ArchiveModel.padded(large.length) + 1024, hash(compressed)));
        try (ArchiveAdapter.Artifact artifact = adapter().receive(manifest, new ByteArrayInputStream(compressed), new ArchiveControl(), null)) {
            assertArrayEquals(large, collect(artifact.openFile("f000001")));
        }
    }

    @Test public void tarMemberNamesTypesEveryHeaderFieldPaddingAndTerminationAreStrict() throws Exception {
        ArchiveAdapter adapter = adapter();
        byte[] tar = fixtureBytes("tarBase64");
        // 覆盖名称/穿越、所有元数据字段、扩展/链接、prefix 及保留区；重算压缩体哈希。
        for (int offset : new int[] { 0, 7, 100, 107, 108, 116, 124, 135, 136, 148, 154, 155,
            156, 157, 257, 263, 265, 297, 329, 337, 345, 500, 1036, 3072 }) {
            byte[] changed = tar.clone(); changed[offset] ^= 1;
            reject(adapter, gzip(changed), "invalid-archive");
        }
        for (String name : new String[] { "../f001", "/f00001", "f000002" }) {
            byte[] changed = tar.clone(); Arrays.fill(changed, 0, 100, (byte) 0);
            System.arraycopy(name.getBytes(StandardCharsets.US_ASCII), 0, changed, 0, name.length());
            reject(adapter, gzip(changed), "invalid-archive");
        }
        for (byte type : new byte[] { 0, '1', '2', '3', '4', '5', '6', 'x', 'g', 'L', 'K', 'S' }) {
            byte[] changed = tar.clone(); changed[156] = type;
            reject(adapter, gzip(changed), "invalid-archive");
        }
        byte[] reordered = tar.clone();
        System.arraycopy(tar, 512, reordered, 0, 512);
        reject(adapter, gzip(reordered), "invalid-archive");
        reject(adapter, gzip(Arrays.copyOf(tar, 3072)), "invalid-archive");
        reject(adapter, gzip(Arrays.copyOf(tar, 4608)), "invalid-archive");
    }

    @Test public void gzipHeaderCrcIsizeDeflateConcatenationTrailingAndTruncationAreStrict() throws Exception {
        ArchiveAdapter adapter = adapter(); byte[] bytes = fixtureBytes("archiveBase64");
        for (int offset : new int[] { 0, 1, 2, 3, 4, 5, 6, 7, bytes.length - 8, bytes.length - 4 }) {
            byte[] changed = bytes.clone(); changed[offset] ^= 1;
            reject(adapter, changed, "invalid-archive");
        }
        byte[] deflate = bytes.clone(); deflate[10] = 7;
        reject(adapter, deflate, "invalid-archive");
        reject(adapter, Arrays.copyOf(bytes, bytes.length - 1), "invalid-archive");
        reject(adapter, Arrays.copyOf(bytes, 12), "invalid-archive");
        reject(adapter, Arrays.copyOf(bytes, bytes.length + 1), "invalid-archive");
        byte[] joined = Arrays.copyOf(bytes, bytes.length * 2);
        System.arraycopy(bytes, 0, joined, bytes.length, bytes.length);
        reject(adapter, joined, "invalid-archive");
        byte[] xflOs = bytes.clone(); xflOs[8] = 0; xflOs[9] = 3;
        try (ArchiveAdapter.Artifact ignored = adapter.receive(manifest(xflOs), new ByteArrayInputStream(xflOs), new ArchiveControl(), null)) {
            assertEquals(3, ignored.manifest.files.size());
        }
    }

    @Test public void archiveLengthHashAndEachRawFileHashAreAllRequired() throws Exception {
        ArchiveAdapter adapter = adapter(); byte[] bytes = fixtureBytes("archiveBase64");
        byte[] wrong = bytes.clone(); wrong[15] ^= 1;
        assertEquals("checksum-mismatch", assertThrows(ArchiveFailure.class,
            () -> adapter.receive(manifest(bytes), new ByteArrayInputStream(wrong), new ArchiveControl(), null)).code);
        for (byte[] input : new byte[][] { Arrays.copyOf(bytes, bytes.length - 1), Arrays.copyOf(bytes, bytes.length + 1) }) {
            assertEquals("checksum-mismatch", assertThrows(ArchiveFailure.class,
                () -> adapter.receive(manifest(bytes), new ByteArrayInputStream(input), new ArchiveControl(), null)).code);
        }
        byte[] tar = fixtureBytes("tarBase64"); tar[1024] ^= 1;
        reject(adapter, gzip(tar), "checksum-mismatch");
    }

    @Test public void requestAndManifestRejectInvalidIdsDuplicatesUnsafeMetadataAndLimits() throws Exception {
        ArchiveAdapter adapter = adapter();
        ArchiveModel.Source source = source(0, new byte[0], true);
        assertEquals("invalid-request", assertThrows(ArchiveFailure.class,
            () -> adapter.prepare("../outside", "d", "r", Collections.singletonList(source), new ArchiveControl(), null)).code);
        assertEquals("invalid-request", assertThrows(ArchiveFailure.class,
            () -> adapter.prepare("t", "d", "r", Arrays.asList(source, source), new ArchiveControl(), null)).code);
        ArchiveModel.Manifest good = manifest(fixtureBytes("archiveBase64"));
        List<ArchiveModel.PreparedFile> duplicated = Arrays.asList(good.files.get(0), good.files.get(0));
        assertThrows(ArchiveFailure.class, () -> new ArchiveModel.Manifest("t", "d", "r", duplicated, 0, good.archive).validate(new ArchiveModel.Limits()));
        assertThrows(ArchiveFailure.class, () -> new ArchiveModel.Manifest("t", "d", "r", good.files, 526, good.archive).validate(new ArchiveModel.Limits()));
        for (String name : new String[] { "", " ", "\ud800", "\udc00" }) {
            assertThrows(ArchiveFailure.class, () -> new ArchiveModel.Observation("i", "e", null, name, null, null).validate());
        }
        assertThrows(ArchiveFailure.class, () -> new ArchiveModel.Observation("i", "e", null, "n", -1L, null).validate());
        assertThrows(ArchiveFailure.class, () -> new ArchiveModel.Observation("i", "e", "e", "n", null, null).validate());
        assertThrows(IllegalArgumentException.class, () -> new ArchiveModel.Limits(1025, 1, 1, 1, 1, 1));
        assertThrows(IllegalArgumentException.class, () -> new ArchiveModel.Limits(1, 268435457L, 1, 1, 1, 1));
    }

    @Test public void sourceIdentityNameParentSizeAndModifiedChangesAreRejectedAfterClose() throws Exception {
        for (int changed = 0; changed < 6; changed++) {
            final int field = changed; AtomicBoolean closed = new AtomicBoolean();
            ArchiveAdapter adapter = adapter();
            ArchiveModel.Source source = new ArchiveModel.Source() {
                @Override public ArchiveModel.Observation observe(ArchiveControl control) {
                    boolean after = closed.get();
                    return new ArchiveModel.Observation(after && field == 0 ? "other" : "i",
                        after && field == 1 ? "other" : "e", after && field == 2 ? "other" : null,
                        after && field == 3 ? "other" : "存档", after && field == 4 ? 1L : null,
                        after && field == 5 ? 2L : null);
                }
                @Override public InputStream open(ArchiveControl control) {
                    return new ByteArrayInputStream(new byte[0]) { @Override public void close() { closed.set(true); } };
                }
            };
            assertEquals("source-changed", assertThrows(ArchiveFailure.class, () -> adapter.prepare("t", "d", "r",
                Collections.singletonList(source), new ArchiveControl(), null)).code);
            assertTrue(closed.get());
        }
    }

    @Test public void declaredSizeMustEqualActualCountEvenWhenBeforeAndAfterAgree() throws Exception {
        ArchiveAdapter adapter = adapter();
        ArchiveModel.Source source = new ArchiveModel.Source() {
            @Override public ArchiveModel.Observation observe(ArchiveControl control) { return new ArchiveModel.Observation("i", "e", null, "n", 0L, null); }
            @Override public InputStream open(ArchiveControl control) { return new ByteArrayInputStream(new byte[1]); }
        };
        assertEquals("source-changed", assertThrows(ArchiveFailure.class, () -> adapter.prepare("t", "d", "r",
            Collections.singletonList(source), new ArchiveControl(), null)).code);
    }

    @Test public void fileAndTotalActualStreamLimitsAcceptEqualityAndRejectOneMoreByte() throws Exception {
        for (boolean total : new boolean[] { false, true }) {
            ArchiveModel.Limits limits = new ArchiveModel.Limits(2, total ? 100 : 3, total ? 3 : 100, 10000, 10000, 10000);
            ArchiveAdapter adapter = adapter(limits, new ArchiveCache.Io() {});
            try (ArchiveAdapter.Artifact good = prepare(adapter, new byte[3])) { assertEquals(3, good.manifest.totalFileBytes); }
            assertEquals("resource-limit", assertThrows(ArchiveFailure.class, () -> prepare(adapter, new byte[4])).code);
        }
    }

    @Test public void fileCountAndTarLimitsAcceptEqualityAndRejectOneMore() throws Exception {
        ArchiveAdapter adapter = adapter(new ArchiveModel.Limits(1, 100, 100, 1536, 10000, 10000), new ArchiveCache.Io() {});
        try (ArchiveAdapter.Artifact good = prepare(adapter, new byte[0])) { assertEquals(1536, good.manifest.archive.tarSizeBytes); }
        assertEquals("resource-limit", assertThrows(ArchiveFailure.class, () -> prepare(adapter, new byte[1])).code);
        assertEquals("resource-limit", assertThrows(ArchiveFailure.class, () -> prepare(adapter, new byte[0], new byte[0])).code);
    }

    @Test public void compressedAndCacheBudgetsAreCountedOnActualWrites() throws Exception {
        byte[] bytes;
        try (ArchiveAdapter.Artifact initial = prepare(adapter(), contents())) { bytes = collect(initial.openArchive()); }
        for (boolean cache : new boolean[] { false, true }) {
            long exact = cache ? 525 + bytes.length : bytes.length;
            for (int delta : new int[] { 0, -1 }) {
                ArchiveModel.Limits limits = new ArchiveModel.Limits(3, 1000, 1000, 10000,
                    cache ? 10000 : exact + delta, cache ? exact + delta : 10000);
                ArchiveAdapter adapter = adapter(limits, new ArchiveCache.Io() {});
                if (delta == 0) {
                    try (ArchiveAdapter.Artifact good = prepare(adapter, contents())) { assertEquals(bytes.length, good.manifest.archive.sizeBytes); }
                } else assertEquals("resource-limit", assertThrows(ArchiveFailure.class, () -> prepare(adapter, contents())).code);
            }
        }
    }

    @Test public void inflationHasAnAbsoluteHardLimitIndependentOfIsizeAndRatio() throws Exception {
        ArchiveAdapter adapter = adapter(new ArchiveModel.Limits(3, 1000, 1000, 4096, 10000, 10000), new ArchiveCache.Io() {});
        byte[] bomb = gzip(Arrays.copyOf(fixtureBytes("tarBase64"), 100000));
        reject(adapter, bomb, "resource-limit");
        byte[] valid = fixtureBytes("archiveBase64");
        try (ArchiveAdapter.Artifact ignored = adapter.receive(manifest(valid), new ByteArrayInputStream(valid), new ArchiveControl(), null)) {
            assertEquals(525, ignored.manifest.totalFileBytes);
        }
    }

    @Test public void insufficientSpaceAndWriteFailureCloseSourcesAndCleanOwnedCache() throws Exception {
        AtomicBoolean fail = new AtomicBoolean(true); faults.add(fail);
        ArchiveAdapter adapter = adapter(new ArchiveModel.Limits(), new ArchiveCache.Io() {
            @Override public long usable(Path path) { return fail.get() ? 0 : Long.MAX_VALUE; }
        });
        assertEquals("insufficient-space", assertThrows(ArchiveFailure.class, () -> prepare(adapter, new byte[1])).code);
        fail.set(false);
        try (ArchiveAdapter.Artifact ignored = prepare(adapter, new byte[1])) { assertEquals(1, ignored.manifest.totalFileBytes); }
        AtomicBoolean closed = new AtomicBoolean();
        ArchiveAdapter broken = adapter(new ArchiveModel.Limits(), new ArchiveCache.Io() {
            @Override public void beforeWrite(Path path, int n) throws IOException { throw new IOException("Injected disk write failure"); }
        });
        ArchiveModel.Source source = new ArchiveModel.Source() {
            @Override public ArchiveModel.Observation observe(ArchiveControl control) throws Exception { return source(0, new byte[1], true).observe(control); }
            @Override public InputStream open(ArchiveControl control) {
                return new ByteArrayInputStream(new byte[1]) { @Override public void close() { closed.set(true); } };
            }
        };
        assertEquals("io-failure", assertThrows(ArchiveFailure.class, () -> broken.prepare("t", "d", "r",
            Collections.singletonList(source), new ArchiveControl(), null)).code);
        assertTrue(closed.get());
    }

    @Test public void cancellationAtEveryStageClosesInputAndAllowsNextTaskAfterCleanup() throws Exception {
        for (String stage : new String[] { "preparing", "archiving", "receiving", "verifying" }) {
            ArchiveAdapter adapter = adapter(); ArchiveControl control = new ArchiveControl();
            ArchiveModel.Progress progress = (current, done, total) -> { if (current.equals(stage)) control.cancel(); };
            ArchiveFailure failure;
            if (stage.equals("preparing") || stage.equals("archiving")) {
                failure = assertThrows(ArchiveFailure.class, () -> prepare(adapter, control, progress, contents()));
            } else {
                byte[] bytes = fixtureBytes("archiveBase64");
                AtomicBoolean closed = new AtomicBoolean();
                InputStream input = new ByteArrayInputStream(bytes) { @Override public void close() { closed.set(true); } };
                failure = assertThrows(ArchiveFailure.class, () -> adapter.receive(manifest(bytes), input, control, progress));
                assertTrue(closed.get());
            }
            assertTrue(failure.cancelled); assertNull(failure.cleanupFailure);
            try (ArchiveAdapter.Artifact good = prepare(adapter, new byte[0])) { assertEquals(0, good.manifest.totalFileBytes); }
        }
    }

    @Test public void timeoutDoesNotResetWithProgressAndCleansCache() throws Exception {
        ArchiveAdapter adapter = adapter(); AtomicLong clock = new AtomicLong();
        ArchiveControl control = new ArchiveControl(clock::get, 100);
        ArchiveFailure failure = assertThrows(ArchiveFailure.class, () -> prepare(adapter, control,
            (stage, done, total) -> clock.addAndGet(60), new byte[10]));
        assertEquals("timeout", failure.code); assertFalse(failure.cancelled);
        try (ArchiveAdapter.Artifact ignored = prepare(adapter, new byte[0])) { assertNotNull(ignored); }
    }

    @Test public void lifecycleCancelClosesABlockedNativeStreamWithoutWaitingForNextRead() throws Exception {
        ArchiveAdapter adapter = adapter(); CountDownLatch reading = new CountDownLatch(1);
        CountDownLatch closed = new CountDownLatch(1); AtomicReference<Throwable> failure = new AtomicReference<>();
        ArchiveModel.Source source = new ArchiveModel.Source() {
            @Override public ArchiveModel.Observation observe(ArchiveControl control) throws Exception { return source(0, new byte[0], true).observe(control); }
            @Override public InputStream open(ArchiveControl control) {
                return new InputStream() {
                    @Override public int read() throws IOException {
                        reading.countDown();
                        try { if (!closed.await(5, TimeUnit.SECONDS)) throw new IOException("Cancellation did not close source"); }
                        catch (InterruptedException cause) { throw new IOException(cause); }
                        throw new IOException("Closed");
                    }
                    @Override public void close() { closed.countDown(); }
                };
            }
        };
        Thread worker = new Thread(() -> {
            try { adapter.prepare("t", "d", "r", Collections.singletonList(source), new ArchiveControl(), null); }
            catch (Throwable cause) { failure.set(cause); }
        });
        worker.start(); assertTrue(reading.await(5, TimeUnit.SECONDS)); adapter.cancel(); worker.join(5000);
        assertFalse(worker.isAlive()); assertTrue(failure.get() instanceof ArchiveFailure);
        assertTrue(((ArchiveFailure) failure.get()).cancelled);
    }

    @Test public void cleanupFailurePreservesPrimaryErrorAndBlocksNewTasksUntilRetry() throws Exception {
        AtomicBoolean fail = new AtomicBoolean(true); faults.add(fail);
        ArchiveAdapter adapter = adapter(new ArchiveModel.Limits(), new ArchiveCache.Io() {
            @Override public void beforeDelete(Path path) throws IOException { if (fail.get()) throw new IOException("Injected cleanup"); }
        });
        byte[] broken = fixtureBytes("archiveBase64"); broken[0] = 0;
        ArchiveFailure failure = assertThrows(ArchiveFailure.class,
            () -> adapter.receive(manifest(broken), new ByteArrayInputStream(broken), new ArchiveControl(), null));
        assertEquals("invalid-archive", failure.code); assertEquals("cleanup-failed", failure.cleanupFailure.code);
        assertEquals("busy", assertThrows(ArchiveFailure.class, () -> prepare(adapter, new byte[0])).code);
        fail.set(false); adapter.retryCleanup(); adapter.retryCleanup();
        try (ArchiveAdapter.Artifact good = prepare(adapter, new byte[0])) { assertNotNull(good); }
    }

    @Test public void handlesCannotCrossTasksAndOpenReadersPreventPrematureCleanup() throws Exception {
        ArchiveAdapter adapter = adapter(); ArchiveAdapter.Artifact artifact = prepare(adapter, new byte[0]);
        InputStream input = artifact.openArchive();
        assertEquals("cleanup-failed", assertThrows(ArchiveFailure.class, artifact::close).code);
        assertEquals("busy", assertThrows(ArchiveFailure.class, () -> prepare(adapter, new byte[0])).code);
        assertThrows(ArchiveFailure.class, () -> artifact.openFile("../../outside"));
        assertThrows(ArchiveFailure.class, () -> artifact.openFile("f000002"));
        input.close(); artifact.close(); artifact.close();
        assertEquals("task-conflict", assertThrows(ArchiveFailure.class, artifact::openArchive).code);
        try (ArchiveAdapter.Artifact next = prepare(adapter, new byte[0])) { assertNotNull(next); }
    }

    @Test public void cacheRecoveryOnlyRemovesVerifiedOrphansAndNeverUnknownFiles() throws Exception {
        Path parent = temporary.newFolder().toPath(); ArchiveCache cache = new ArchiveCache(parent);
        Path root = parent.resolve("transfer-archives-v1");
        String owner = new String(Files.readAllBytes(root.resolve("owner")), StandardCharsets.US_ASCII);
        String token = UUID.randomUUID().toString(); Path job = Files.createDirectory(root.resolve("job-" + token));
        Files.write(job.resolve("owner"), (owner + ":" + token).getBytes(StandardCharsets.US_ASCII));
        Files.write(job.resolve("f000001"), new byte[1]);
        new ArchiveCache(parent); assertFalse(Files.exists(job));
        Path unknown = root.resolve("unknown"); Files.write(unknown, new byte[1]);
        assertThrows(ArchiveFailure.class, () -> new ArchiveCache(parent)); assertTrue(Files.exists(unknown));
        Files.delete(unknown);
        ArchiveCache.Job active = cache.begin(1000); active.dispose();
    }

    @Test public void rootOwnershipTamperingBlocksCleanupAndRestoringMarkerAllowsRetry() throws Exception {
        Path parent = temporary.newFolder().toPath(); ArchiveCache cache = new ArchiveCache(parent);
        ArchiveAdapter adapter = new ArchiveAdapter(cache); adapters.add(adapter);
        ArchiveAdapter.Artifact artifact = prepare(adapter, new byte[1]);
        Path marker = parent.resolve("transfer-archives-v1/owner"); byte[] original = Files.readAllBytes(marker);
        Files.write(marker, "foreign".getBytes(StandardCharsets.US_ASCII));
        assertEquals("cleanup-failed", assertThrows(ArchiveFailure.class, artifact::close).code);
        Files.write(marker, original); artifact.close();
    }

    @Test public void zeroProgressAndInvalidManifestCloseIncomingStreamWithoutPublishing() throws Exception {
        ArchiveAdapter adapter = adapter(); byte[] bytes = fixtureBytes("archiveBase64"); AtomicBoolean closed = new AtomicBoolean();
        InputStream noProgress = new ByteArrayInputStream(bytes) {
            @Override public synchronized int read(byte[] b, int off, int len) { return 0; }
            @Override public void close() { closed.set(true); }
        };
        assertEquals("io-failure", assertThrows(ArchiveFailure.class,
            () -> adapter.receive(manifest(bytes), noProgress, new ArchiveControl(), null)).code);
        assertTrue(closed.get()); closed.set(false);
        InputStream invalid = new ByteArrayInputStream(bytes) { @Override public void close() { closed.set(true); } };
        assertEquals("invalid-request", assertThrows(ArchiveFailure.class,
            () -> adapter.receive(null, invalid, new ArchiveControl(), null)).code);
        assertTrue(closed.get());
    }

    @Test public void processWideExclusivityAndConcurrentDisposeKeepOneOwner() throws Exception {
        ArchiveAdapter first = adapter(); ArchiveAdapter second = adapter();
        ArchiveAdapter.Artifact artifact = prepare(first, new byte[0]);
        assertEquals("busy", assertThrows(ArchiveFailure.class, () -> prepare(second, new byte[0])).code);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Runnable dispose = () -> { try { artifact.close(); } catch (Throwable cause) { failure.set(cause); } };
        Thread a = new Thread(dispose); Thread b = new Thread(dispose);
        a.start(); b.start(); a.join(5000); b.join(5000);
        assertFalse(a.isAlive()); assertFalse(b.isAlive()); assertNull(failure.get());
        try (ArchiveAdapter.Artifact next = prepare(second, new byte[0])) { assertNotNull(next); }
    }

    @Test public void orphanCleanupFailureRetainsSlotAndCanBeRetriedWithoutResumingOldTask() throws Exception {
        Path parent = temporary.newFolder().toPath(); new ArchiveCache(parent);
        Path root = parent.resolve("transfer-archives-v1");
        String owner = new String(Files.readAllBytes(root.resolve("owner")), StandardCharsets.US_ASCII);
        String token = UUID.randomUUID().toString(); Path job = Files.createDirectory(root.resolve("job-" + token));
        Files.write(job.resolve("owner"), (owner + ":" + token).getBytes(StandardCharsets.US_ASCII));
        Files.write(job.resolve("f000001"), new byte[1]);
        AtomicBoolean fail = new AtomicBoolean(true); faults.add(fail);
        assertEquals("cleanup-failed", assertThrows(ArchiveFailure.class, () -> new ArchiveCache(parent, new ArchiveCache.Io() {
            @Override public void beforeDelete(Path path) throws IOException { if (fail.get()) throw new IOException("Orphan cleanup"); }
        })).code);
        assertEquals("busy", assertThrows(ArchiveFailure.class, () -> new ArchiveCache(parent)).code);
        assertTrue(Files.exists(job)); fail.set(false); ArchiveCache.retryOrphanCleanup();
        assertFalse(Files.exists(job)); new ArchiveCache(parent);
    }

    @Test public void failedDirectoryRemovalCanRetryAfterOwnerMarkerWasAlreadyRemoved() throws Exception {
        AtomicBoolean fail = new AtomicBoolean(true); faults.add(fail);
        ArchiveAdapter adapter = adapter(new ArchiveModel.Limits(), new ArchiveCache.Io() {
            @Override public void beforeDelete(Path path) throws IOException {
                if (fail.get() && path.getFileName().toString().startsWith("job-")) throw new IOException("Directory removal");
            }
        });
        ArchiveAdapter.Artifact artifact = prepare(adapter, new byte[0]);
        assertEquals("cleanup-failed", assertThrows(ArchiveFailure.class, artifact::close).code);
        fail.set(false); artifact.close();
        try (ArchiveAdapter.Artifact next = prepare(adapter, new byte[0])) { assertNotNull(next); }
    }
}
