package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.list;
import static io.github.galgame.savedatasync.TransferJson.map;
import static io.github.galgame.savedatasync.TransferJson.object;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.handshake.ServerHandshake;
import org.java_websocket.protocols.Protocol;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** 在回环地址运行真实的本机服务，验证 HTTP 解析边界、目录表交换、控制通道和一台设备一条连接的规则。 */
public class ListenerServerTest {

  private static final String ROOT = "root-1";
  private static final String CHUNKED_CATALOG =
    "POST /v1/catalog HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n";

  @Rule
  public TemporaryFolder temporary = new TemporaryFolder();

  private final AtomicBoolean isDialing = new AtomicBoolean();
  private final AtomicInteger changes = new AtomicInteger();
  private final List<WebSocketClient> clients = new ArrayList<>();
  private volatile String saved;
  private ListenerServer server;

  /** 在回环地址启动本机服务；游戏库里有一个关联到 ROOT 的游戏。 */
  @Before
  public void start() throws Exception {
    saved = new String(
      TransferJson.bytes(
        object(
          "schemaVersion",
          2,
          "games",
          Collections.singletonList(
            object("id", "game-1", "name", "Game", "rootId", ROOT, "links", new ArrayList<>())
          ),
          "devices",
          new ArrayList<>()
        )
      ),
      StandardCharsets.UTF_8
    );
    server = new ListenerServer(
      new ListenerServer.Host() {
        @Override
        public String deviceId() {
          return "phone-a";
        }

        @Override
        public String displayName() {
          return "Phone A";
        }

        @Override
        public List<Object> roots() {
          return Collections.singletonList(root("phone-a", ROOT));
        }

        @Override
        public Map<String, Object> directory(String rootId, String parentId) throws Exception {
          if (!ROOT.equals(rootId)) {
            throw new ArchiveFailure("not-found", "The directory is no longer available.");
          }
          return object(
            "rootId",
            rootId,
            "parentId",
            parentId,
            "observedAt",
            1,
            "entries",
            new ArrayList<>()
          );
        }

        @Override
        public boolean isDialing() {
          return isDialing.get();
        }
      },
      new ListenerLibrary.Store() {
        @Override
        public String read() {
          return saved;
        }

        @Override
        public void write(String value) {
          saved = value;
        }
      },
      changes::incrementAndGet,
      () -> {},
      InetAddress.getLoopbackAddress(),
      0
    );
  }

  @After
  public void stop() throws Exception {
    for (WebSocketClient client : clients) {
      client.closeBlocking();
    }
    server.stop();
  }

  private static Map<String, Object> root(String deviceId, String rootId) {
    return object(
      "rootId",
      rootId,
      "deviceId",
      deviceId,
      "displayName",
      "Saves",
      "authorization",
      "granted"
    );
  }

  private static final class Reply {

    final int status;
    final String head;
    final Map<String, Object> body;

    Reply(int status, String head, Map<String, Object> body) {
      this.status = status;
      this.head = head;
      this.body = body;
    }
  }

  /** 读一个响应：状态行、头和按 Content-Length 读出的 JSON 正文。 */
  private static Reply read(InputStream input) throws Exception {
    ByteArrayOutputStream head = new ByteArrayOutputStream();
    while (!head.toString("US-ASCII").endsWith("\r\n\r\n")) {
      int value = input.read();
      if (value < 0) {
        throw new java.io.EOFException();
      }
      head.write(value);
    }
    String text = head.toString("US-ASCII");
    int length = 0;
    for (String line : text.split("\r\n")) {
      if (line.toLowerCase(java.util.Locale.ROOT).startsWith("content-length:")) {
        length = Integer.parseInt(line.substring(15).trim());
      }
    }
    byte[] body = new byte[length];
    int offset = 0;
    while (offset < length) {
      offset += input.read(body, offset, length - offset);
    }
    return new Reply(
      Integer.parseInt(text.split(" ")[1]),
      text,
      length == 0 ? null : map(TransferJson.parse(body))
    );
  }

  private Socket open() throws Exception {
    Socket socket = new Socket(InetAddress.getLoopbackAddress(), server.port());
    socket.setSoTimeout(5000);
    return socket;
  }

  private Reply send(String request) throws Exception {
    try (Socket socket = open()) {
      OutputStream output = socket.getOutputStream();
      output.write(request.getBytes(StandardCharsets.UTF_8));
      output.flush();
      return read(socket.getInputStream());
    }
  }

  private static String errorCode(Reply reply) throws Exception {
    return (String) map(reply.body.get("error")).get("code");
  }

  private Map<String, Object> hello(String deviceId) {
    return object(
      "deviceId",
      deviceId,
      "name",
      "PC " + deviceId,
      "platform",
      "windows",
      "games",
      Collections.singletonList(
        object("id", "pc-game", "name", "Game", "root", root(deviceId, "pc-root"))
      ),
      "links",
      Collections.singletonList(object("localGameId", "pc-game", "remoteGameId", "game-1"))
    );
  }

  private Reply catalog(Object body, boolean isNewConnection) throws Exception {
    byte[] json = TransferJson.bytes(body);
    return send(
      "POST /v1/catalog HTTP/1.1\r\nHost: phone\r\nContent-Type: application/json\r\n" +
        "x-sync-session-id: " +
        server.sessionId() +
        "\r\n" +
        (isNewConnection ? "x-sync-connect: 1\r\n" : "") +
        "Content-Length: " +
        json.length +
        "\r\n\r\n" +
        new String(json, StandardCharsets.UTF_8)
    );
  }

  private static final class Client extends WebSocketClient {

    final CompletableFuture<Integer> closed = new CompletableFuture<>();
    final CompletableFuture<Void> opened = new CompletableFuture<>();
    volatile java.util.function.Consumer<String> onText = text -> {};

    Client(int port, String session, String deviceId) throws Exception {
      super(
        new URI("ws://127.0.0.1:" + port + "/v1/control"),
        new Draft_6455(Collections.emptyList(), Collections.singletonList(new Protocol(""))),
        headers(session, deviceId),
        5000
      );
    }

    private static Map<String, String> headers(String session, String deviceId) {
      Map<String, String> result = new HashMap<>();
      result.put("x-sync-session-id", session);
      result.put("x-sync-device-id", deviceId);
      return result;
    }

    @Override
    public void onOpen(ServerHandshake handshake) {
      opened.complete(null);
    }

    @Override
    public void onMessage(String text) {
      onText.accept(text);
    }

    @Override
    public void onClose(int code, String reason, boolean isRemote) {
      closed.complete(code);
    }

    @Override
    public void onError(Exception cause) {
      // onClose 随后报告关闭码。
    }
  }

  private Client control(String deviceId) throws Exception {
    Client client = new Client(server.port(), server.sessionId(), deviceId);
    clients.add(client);
    client.connectBlocking(5, TimeUnit.SECONDS);
    return client;
  }

  @Test
  public void deviceDescribesAndroidListenerAndKeepsConnectionAlive() throws Exception {
    try (Socket socket = open()) {
      OutputStream output = socket.getOutputStream();
      InputStream input = socket.getInputStream();
      for (int i = 0; i < 2; i++) {
        output.write(
          "GET /v1/device HTTP/1.1\r\nHost: phone\r\n\r\n".getBytes(StandardCharsets.US_ASCII)
        );
        output.flush();
        Reply reply = read(input);
        assertEquals(200, reply.status);
        Map<String, Object> value = map(reply.body.get("value"));
        Map<String, Object> device = map(value.get("device"));
        assertEquals(3L, device.get("protocolVersion"));
        assertEquals("android", device.get("platform"));
        assertEquals(server.sessionId(), value.get("sessionId"));
        TransferSchema.device(value);
      }
    }
  }

  @Test
  public void rejectsMalformedRequestsWithStableCodes() throws Exception {
    Reply duplicate = send("GET /v1/device HTTP/1.1\r\nHost: a\r\nhost: b\r\n\r\n");
    assertEquals(400, duplicate.status);
    assertTrue(duplicate.head.contains("Connection: close"));
    assertEquals(400, send("GET /v1/device HTTP/1.0\r\nHost: a\r\n\r\n").status);
    assertEquals(
      400,
      send("GET /v1/device HTTP/1.1\r\nHost: a\r\nRange: bytes=0-1\r\n\r\n").status
    );
    assertEquals(400, send("GET /v1/device HTTP/1.1\r\nHost: a\r\n folded\r\n\r\n").status);
    assertEquals(400, send("GET /v1/roots/%FF/entries HTTP/1.1\r\nHost: a\r\n\r\n").status);
    assertEquals(400, send("GET /v1/transfers/x HTTP/1.1\r\nHost: a\r\n\r\n").status);
    assertEquals(
      400,
      send(
        "POST /v1/catalog HTTP/1.1\r\nHost: a\r\nContent-Length: 2\r\n" +
          "Transfer-Encoding: chunked\r\n\r\n{}"
      ).status
    );
    StringBuilder large = new StringBuilder("GET /v1/device HTTP/1.1\r\nHost: a\r\n");
    for (int i = 0; i < 70; i++) {
      large.append("x-filler-").append(i).append(": 1\r\n");
    }
    assertEquals(413, send(large.append("\r\n").toString()).status);
  }

  @Test
  public void rootsWithoutSessionAnswerSessionMismatch() throws Exception {
    Reply session = send("GET /v1/roots HTTP/1.1\r\nHost: a\r\n\r\n");
    assertEquals(409, session.status);
    assertEquals("session-mismatch", errorCode(session));
  }

  @Test
  public void syncWithoutCopyCapabilityAnswersUnsupported() throws Exception {
    Reply sync = send(
      "GET /v1/sync/capabilities HTTP/1.1\r\nHost: a\r\nx-sync-session-id: " +
        server.sessionId() +
        "\r\n\r\n"
    );
    assertEquals(501, sync.status);
    assertEquals("unsupported-operation", errorCode(sync));
  }

  @Test
  public void listsRootsAndEntriesWithSession() throws Exception {
    String session = "\r\nx-sync-session-id: " + server.sessionId() + "\r\n\r\n";
    Reply roots = send("GET /v1/roots HTTP/1.1\r\nHost: a" + session);
    assertEquals(200, roots.status);
    TransferSchema.roots(roots.body.get("value"), "phone-a");
    Reply entries = send("GET /v1/roots/" + ROOT + "/entries HTTP/1.1\r\nHost: a" + session);
    assertEquals(ROOT, map(entries.body.get("value")).get("rootId"));
    Reply missing = send("GET /v1/roots/other/entries?parentId=p1 HTTP/1.1\r\nHost: a" + session);
    assertEquals(404, missing.status);
  }

  @Test
  public void catalogAcceptsChunkedBodySavesDeviceAndMergesLinks() throws Exception {
    byte[] json = TransferJson.bytes(hello("pc-1"));
    int half = json.length / 2;
    Reply reply = send(
      "POST /v1/catalog HTTP/1.1\r\nHost: a\r\nContent-Type: application/json; charset=utf-8\r\n" +
        "x-sync-session-id: " +
        server.sessionId() +
        "\r\nx-sync-connect: 1\r\nTransfer-Encoding: chunked\r\n\r\n" +
        Integer.toHexString(half) +
        "\r\n" +
        new String(json, 0, half, StandardCharsets.UTF_8) +
        "\r\n" +
        Integer.toHexString(json.length - half) +
        "\r\n" +
        new String(json, half, json.length - half, StandardCharsets.UTF_8) +
        "\r\n0\r\n\r\n"
    );
    assertEquals(200, reply.status);
    Map<String, Object> value = map(reply.body.get("value"));
    Map<String, Object> game = map(list(value.get("games")).get(0));
    assertEquals(ROOT, map(game.get("root")).get("rootId"));
    Map<String, Object> config = map(TransferJson.parse(saved.getBytes(StandardCharsets.UTF_8)));
    Map<String, Object> device = map(list(config.get("devices")).get(0));
    assertEquals("pc-1", device.get("id"));
    assertNull(device.get("address"));
    Map<String, Object> link = map(list(map(list(config.get("games")).get(0)).get("links")).get(0));
    assertEquals("pc-game", link.get("gameId"));
    assertEquals(1, changes.get());
    // 本机游戏答复里带上了与它的关联。
    assertEquals("pc-game", map(list(value.get("links")).get(0)).get("remoteGameId"));
    ListenerLibrary.checkConfig(config);
  }

  @Test
  public void catalogRejectsRootOfAnotherDevice() throws Exception {
    Map<String, Object> foreign = hello("pc-1");
    foreign.put(
      "games",
      Collections.singletonList(object("id", "g", "name", "G", "root", root("someone-else", "r")))
    );
    assertEquals(400, catalog(foreign, true).status);
  }

  @Test
  public void catalogIsBusyWhileDialing() throws Exception {
    isDialing.set(true);
    Reply busy = catalog(hello("pc-1"), true);
    assertEquals(429, busy.status);
    assertEquals("busy", errorCode(busy));
  }

  @Test
  public void catalogIsBusyWhileAnotherDeviceHoldsControl() throws Exception {
    assertEquals(200, catalog(hello("pc-1"), true).status);
    control("pc-1").opened.get(5, TimeUnit.SECONDS);
    assertEquals("busy", errorCode(catalog(hello("pc-2"), true)));
  }

  @Test
  public void disconnectedDeviceExchangesAgainOnlyAsNewConnection() throws Exception {
    assertEquals(200, catalog(hello("pc-1"), true).status);
    Client first = control("pc-1");
    first.opened.get(5, TimeUnit.SECONDS);
    server.library().disconnect("pc-1");
    assertEquals(ListenerControl.CLOSE_DISCONNECTED, (int) first.closed.get(5, TimeUnit.SECONDS));
    assertEquals("session-mismatch", errorCode(catalog(hello("pc-1"), false)));
    assertEquals(200, catalog(hello("pc-1"), true).status);
  }

  @Test
  public void controlRejectsDeviceWithoutCatalog() throws Exception {
    Client stranger = control("pc-1");
    assertTrue(stranger.closed.get(5, TimeUnit.SECONDS) != 1000);
    assertFalse(stranger.opened.isDone());
  }

  @Test
  public void peersShowOpenControl() throws Exception {
    assertEquals(200, catalog(hello("pc-1"), true).status);
    control("pc-1").opened.get(5, TimeUnit.SECONDS);
    List<Object> peers = server.library().peers();
    assertEquals(Boolean.TRUE, map(peers.get(0)).get("isOpen"));
  }

  @Test
  public void directoryReadsListingThroughControl() throws Exception {
    assertEquals(200, catalog(hello("pc-1"), true).status);
    Client client = control("pc-1");
    client.opened.get(5, TimeUnit.SECONDS);
    answerDirectories(client);
    Map<String, Object> listing = map(
      server.library().directory("pc-1", "pc-root", null).get(5, TimeUnit.SECONDS)
    );
    assertEquals("pc-root", listing.get("rootId"));
  }

  @Test
  public void directoryRejectsParentNotReadInSession() throws Exception {
    assertEquals(200, catalog(hello("pc-1"), true).status);
    control("pc-1").opened.get(5, TimeUnit.SECONDS);
    ExecutionException unknownParent = assertThrows(ExecutionException.class, () ->
      server.library().directory("pc-1", "pc-root", "never-read").get(5, TimeUnit.SECONDS)
    );
    assertEquals("invalid-request", ((ArchiveFailure) unknownParent.getCause()).code);
  }

  @Test
  public void directoryTimesOutWhenPeerDoesNotAnswer() throws Exception {
    assertEquals(200, catalog(hello("pc-1"), true).status);
    Client client = control("pc-1");
    client.opened.get(5, TimeUnit.SECONDS);
    answerDirectories(client);
    server.library().directory("pc-1", "pc-root", null).get(5, TimeUnit.SECONDS);
    // 读过的目录可以作为下一层的父目录：请求照常发出，对方不答复时经过 ListenerControl.REQUEST_TIMEOUT_MS 超时。
    client.onText = text -> {};
    ExecutionException timeout = assertThrows(ExecutionException.class, () ->
      server.library().directory("pc-1", "pc-root", "dir-1").get(12, TimeUnit.SECONDS)
    );
    assertEquals("timeout", ((ArchiveFailure) timeout.getCause()).code);
  }

  /** 让 client 对每条 directory.list 请求答复一层只有 dir-1 一个子目录的列表。 */
  private static void answerDirectories(Client client) {
    client.onText = text -> {
      try {
        Map<String, Object> message = map(
          TransferJson.parse(text.getBytes(StandardCharsets.UTF_8))
        );
        Map<String, Object> body = map(message.get("body"));
        client.send(
          new String(
            TransferJson.bytes(
              object(
                "v",
                1,
                "type",
                "response",
                "id",
                message.get("id"),
                "result",
                object(
                  "status",
                  "success",
                  "value",
                  object(
                    "rootId",
                    body.get("rootId"),
                    "parentId",
                    null,
                    "observedAt",
                    1,
                    "entries",
                    Collections.singletonList(
                      object(
                        "rootId",
                        "pc-root",
                        "entryId",
                        "dir-1",
                        "parentId",
                        null,
                        "name",
                        "save",
                        "kind",
                        "directory",
                        "sizeBytes",
                        null,
                        "modifiedAt",
                        null,
                        "capabilities",
                        object(
                          "canRead",
                          "supported",
                          "canList",
                          "supported",
                          "canCreate",
                          "unknown",
                          "canRename",
                          "unknown",
                          "canDelete",
                          "unknown"
                        )
                      )
                    )
                  )
                )
              )
            ),
            StandardCharsets.UTF_8
          )
        );
      } catch (Exception cause) {
        throw new IllegalStateException(cause);
      }
    };
  }

  @Test
  public void controlAnswersPeerRequestsWithUnsupportedOperation() throws Exception {
    assertEquals(200, catalog(hello("pc-1"), true).status);
    Client client = control("pc-1");
    client.opened.get(5, TimeUnit.SECONDS);
    CompletableFuture<String> answer = new CompletableFuture<>();
    client.onText = answer::complete;
    client.send(
      "{\"v\":1,\"type\":\"request\",\"id\":\"r1\",\"method\":\"sync.job.read\"," +
        "\"body\":{\"jobId\":\"j\"}}"
    );
    Map<String, Object> response = map(
      TransferJson.parse(answer.get(5, TimeUnit.SECONDS).getBytes(StandardCharsets.UTF_8))
    );
    assertEquals("r1", response.get("id"));
    assertEquals(
      "unsupported-operation",
      map(map(response.get("result")).get("error")).get("code")
    );
  }

  @Test
  public void controlClosesOnBinaryMessage() throws Exception {
    assertEquals(200, catalog(hello("pc-1"), true).status);
    Client client = control("pc-1");
    client.opened.get(5, TimeUnit.SECONDS);
    client.send(ByteBuffer.wrap(new byte[] { 1 }));
    assertEquals(1003, (int) client.closed.get(5, TimeUnit.SECONDS));
  }

  @Test
  public void controlClosesOnDuplicateJsonKeys() throws Exception {
    assertEquals(200, catalog(hello("pc-1"), true).status);
    Client client = control("pc-1");
    client.opened.get(5, TimeUnit.SECONDS);
    client.send("{\"v\":1,\"v\":1}");
    assertEquals(1007, (int) client.closed.get(5, TimeUnit.SECONDS));
  }

  @Test
  public void sameDeviceReconnectReplacesOldConnection() throws Exception {
    assertEquals(200, catalog(hello("pc-1"), true).status);
    Client first = control("pc-1");
    first.opened.get(5, TimeUnit.SECONDS);
    Client second = control("pc-1");
    second.opened.get(5, TimeUnit.SECONDS);
    assertEquals(ListenerControl.CLOSE_REPLACED, (int) first.closed.get(5, TimeUnit.SECONDS));
    assertTrue(server.control().isOpen("pc-1"));
  }

  @Test
  public void goodbyeClosesControlAsDisconnected() throws Exception {
    assertEquals(200, catalog(hello("pc-1"), true).status);
    Client client = control("pc-1");
    client.opened.get(5, TimeUnit.SECONDS);
    assertEquals(200, catalog(object("deviceId", "pc-1", "goodbye", true), false).status);
    assertEquals(ListenerControl.CLOSE_DISCONNECTED, (int) client.closed.get(5, TimeUnit.SECONDS));
  }

  @Test
  public void chunkedBodyRejectsExtensionsAndTrailers() throws Exception {
    ListenerHttp.Request request = ListenerHttp.read(
      new ByteArrayInputStream(
        (CHUNKED_CATALOG + "2;x=1\r\n{}\r\n0\r\n\r\n").getBytes(StandardCharsets.US_ASCII)
      )
    );
    assertThrows(ArchiveFailure.class, () -> request.body.read(new byte[8]));
    ListenerHttp.Request trailer = ListenerHttp.read(
      new ByteArrayInputStream(
        (CHUNKED_CATALOG + "2\r\n{}\r\n0\r\nx: 1\r\n\r\n").getBytes(StandardCharsets.US_ASCII)
      )
    );
    assertEquals(2, trailer.body.read(new byte[8]));
    assertThrows(ArchiveFailure.class, () -> trailer.body.read(new byte[8]));
  }

  @Test
  public void libraryRulesMatchSharedModel() throws Exception {
    assertFalse(ListenerLibrary.isName("\u3000"));
    assertFalse(ListenerLibrary.isName("a\u0001"));
    assertTrue(ListenerLibrary.isName(" a "));
    Map<String, Object> config = object(
      "schemaVersion",
      2,
      "games",
      new ArrayList<>(
        Collections.singletonList(
          object(
            "id",
            "g1",
            "name",
            "G1",
            "rootId",
            null,
            "links",
            Collections.singletonList(object("deviceId", "pc-1", "gameId", "old")),
            "excludedDevices",
            new ArrayList<>()
          )
        )
      ),
      "devices",
      Collections.singletonList(
        object(
          "id",
          "pc-1",
          "name",
          "PC",
          "platform",
          "windows",
          "address",
          null,
          "isBlocked",
          false
        )
      )
    );
    // 对端的 old 已改为关联本机别的游戏，本机游戏的旧关联被移除。
    Map<String, Object> moved = ListenerLibrary.mergeLinks(
      config,
      "pc-1",
      Collections.singletonList(object("localGameId", "old", "remoteGameId", "g2"))
    );
    assertTrue(list(map(list(moved.get("games")).get(0)).get("links")).isEmpty());
    Map<String, Object> linked = ListenerLibrary.mergeLinks(
      config,
      "pc-1",
      Collections.singletonList(object("localGameId", "new", "remoteGameId", "g1"))
    );
    assertEquals(
      "new",
      map(list(map(list(linked.get("games")).get(0)).get("links")).get(0)).get("gameId")
    );
    Map<String, Object> missingAddress = new HashMap<>(config);
    missingAddress.put(
      "devices",
      Collections.singletonList(
        object("id", "pc-1", "name", "PC", "platform", "windows", "isBlocked", false)
      )
    );
    assertThrows(ArchiveFailure.class, () -> ListenerLibrary.checkConfig(missingAddress));
  }

  @Test
  public void androidDialerConnectsExchangesAndStopsAfterDisconnect() throws Exception {
    BlockingQueue<int[]> states = new LinkedBlockingQueue<>();
    TransferEngine engine = new TransferEngine(
      new ArchiveAdapter(new ArchiveCache(temporary.newFolder().toPath().toRealPath())),
      new TransferEngine.Local() {
        @Override
        public String deviceId() {
          return "phone-b";
        }

        @Override
        public boolean hasListenerPeer() {
          return false;
        }
      }
    );
    try {
      engine.controlListener(
        new TransferEngine.ControlListener() {
          @Override
          public void message(String deviceId, String text) {}

          @Override
          public void state(String deviceId, boolean isOpen, int code) {
            states.add(new int[] { isOpen ? 1 : 0, code });
          }
        }
      );
      ArchiveControl control = new ArchiveControl();
      Map<String, Object> descriptor = engine.connect(
        new TransferHttp.Client("http://127.0.0.1:" + server.port()),
        control
      );
      assertEquals("android", map(descriptor.get("device")).get("platform"));
      Map<String, Object> reply = map(
        engine.exchangeCatalog(
          "phone-a",
          object(
            "games",
            Collections.singletonList(
              object("id", "game-b", "name", "B", "root", root("phone-b", "root-b"))
            ),
            "links",
            Collections.singletonList(object("localGameId", "game-b", "remoteGameId", "game-1"))
          ),
          "Phone B",
          control
        )
      );
      assertEquals("game-1", map(list(reply.get("games")).get(0)).get("id"));
      int[] opened = states.poll(5, TimeUnit.SECONDS);
      assertEquals(1, opened[0]);
      assertTrue((Boolean) map(server.library().peers().get(0)).get("isOpen"));
      assertTrue(saved.contains("\"phone-b\""));
      assertEquals(1, engine.roots(control).size());
      assertTrue(list(engine.directory(ROOT, null, control).get("entries")).isEmpty());

      server.library().disconnect("phone-b");
      int[] closed = states.poll(5, TimeUnit.SECONDS);
      assertEquals(0, closed[0]);
      assertEquals(ListenerControl.CLOSE_DISCONNECTED, closed[1]);
    } finally {
      engine.close();
    }
  }
}
