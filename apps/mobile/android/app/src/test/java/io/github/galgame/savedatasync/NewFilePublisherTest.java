package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.PublicationModel.Document;
import static io.github.galgame.savedatasync.PublicationModel.Entry;
import static io.github.galgame.savedatasync.PublicationModel.Request;
import static io.github.galgame.savedatasync.PublicationModel.Result;
import static io.github.galgame.savedatasync.PublicationModel.nameKey;
import static io.github.galgame.savedatasync.PublicationModel.portableName;
import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.After;
import org.junit.Test;

/** 用受控故障测试发布状态和所有权。 */
public class NewFilePublisherTest {

  private final List<NewFilePublisher> publishers = new ArrayList<>();
  private final List<Fake> backends = new ArrayList<>();
  private static final byte[] BYTES = { 1, 2, 3, 4 };

  private static final class Node {

    String id;
    String name;
    byte[] bytes = {};
    boolean isDirectory;
    boolean isVirtual;

    Node(String id, String name) {
      this.id = id;
      this.name = name;
    }

    Document document() {
      return new Document(id, name, isDirectory, isVirtual, (long) bytes.length, 123L);
    }
  }

  private static class Fake implements NewFilePublisher.Backend, NewFilePublisher.Directory {

    final Map<String, Node> nodes = new LinkedHashMap<>();
    boolean hasPermission = true;
    boolean shouldRename;
    boolean useExistingId;
    boolean isMissing;
    boolean useWrongType;
    boolean shouldChangeIdentity;
    boolean shouldFailCleanup;
    boolean shouldFailClose;
    boolean isClosed;
    String createError;
    String writeError;
    int creates;
    int writes;
    int deletes;
    int opens;
    long modified = 123L;
    Runnable creating;
    Runnable closing;

    Node add(String id, String name, byte[] bytes) {
      Node node = new Node(id, name);
      node.bytes = bytes.clone();
      nodes.put(id, node);
      return node;
    }

    @Override
    public NewFilePublisher.Directory locate(String root, String parent, ArchiveControl control)
      throws Exception {
      control.check();
      if (!hasPermission) {
        throw new ArchiveFailure("authorization-expired", "模拟撤权");
      }
      if (!"root-1".equals(root) || (parent != null && !"parent-1".equals(parent))) {
        throw new ArchiveFailure("not-found", "模拟越界引用");
      }
      return this;
    }

    @Override
    public List<Document> children(NewFilePublisher.Directory directory, ArchiveControl control)
      throws Exception {
      control.check();
      List<Document> result = new ArrayList<>();
      for (Node n : nodes.values()) {
        result.add(n.document());
      }
      return result;
    }

    @Override
    public String create(NewFilePublisher.Directory directory, String name) throws Exception {
      creates++;
      if (creating != null) {
        creating.run();
      }
      // 和 SAF 提供者一样，已有同名或等价名称时换个名字创建。
      boolean isTaken = false;
      for (Node n : nodes.values()) {
        isTaken |= nameKey(n.name).equals(nameKey(name));
      }
      Node node = add(
        "new-" + creates,
        shouldRename || isTaken ? name + " (1)" : name,
        new byte[0]
      );
      node.isDirectory = useWrongType;
      if (createError != null) {
        throw new ArchiveFailure(createError, "模拟创建结果丢失");
      }
      return useExistingId ? "existing" : isMissing ? "absent" : node.id;
    }

    @Override
    public Document document(
      NewFilePublisher.Directory directory,
      String id,
      ArchiveControl control
    ) throws Exception {
      control.check();
      Node node = nodes.get(id);
      return node == null ? null : node.document();
    }

    @Override
    public NewFilePublisher.Owned claim(NewFilePublisher.Directory directory, Document document) {
      Node node = nodes.get(document.id);
      return new NewFilePublisher.Owned() {
        boolean isDeleted;

        @Override
        public OutputStream openOutput(long size, ArchiveControl control) throws Exception {
          opens++;
          verify(control);
          return new ByteArrayOutputStream() {
            @Override
            public void write(byte[] bytes, int offset, int length) {
              writes++;
              super.write(bytes, offset, length);
            }

            @Override
            public void close() throws IOException {
              node.bytes = toByteArray();
              if (writeError != null) {
                String code = writeError;
                writeError = null;
                throw new ArchiveFailure(code, "模拟写入失败");
              }
            }
          };
        }

        @Override
        public void verify(ArchiveControl control) throws Exception {
          control.check();
          if (shouldChangeIdentity) {
            throw new ArchiveFailure("result-unknown", "模拟替换");
          }
        }

        @Override
        public Entry entry(ArchiveControl control) throws Exception {
          control.check();
          return new Entry(
            "root-1",
            null,
            "public-" + node.id,
            node.name,
            (long) node.bytes.length,
            modified
          );
        }

        @Override
        public void delete() throws Exception {
          if (isDeleted) {
            return;
          }
          if (shouldFailCleanup || shouldChangeIdentity) {
            throw new IOException("模拟清理失败");
          }
          deletes++;
          nodes.remove(node.id);
          isDeleted = true;
        }

        @Override
        public void close() throws IOException {
          if (closing != null) {
            closing.run();
          }
          if (shouldFailClose) {
            throw new IOException("模拟句柄关闭失败");
          }
          isClosed = true;
        }
      };
    }
  }

  private NewFilePublisher publisher(Fake backend) throws Exception {
    NewFilePublisher p = new NewFilePublisher(backend);
    publishers.add(p);
    backends.add(backend);
    p.grant("root-1");
    return p;
  }

  private static String hash(byte[] bytes) {
    return NewFilePublisher.hex(ArchiveFormat.sha256().digest(bytes));
  }

  private static Request request(String name, byte[] bytes) {
    return new Request("f000001", "root-1", null, name, bytes.length, hash(bytes));
  }

  private Result run(NewFilePublisher p, byte[] bytes) throws Exception {
    return p.publish(
      request("存档 😀.sav", bytes),
      () -> new ByteArrayInputStream(bytes),
      null,
      new ArchiveControl()
    );
  }

  /** 输入内容与请求的哈希不同。 */
  private Result runMismatch(NewFilePublisher p) throws Exception {
    byte[] other = BYTES.clone();
    other[0] ^= 1;
    return p.publish(
      request("存档 😀.sav", BYTES),
      () -> new ByteArrayInputStream(other),
      null,
      new ArchiveControl()
    );
  }

  @After
  public void cleanup() {
    for (Fake b : backends) {
      b.shouldFailCleanup = false;
      b.shouldChangeIdentity = false;
      b.shouldFailClose = false;
      b.writeError = null;
      b.closing = null;
    }
    for (NewFilePublisher p : publishers) {
      assertTrue(p.stop());
    }
  }

  @Test
  public void succeedsAfterWriteCloseAndMatchingHash() throws Exception {
    Fake b = new Fake();
    NewFilePublisher p = publisher(b);
    List<String> stages = new ArrayList<>();
    Result result = p.publish(
      request("存档.sav", BYTES),
      () -> new ByteArrayInputStream(BYTES),
      (stage, count, total) -> {
        assertEquals(4L, total.longValue());
        stages.add(stage);
      },
      new ArchiveControl()
    );
    assertEquals("succeeded", result.status);
    assertEquals("complete", result.cleanup);
    assertEquals(4, result.bytesWritten);
    assertEquals(hash(BYTES), result.sha256);
    assertEquals("存档.sav", result.entry.name);
    assertTrue(result.residualEntries.isEmpty());
    assertArrayEquals(BYTES, b.nodes.get("new-1").bytes);
    assertEquals(0, b.deletes);
    assertEquals(Arrays.asList("writing"), stages);
    assertTrue(b.isClosed);
  }

  @Test
  public void rejectsUnsafeNamesAndMalformedRequestsBeforeMutation() throws Exception {
    Fake b = new Fake();
    NewFilePublisher p = publisher(b);
    for (String name : new String[] {
      "",
      ".",
      "..",
      "a/b",
      "a\\b",
      "CON",
      "nul.sav",
      "com¹.foo",
      "a ",
      "a.",
      "a\u0000b",
      "a\u007fb",
      "a\ud800",
      "a?b",
    }) {
      ArchiveFailure f = assertThrows(ArchiveFailure.class, () ->
        p.publish(
          request(name, BYTES),
          () -> new ByteArrayInputStream(BYTES),
          null,
          new ArchiveControl()
        )
      );
      assertEquals(name, "invalid-request", f.code);
    }
    for (Request r : Arrays.asList(
      new Request("bad/", "root-1", null, "a", 0, hash(BYTES)),
      new Request("f000001", "root-1", "../", "a", 0, hash(BYTES)),
      new Request("f000001", "root-1", null, "a", -1, hash(BYTES)),
      new Request("f000001", "root-1", null, "a", 0, "BAD"),
      new Request("f000001", "root-1", null, "a", 268435457L, hash(BYTES)),
      new Request("f1", "root-1", null, "a", 0, hash(BYTES)),
      new Request("f000000", "root-1", null, "a", 0, hash(BYTES)),
      new Request("f001025", "root-1", null, "a", 0, hash(BYTES))
    )) {
      assertThrows(ArchiveFailure.class, () ->
        p.publish(r, () -> new ByteArrayInputStream(BYTES), null, new ArchiveControl())
      );
    }
    assertTrue(portableName("存档😀.sav"));
    assertEquals(0, b.creates);
  }

  @Test
  public void renamedCreationIsRemovedWithoutTouchingExistingFile() throws Exception {
    for (String name : new String[] { "存档 😀.sav", "存档 😀.SAV" }) {
      Fake b = new Fake();
      b.add("existing", name, BYTES);
      NewFilePublisher p = publisher(b);
      assertEquals("name-conflict", run(p, BYTES).errorCode);
      assertEquals(0, b.opens);
      assertEquals(1, b.deletes);
      assertEquals(1, b.nodes.size());
      assertArrayEquals(BYTES, b.nodes.get("existing").bytes);
    }
    assertEquals(nameKey("é.sav"), nameKey("e\u0301.SAV")); // 右边是 e 加组合重音的分解形式。
  }

  @Test
  public void inputHashMismatchCannotSucceed() throws Exception {
    Fake b = new Fake();
    NewFilePublisher p = publisher(b);
    assertEquals("checksum-mismatch", runMismatch(p).errorCode);
    assertTrue(b.nodes.isEmpty());
  }

  @Test
  public void existingContentReturnedByCreateIsNotClaimed() throws Exception {
    Fake b = new Fake();
    b.add("existing", "其他.sav", BYTES);
    b.useExistingId = true;
    NewFilePublisher p = publisher(b);
    assertEquals("unknown", run(p, BYTES).status);
    assertArrayEquals(BYTES, b.nodes.get("existing").bytes);
    assertEquals(0, b.deletes);
  }

  @Test
  public void cancellationDuringWriteClosesStreamsAndCleans() throws Exception {
    for (String phase : new String[] { "writing" }) {
      Fake b = new Fake();
      NewFilePublisher p = publisher(b);
      Result r = p.publish(
        request("a", BYTES),
        () -> new ByteArrayInputStream(BYTES),
        (stage, count, total) -> {
          if (stage.equals(phase)) {
            p.cancel();
          }
        },
        new ArchiveControl()
      );
      assertEquals("cancelled", r.status);
      assertEquals("complete", r.cleanup);
      assertTrue(b.nodes.isEmpty());
    }
  }

  @Test
  public void cleanupFailureRetainsGlobalSlotUntilExplicitRetry() throws Exception {
    Fake b = new Fake();
    b.shouldFailCleanup = true;
    NewFilePublisher p = publisher(b);
    Result r = runMismatch(p);
    assertEquals("failed", r.status);
    assertEquals("incomplete", r.cleanup);
    assertEquals("cleanup-failed", r.cleanupError);
    assertEquals(1, r.residualEntries.size());
    NewFilePublisher other = publisher(new Fake());
    assertEquals("busy", assertThrows(ArchiveFailure.class, () -> run(other, BYTES)).code);
    assertFalse(p.retryCleanup());
    b.shouldFailCleanup = false;
    assertTrue(p.retryCleanup());
    assertEquals("succeeded", run(other, BYTES).status);
  }
}
