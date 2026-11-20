package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.fail;
import static io.github.galgame.savedatasync.TransferJson.map;
import static io.github.galgame.savedatasync.TransferJson.object;
import static io.github.galgame.savedatasync.TransferSchema.id;
import static io.github.galgame.savedatasync.TransferSchema.number;
import static io.github.galgame.savedatasync.TransferSchema.one;
import static io.github.galgame.savedatasync.TransferSchema.shape;
import static io.github.galgame.savedatasync.TransferSchema.string;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * 控制通道的监听端，同一时间维护一条设备连接。同一设备的新连接以 {@link #CLOSE_REPLACED} 取代旧连接，对方超过
 * {@link #PING_INTERVAL_MS} 没有回应心跳时断开。对方发来的请求，方法已知的答复 unsupported-operation，未知的答复
 * invalid-request。
 */
final class ListenerControl {

  /** 连接状态变化；回调在连接的读线程或调度线程上执行。 */
  interface Listener {
    void changed(String peerId, boolean isOpen);
  }

  /** 对方发来的事件，外层格式和方法名已校验，body 未校验；回调在连接的读线程上执行，抛出的异常被忽略。 */
  interface Events {
    void event(String peerId, String method, Object body);
  }

  /** 本机断开这台设备，对方不要重连。 */
  static final int CLOSE_DISCONNECTED = 4001;
  /** 同一设备的新连接取代旧连接。 */
  static final int CLOSE_REPLACED = 4002;
  static final long PING_INTERVAL_MS = 15000;
  static final long REQUEST_TIMEOUT_MS = 8000;
  private static final List<String> REQUESTS = Arrays.asList(
    "directory.list",
    "sync.prepare",
    "sync.confirm",
    "sync.cancel",
    "sync.job.read",
    "sync.job.cancel"
  );
  private static final List<String> EVENTS = Arrays.asList(
    "catalog.changed",
    "sync.report",
    "sync.job"
  );

  private static final class Peer {

    final String id;
    final ListenerSocket socket;
    final Map<String, CompletableFuture<Object>> pending = new ConcurrentHashMap<>();
    volatile boolean isAlive = true;

    Peer(String id, ListenerSocket socket) {
      this.id = id;
      this.socket = socket;
    }
  }

  private final ScheduledExecutorService timer;
  private final Listener listener;
  private final ScheduledFuture<?> heartbeat;
  private Peer current;
  private boolean isStopped;
  private volatile Events events;

  ListenerControl(ScheduledExecutorService timer, Listener listener) {
    this.timer = timer;
    this.listener = listener;
    this.heartbeat = timer.scheduleWithFixedDelay(
      this::ping,
      PING_INTERVAL_MS,
      PING_INTERVAL_MS,
      TimeUnit.MILLISECONDS
    );
  }

  /**
   * 创建 peerId 的连接对象并登记为当前连接，以 {@link #CLOSE_REPLACED} 关闭已有的连接。
   *
   * @return 已登记的连接；必须在接入这条连接的线程上执行它的 {@link ListenerSocket#run}，读到的消息才会被处理。
   */
  ListenerSocket attach(
    String peerId,
    java.net.Socket raw,
    java.io.InputStream input,
    java.io.OutputStream output
  ) {
    Peer[] holder = new Peer[1];
    ListenerSocket socket = new ListenerSocket(
      raw,
      input,
      output,
      new ListenerSocket.Events() {
        @Override
        public void message(ListenerSocket source, String text) {
          receive(holder[0], text);
        }

        @Override
        public void pong(ListenerSocket source) {
          holder[0].isAlive = true;
        }

        @Override
        public void closed(ListenerSocket source, int code) {
          detach(holder[0]);
        }
      }
    );
    holder[0] = new Peer(peerId, socket);
    Peer previous;
    synchronized (this) {
      if (isStopped) {
        socket.terminate();
        return socket;
      }
      previous = current;
      current = holder[0];
    }
    if (previous != null) {
      previous.socket.close(CLOSE_REPLACED, "replaced");
    }
    listener.changed(peerId, true);
    return socket;
  }

  /** 设置事件的接收者；null 表示丢弃事件。 */
  void events(Events value) {
    events = value;
  }

  /** 与 peerId 的控制连接是否打开。 */
  synchronized boolean isOpen(String peerId) {
    return current != null && current.id.equals(peerId);
  }

  /** 当前连着的设备 ID；没有连接时为 null。 */
  synchronized String peerId() {
    return current == null ? null : current.id;
  }

  /**
   * 向对方发请求。
   *
   * @return 对方答复的 value；对方未连接、{@link #REQUEST_TIMEOUT_MS} 内没有应答、连接断开或答复错误时以 ArchiveFailure
   *     异常完成。
   */
  CompletableFuture<Object> request(String peerId, String method, Object body) {
    CompletableFuture<Object> result = new CompletableFuture<>();
    Peer peer;
    synchronized (this) {
      peer = current != null && current.id.equals(peerId) ? current : null;
    }
    if (peer == null) {
      result.completeExceptionally(fail("network-failure"));
      return result;
    }
    String id = UUID.randomUUID().toString();
    peer.pending.put(id, result);
    ScheduledFuture<?> timeout = timer.schedule(
      () -> {
        if (peer.pending.remove(id) != null) {
          result.completeExceptionally(fail("timeout"));
        }
      },
      REQUEST_TIMEOUT_MS,
      TimeUnit.MILLISECONDS
    );
    result.whenComplete((value, error) -> timeout.cancel(false));
    try {
      send(peer, object("v", 1, "type", "request", "id", id, "method", method, "body", body));
    } catch (Exception cause) {
      peer.pending.remove(id);
      result.completeExceptionally(ArchiveFailure.from(cause));
    }
    return result;
  }

  /** 通知对方；未连接时忽略，事件不保证送达。 */
  void emit(String peerId, String method, Object body) {
    Peer peer;
    synchronized (this) {
      peer = current != null && current.id.equals(peerId) ? current : null;
    }
    if (peer != null) {
      try {
        send(peer, object("v", 1, "type", "event", "method", method, "body", body));
      } catch (Exception ignored) {
        // 事件不保证送达；连接已断开时读线程随后报告断开。
      }
    }
  }

  /** 用 {@link #CLOSE_DISCONNECTED} 关闭与 peerId 的连接。 */
  void disconnect(String peerId) {
    Peer peer;
    synchronized (this) {
      peer = current != null && current.id.equals(peerId) ? current : null;
    }
    if (peer != null) {
      peer.socket.close(CLOSE_DISCONNECTED, "disconnected");
    }
  }

  /** 直接关闭当前连接的套接字，对方按连接中断处理；之后接入的连接立即关闭。 */
  void stop() {
    Peer peer;
    synchronized (this) {
      isStopped = true;
      peer = current;
    }
    heartbeat.cancel(false);
    if (peer != null) {
      peer.socket.terminate();
    }
  }

  private void detach(Peer peer) {
    for (CompletableFuture<Object> pending : peer.pending.values()) {
      pending.completeExceptionally(fail("network-failure"));
    }
    peer.pending.clear();
    boolean wasCurrent;
    synchronized (this) {
      wasCurrent = current == peer;
      if (wasCurrent) {
        current = null;
      }
    }
    if (wasCurrent) {
      listener.changed(peer.id, false);
    }
  }

  private void ping() {
    Peer peer;
    synchronized (this) {
      peer = current;
    }
    if (peer == null) {
      return;
    }
    if (!peer.isAlive) {
      peer.socket.terminate();
      return;
    }
    peer.isAlive = false;
    try {
      peer.socket.ping();
    } catch (Exception failed) {
      peer.socket.terminate();
    }
  }

  private void send(Peer peer, Map<String, Object> message) throws Exception {
    byte[] bytes = TransferJson.bytes(message);
    peer.socket.sendText(new String(bytes, StandardCharsets.UTF_8));
  }

  /** 处理一条消息：不是严格 JSON 时以 1007 关闭，外层格式不对时以 1008 关闭。 */
  private void receive(Peer peer, String text) {
    Map<String, Object> message;
    try {
      message = map(TransferJson.parse(text.getBytes(StandardCharsets.UTF_8)));
    } catch (Exception invalid) {
      peer.socket.close(1007, "invalid-json");
      return;
    }
    try {
      Object type = message.get("type");
      if ("response".equals(type)) {
        shape(message, "v", "type", "id", "result");
        number(message.get("v"), 1, 1);
        CompletableFuture<Object> pending = peer.pending.remove(id(message.get("id")));
        if (pending != null) {
          Map<String, Object> result = map(message.get("result"));
          if ("error".equals(result.get("status"))) {
            Map<String, Object> error = map(shape(result, "status", "error").get("error"));
            String code = string(error.get("code"));
            pending.completeExceptionally(
              Arrays.asList(TransferSchema.ERROR_CODES.split(" ")).contains(code)
                ? fail(code)
                : fail("invalid-request")
            );
          } else {
            shape(result, "status", "value");
            one(result.get("status"), "success");
            pending.complete(result.get("value"));
          }
        }
      } else if ("request".equals(type)) {
        shape(message, "v", "type", "id", "method", "body");
        number(message.get("v"), 1, 1);
        String requestId = id(message.get("id"));
        boolean isKnown = REQUESTS.contains(message.get("method"));
        send(
          peer,
          object(
            "v",
            1,
            "type",
            "response",
            "id",
            requestId,
            "result",
            object(
              "status",
              "error",
              "error",
              object(
                "code",
                isKnown ? "unsupported-operation" : "invalid-request",
                "message",
                isKnown
                  ? "This device does not handle this request."
                  : "The request format is invalid.",
                "canRetry",
                false
              )
            )
          )
        );
      } else {
        shape(message, "v", "type", "method", "body");
        number(message.get("v"), 1, 1);
        one(type, "event");
        TransferSchema.require(EVENTS.contains(message.get("method")));
        dispatch(peer, (String) message.get("method"), message.get("body"));
      }
    } catch (Exception invalid) {
      peer.socket.close(1008, "invalid-message");
    }
  }

  private void dispatch(Peer peer, String method, Object body) {
    Events receiver = events;
    if (receiver == null) {
      return;
    }
    try {
      receiver.event(peer.id, method, body);
    } catch (RuntimeException ignored) {
      // 事件内容由接收者校验，内容不对只丢弃这一条，不断开连接。
    }
  }
}
