package io.github.galgame.savedatasync;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

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
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** 归档测试：格式按独立的 Python 期望核对，并覆盖实际 IO 和受控故障。 */
public class ArchiveAdapterTest {

  @Rule
  public TemporaryFolder temporary = new TemporaryFolder();

  private final List<ArchiveAdapter> adapters = new ArrayList<>();
  private final List<AtomicBoolean> faults = new ArrayList<>();

  @After
  public void cleanup() throws Exception {
    for (AtomicBoolean fault : faults) {
      fault.set(false);
    }
    for (ArchiveAdapter adapter : adapters) {
      adapter.retryCleanup();
    }
    ArchiveCache.retryOrphanCleanup();
  }

  private ArchiveAdapter adapter() throws Exception {
    return adapter(new ArchiveModel.Limits(), new ArchiveCache.Io() {});
  }

  private ArchiveAdapter adapter(ArchiveModel.Limits limits, ArchiveCache.Io io) throws Exception {
    ArchiveAdapter result = new ArchiveAdapter(
      new ArchiveCache(temporary.newFolder().toPath(), io),
      limits
    );
    adapters.add(result);
    return result;
  }

  private static ArchiveModel.Source source(int i, byte[] bytes) {
    return new ArchiveModel.Source() {
      @Override
      public ArchiveModel.Observation observe(ArchiveControl control) {
        return new ArchiveModel.Observation(
          "identity-" + i,
          "entry-" + i,
          i % 2 == 0 ? null : "parent-1",
          "存档 😀 " + i + ".sav",
          (long) bytes.length,
          null
        );
      }

      @Override
      public InputStream open(ArchiveControl control) {
        return new ByteArrayInputStream(bytes);
      }
    };
  }

  private static List<ArchiveAdapter.Outgoing> outgoing(List<ArchiveModel.Source> sources)
    throws Exception {
    List<ArchiveAdapter.Outgoing> files = new ArrayList<>();
    for (ArchiveModel.Source source : sources) {
      ArchiveModel.Observation observed = source.observe(new ArchiveControl());
      files.add(new ArchiveAdapter.Outgoing(source, observed.entryId, observed.size, null));
    }
    return files;
  }

  private static byte[] send(
    ArchiveAdapter adapter,
    ArchiveControl control,
    ArchiveModel.Progress progress,
    byte[]... contents
  ) throws Exception {
    List<ArchiveModel.Source> sources = new ArrayList<>();
    for (int i = 0; i < contents.length; i++) {
      sources.add(source(i, contents[i]));
    }
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    adapter.sendFiles(outgoing(sources), output, control, progress);
    return output.toByteArray();
  }

  private static List<Long> sizes(byte[]... contents) {
    List<Long> result = new ArrayList<>();
    for (byte[] content : contents) {
      result.add((long) content.length);
    }
    return result;
  }

  private static byte[] collect(InputStream input) throws IOException {
    try (InputStream stream = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[ArchiveModel.BUFFER];
      int n;
      while ((n = stream.read(buffer)) != -1) {
        out.write(buffer, 0, n);
      }
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
    assertTrue(match.find());
    return Base64.getDecoder().decode(match.group(1));
  }

  private static byte[][] contents() {
    byte[] binary = new byte[513];
    for (int i = 0; i < 512; i++) {
      binary[i] = (byte) i;
    }
    binary[512] = '!';
    return new byte[][] { new byte[0], "固定夹具".getBytes(StandardCharsets.UTF_8), binary };
  }

  private static byte[] gzip(byte[] bytes) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    try (ArchiveFormat.GzipWriter gzip = new ArchiveFormat.GzipWriter(out)) {
      gzip.write(bytes);
    }
    return out.toByteArray();
  }

  private static ArchiveAdapter.Staged receive(ArchiveAdapter adapter, byte[] bytes)
    throws Exception {
    return adapter.receiveFiles(
      sizes(contents()),
      new ByteArrayInputStream(bytes),
      new ArchiveControl(),
      null
    );
  }

  private static void reject(ArchiveAdapter adapter, byte[] bytes, String code) {
    ArchiveFailure failure = assertThrows(ArchiveFailure.class, () -> receive(adapter, bytes));
    assertEquals(code, failure.code);
    assertNull(failure.cleanupFailure);
  }

  @Test
  public void pythonFixtureDecodesAndJavaWriterMatchesExactIndependentTar() throws Exception {
    ArchiveAdapter adapter = adapter();
    byte[] bytes = fixtureBytes("archiveBase64");
    assertEquals(438, bytes.length);
    try (ArchiveAdapter.Staged staged = receive(adapter, bytes)) {
      for (int i = 0; i < 3; i++) {
        assertArrayEquals(contents()[i], collect(staged.openFile(ArchiveModel.id(i))));
      }
    }
    byte[] encoded = send(adapter, new ArchiveControl(), null, contents());
    assertArrayEquals(
      fixtureBytes("tarBase64"),
      collect(new GZIPInputStream(new ByteArrayInputStream(encoded)))
    );
    // 供 verify-archive-interop.mjs 用桌面端的接收实现复验 Java 产物。
    Path report = new java.io.File("build/reports/archive-interop").toPath();
    Files.createDirectories(report);
    Files.write(report.resolve("java.gz"), encoded);
  }

  @Test
  public void emptyAndLargeContentRoundTripWithBoundedReadsAndMonotoneProgress() throws Exception {
    ArchiveAdapter adapter = adapter();
    byte[] large = new byte[131073];
    new java.util.Random(13).nextBytes(large);
    long[] last = { 0 };
    ArchiveModel.Progress progress = (stage, done, total) -> {
      assertEquals("transferring", stage);
      assertTrue(done >= last[0]);
      last[0] = done;
      if (total != null) {
        assertTrue(done <= total);
      }
    };
    byte[] archive = send(adapter, new ArchiveControl(), progress, new byte[0], large);
    assertEquals(large.length, last[0]);
    last[0] = 0;
    try (
      ArchiveAdapter.Staged staged = adapter.receiveFiles(
        sizes(new byte[0], large),
        new ByteArrayInputStream(archive),
        new ArchiveControl(),
        progress
      )
    ) {
      assertEquals(large.length, last[0]);
      assertArrayEquals(large, collect(staged.openFile("f000002")));
      assertArrayEquals(new byte[0], collect(staged.openFile("f000001")));
    }
    ArchiveModel.Source bounded = new ArchiveModel.Source() {
      @Override
      public ArchiveModel.Observation observe(ArchiveControl control) throws Exception {
        return source(0, large).observe(control);
      }

      @Override
      public InputStream open(ArchiveControl control) {
        return new ByteArrayInputStream(large) {
          @Override
          public synchronized int read(byte[] b, int off, int len) {
            assertTrue(len <= 65536);
            return super.read(b, off, Math.min(len, 7));
          }
        };
      }
    };
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    adapter.sendFiles(
      outgoing(Collections.singletonList(bounded)),
      output,
      new ArchiveControl(),
      null
    );
    byte[] tar = collect(new GZIPInputStream(new ByteArrayInputStream(output.toByteArray())));
    assertArrayEquals(large, Arrays.copyOfRange(tar, 512, 512 + large.length));
  }

  @Test
  public void tarMemberNamesTypesEveryHeaderFieldPaddingAndTerminationAreStrict() throws Exception {
    ArchiveAdapter adapter = adapter();
    byte[] tar = fixtureBytes("tarBase64");
    // 覆盖名称和路径穿越、所有元数据字段、扩展和链接、prefix、保留区、填充和结束块。
    for (int offset : new int[] {
      0,
      7,
      100,
      107,
      108,
      116,
      124,
      135,
      136,
      148,
      154,
      155,
      156,
      157,
      257,
      263,
      265,
      297,
      329,
      337,
      345,
      500,
      1036,
      3072,
    }) {
      byte[] changed = tar.clone();
      changed[offset] ^= 1;
      reject(adapter, gzip(changed), "invalid-archive");
    }
    for (String name : new String[] { "../f001", "/f00001", "f000002" }) {
      byte[] changed = tar.clone();
      Arrays.fill(changed, 0, 100, (byte) 0);
      System.arraycopy(name.getBytes(StandardCharsets.US_ASCII), 0, changed, 0, name.length());
      reject(adapter, gzip(changed), "invalid-archive");
    }
    for (byte type : new byte[] { 0, '1', '2', '3', '4', '5', '6', 'x', 'g', 'L', 'K', 'S' }) {
      byte[] changed = tar.clone();
      changed[156] = type;
      reject(adapter, gzip(changed), "invalid-archive");
    }
    byte[] reordered = tar.clone();
    System.arraycopy(tar, 512, reordered, 0, 512);
    reject(adapter, gzip(reordered), "invalid-archive");
    reject(adapter, gzip(Arrays.copyOf(tar, 3072)), "invalid-archive");
    reject(adapter, gzip(Arrays.copyOf(tar, 4608)), "invalid-archive");
  }

  @Test
  public void gzipHeaderCrcIsizeDeflateConcatenationTrailingAndTruncationAreStrict()
    throws Exception {
    ArchiveAdapter adapter = adapter();
    byte[] bytes = fixtureBytes("archiveBase64");
    for (int offset : new int[] { 0, 1, 2, 3, 4, 5, 6, 7, bytes.length - 8, bytes.length - 4 }) {
      byte[] changed = bytes.clone();
      changed[offset] ^= 1;
      reject(adapter, changed, "invalid-archive");
    }
    byte[] deflate = bytes.clone();
    deflate[10] = 7;
    reject(adapter, deflate, "invalid-archive");
    reject(adapter, Arrays.copyOf(bytes, bytes.length - 1), "invalid-archive");
    reject(adapter, Arrays.copyOf(bytes, 12), "invalid-archive");
    reject(adapter, Arrays.copyOf(bytes, bytes.length + 1), "invalid-archive");
    byte[] joined = Arrays.copyOf(bytes, bytes.length * 2);
    System.arraycopy(bytes, 0, joined, bytes.length, bytes.length);
    reject(adapter, joined, "invalid-archive");
    byte[] xflOs = bytes.clone();
    xflOs[8] = 0;
    xflOs[9] = 3;
    try (ArchiveAdapter.Staged staged = receive(adapter, xflOs)) {
      assertArrayEquals(contents()[1], collect(staged.openFile("f000002")));
    }
  }

  @Test
  public void fileAndTotalLimitsAcceptEqualityAndRejectOneMoreByte() throws Exception {
    byte[] three = send(adapter(), new ArchiveControl(), null, new byte[3]);
    byte[] four = send(adapter(), new ArchiveControl(), null, new byte[4]);
    for (boolean isTotalLimit : new boolean[] { false, true }) {
      ArchiveModel.Limits limits = new ArchiveModel.Limits(
        2,
        isTotalLimit ? 100 : 3,
        isTotalLimit ? 3 : 100,
        10000,
        10000
      );
      ArchiveAdapter adapter = adapter(limits, new ArchiveCache.Io() {});
      try (
        ArchiveAdapter.Staged good = adapter.receiveFiles(
          sizes(new byte[3]),
          new ByteArrayInputStream(three),
          new ArchiveControl(),
          null
        )
      ) {
        assertNotNull(good);
      }
      assertEquals(
        "resource-limit",
        assertThrows(ArchiveFailure.class, () ->
          adapter.receiveFiles(
            sizes(new byte[4]),
            new ByteArrayInputStream(four),
            new ArchiveControl(),
            null
          )
        ).code
      );
    }
    ArchiveAdapter small = adapter(
      new ArchiveModel.Limits(2, 3, 100, 10000, 10000),
      new ArchiveCache.Io() {}
    );
    assertEquals(
      "resource-limit",
      assertThrows(ArchiveFailure.class, () ->
        send(small, new ArchiveControl(), null, new byte[4])
      ).code
    );
  }

  @Test
  public void cancellationWhileSendingOrReceivingClosesInputAndAllowsNextTask() throws Exception {
    for (boolean isReceiving : new boolean[] { false, true }) {
      ArchiveAdapter adapter = adapter();
      ArchiveControl control = new ArchiveControl();
      ArchiveModel.Progress progress = (stage, done, total) -> control.cancel();
      ArchiveFailure failure;
      if (isReceiving) {
        byte[] bytes = fixtureBytes("archiveBase64");
        AtomicBoolean closed = new AtomicBoolean();
        InputStream input = new ByteArrayInputStream(bytes) {
          @Override
          public void close() {
            closed.set(true);
          }
        };
        failure = assertThrows(ArchiveFailure.class, () ->
          adapter.receiveFiles(sizes(contents()), input, control, progress)
        );
        assertTrue(closed.get());
      } else {
        failure = assertThrows(ArchiveFailure.class, () ->
          send(adapter, control, progress, contents())
        );
      }
      assertTrue(failure.isCancelled);
      assertNull(failure.cleanupFailure);
      try (ArchiveAdapter.Staged good = receive(adapter, fixtureBytes("archiveBase64"))) {
        assertNotNull(good);
      }
    }
  }

  @Test
  public void cleanupFailurePreservesPrimaryErrorAndBlocksNewTasksUntilRetry() throws Exception {
    AtomicBoolean fail = new AtomicBoolean(true);
    faults.add(fail);
    ArchiveAdapter adapter = adapter(
      new ArchiveModel.Limits(),
      new ArchiveCache.Io() {
        @Override
        public void beforeDelete(Path path) throws IOException {
          if (fail.get()) {
            throw new IOException("Injected cleanup");
          }
        }
      }
    );
    byte[] good = fixtureBytes("archiveBase64");
    byte[] broken = good.clone();
    broken[0] = 0;
    ArchiveFailure failure = assertThrows(ArchiveFailure.class, () -> receive(adapter, broken));
    assertEquals("invalid-archive", failure.code);
    assertEquals("cleanup-failed", failure.cleanupFailure.code);
    assertEquals("busy", assertThrows(ArchiveFailure.class, () -> receive(adapter, good)).code);
    fail.set(false);
    adapter.retryCleanup();
    adapter.retryCleanup();
    try (ArchiveAdapter.Staged staged = receive(adapter, good)) {
      assertNotNull(staged);
    }
  }
}
