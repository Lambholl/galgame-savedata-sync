package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.object;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;

/**
 * 本机服务：提供 /v1/device、/v1/catalog、/v1/roots、目录列举和 /v1/control，请求、会话和头的检查规则与电脑服务相同，
 * 复制接口答复 unsupported-operation。
 */
final class ListenerServer {

  /** 本机设备的身份和目录。 */
  interface Host extends ListenerLibrary.Host {
    String deviceId();

    /** 发给对方的设备名，必须满足 {@link ListenerLibrary#isName}。 */
    String displayName();

    /**
     * 列出本机一个根目录的一层，返回共享 DirectoryListing 的 JSON 对象。
     *
     * @throws ArchiveFailure 引用无效、目录失效或读取失败时抛出，错误码沿用目录模块的。
     */
    Map<String, Object> directory(String rootId, String parentId) throws Exception;
  }

  /** 连接状态变化；回调在连接线程或调度线程上执行。 */
  interface Listener {
    void changed();
  }

  /** 同时保持的最多连接数；超出的新连接直接关闭。 */
  static final int MAX_CONNECTIONS = 16;
  /** 网络无进展的最长等待（毫秒），与电脑服务的 networkIdle 相同。 */
  static final int IDLE_MS = 60000;
  /** 控制通道读等待的上限（毫秒）。 */
  // 取三个心跳周期：连接正常时这期间一定会收到 pong，读超时只在对方失联时发生。
  static final int CONTROL_IDLE_MS = (int) ListenerControl.PING_INTERVAL_MS * 3;
  private static final String SESSION_HEADER = "x-sync-session-id";
  private static final String DEVICE_HEADER = "x-sync-device-id";

  private final Host host;
  private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> {
    Thread thread = new Thread(r, "listener-control");
    thread.setDaemon(true);
    return thread;
  });
  private final ListenerControl control;
  private final ListenerLibrary library;
  private final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
  private final ServerSocket server;
  private final String sessionId = UUID.randomUUID().toString();
  private final long startedAt = System.currentTimeMillis();
  private volatile boolean isStopped;

  /**
   * 在 address 的 port 端口开始监听，并在新线程上接受连接。
   *
   * @throws IOException 端口被占用或无法监听时抛出。
   */
  ListenerServer(
    Host host,
    ListenerLibrary.Store store,
    ListenerLibrary.Changes changes,
    Listener listener,
    InetAddress address,
    int port
  ) throws IOException {
    this.host = host;
    this.control = new ListenerControl(timer, (peerId, isOpen) -> listener.changed());
    this.library = new ListenerLibrary(store, host, control, changes);
    ServerSocket socket = new ServerSocket();
    try {
      socket.setReuseAddress(false);
      socket.bind(new InetSocketAddress(address, port), 16);
    } catch (IOException cause) {
      socket.close();
      timer.shutdownNow();
      throw cause;
    }
    this.server = socket;
    Thread accept = new Thread(this::accept, "listener-accept");
    accept.setDaemon(true);
    accept.start();
  }

  /** 实际监听的端口。 */
  int port() {
    return server.getLocalPort();
  }

  /** 开始监听的时间（Unix 毫秒）。 */
  long startedAt() {
    return startedAt;
  }

  /** 本次服务的会话 ID。 */
  String sessionId() {
    return sessionId;
  }

  ListenerLibrary library() {
    return library;
  }

  ListenerControl control() {
    return control;
  }

  /** 关闭监听和全部连接；可以重复调用。 */
  void stop() {
    isStopped = true;
    control.stop();
    library.reset();
    try {
      server.close();
    } catch (IOException ignored) {
      // 监听套接字已经关闭。
    }
    for (Socket socket : sockets) {
      close(socket);
    }
    timer.shutdownNow();
  }

  private void accept() {
    while (!isStopped) {
      Socket socket;
      try {
        socket = server.accept();
      } catch (IOException closed) {
        return;
      }
      if (isStopped || sockets.size() >= MAX_CONNECTIONS) {
        close(socket);
        continue;
      }
      sockets.add(socket);
      Thread thread = new Thread(() -> serve(socket), "listener-connection");
      thread.setDaemon(true);
      thread.start();
    }
  }

  private void serve(Socket socket) {
    try {
      socket.setSoTimeout(IDLE_MS);
      socket.setTcpNoDelay(true);
      InputStream input = new BufferedInputStream(socket.getInputStream(), 16384);
      OutputStream output = new BufferedOutputStream(socket.getOutputStream(), 16384);
      while (!isStopped) {
        ListenerHttp.Request request;
        try {
          request = ListenerHttp.read(input);
        } catch (ArchiveFailure invalid) {
          ListenerHttp.sendFailure(output, invalid.code, "The HTTP request format is invalid.");
          return;
        }
        if (request == null || !handle(socket, request, input, output)) {
          return;
        }
      }
    } catch (Exception ended) {
      // 对方断开、读写超时或服务已停止；这条连接上没有需要收尾的任务。
    } finally {
      sockets.remove(socket);
      close(socket);
    }
  }

  /** 处理一个请求；返回 true 表示连接可以继续读下一个请求。 */
  private boolean handle(
    Socket socket,
    ListenerHttp.Request request,
    InputStream input,
    OutputStream output
  ) throws Exception {
    ListenerHttp.Route route;
    try {
      route = ListenerHttp.route(request);
      if (!"device".equals(route.kind) && !sessionId.equals(request.header(SESSION_HEADER))) {
        if ("control".equals(route.kind)) {
          ListenerHttp.sendEmpty(output, 403);
          return false;
        }
        throw new ArchiveFailure(
          "session-mismatch",
          "The service session changed. Read device information again."
        );
      }
      switch (route.kind) {
        case "control":
          upgrade(socket, request, input, output);
          return false;
        case "device":
          ListenerHttp.sendSuccess(output, 200, device());
          return true;
        case "roots":
          ListenerHttp.sendSuccess(output, 200, host.roots());
          return true;
        case "entries":
          ListenerHttp.sendSuccess(output, 200, host.directory(route.id, route.parentId));
          return true;
        case "catalog":
          return exchange(request, output);
        default:
          throw new ArchiveFailure(
            "unsupported-operation",
            "This device does not accept copy tasks."
          );
      }
    } catch (ArchiveFailure failure) {
      ListenerHttp.sendFailure(output, failure.code, failure.getMessage());
      return false;
    }
  }

  /** 交换目录表并回复；请求体没有读完时返回 false，这条连接不能再读下一个请求。 */
  private boolean exchange(ListenerHttp.Request request, OutputStream output) throws Exception {
    Object value = ListenerHttp.readJson(request);
    if (!request.isBodyComplete()) {
      return false;
    }
    Map<String, Object> reply = library.exchange(
      value,
      "1".equals(request.header("x-sync-connect"))
    );
    ListenerHttp.sendSuccess(output, 200, reply);
    return true;
  }

  private Map<String, Object> device() {
    return object(
      "device",
      object(
        "protocolVersion",
        2,
        "deviceId",
        host.deviceId(),
        "displayName",
        host.displayName(),
        "platform",
        "android",
        "capabilities",
        object(
          "canListRoots",
          "supported",
          "canReadFiles",
          "unsupported",
          "canReceiveFiles",
          "unsupported",
          "canQueryTransfers",
          "unsupported",
          "canCancelTransfers",
          "unsupported"
        )
      ),
      "sessionId",
      sessionId,
      "limits",
      TransferSchema.limits()
    );
  }

  /** 升级控制通道，只接受本会话交换过目录表、能建立控制通道的设备；不满足时答复 403。 */
  private void upgrade(
    Socket socket,
    ListenerHttp.Request request,
    InputStream input,
    OutputStream output
  ) throws IOException {
    String peerId = request.header(DEVICE_HEADER);
    String accept = ListenerSocket.accept(request);
    if (accept == null || !DocumentValues.isId(peerId) || !library.canControl(peerId)) {
      // 升级被拒时只回状态码、不带错误包络，与电脑服务相同；客户端按握手失败处理。
      ListenerHttp.sendEmpty(output, 403);
      return;
    }
    ListenerSocket.sendHandshake(output, accept);
    socket.setSoTimeout(CONTROL_IDLE_MS);
    control.attach(peerId, socket, input, output).run();
  }

  private static void close(Socket socket) {
    try {
      socket.close();
    } catch (IOException ignored) {
      // 套接字已经关闭。
    }
  }
}
