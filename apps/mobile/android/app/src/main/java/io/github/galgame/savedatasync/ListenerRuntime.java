package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.list;
import static io.github.galgame.savedatasync.TransferJson.map;
import static io.github.galgame.savedatasync.TransferJson.object;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.CancellationSignal;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.TimeUnit;

/**
 * 进程内的本机服务：持有 HTTP 服务、局域网广播和前台服务。端口首次在 {@link #MIN_PORT} 到 {@link #MAX_PORT} 之间随机生成并保存；
 * 开关状态也保存，由 {@link #resume} 按开关重新启动。
 */
final class ListenerRuntime {

  /** 状态或游戏库变化；回调可能在任意线程上执行。 */
  interface Observer {
    void stateChanged();

    void libraryChanged();
  }

  private static final String SETTINGS = "local-service";
  private static final String PORT = "port";
  private static final String ENABLED = "enabled";
  private static final int MAX_ADDRESSES = 8;
  /** 随机端口的范围：IANA 动态端口。 */
  private static final int MIN_PORT = 49152;
  private static final int MAX_PORT = 65535;
  private static ListenerRuntime instance;
  private final Context context;
  private final SharedPreferences settings;
  private final ListenerAdvertiser advertiser;
  private final Set<Observer> observers = new CopyOnWriteArraySet<>();
  private final ListenerServer.Host host;
  private ListenerServer server;
  private Map<String, Object> error;

  static synchronized ListenerRuntime get(Context context) {
    if (instance == null) {
      instance = new ListenerRuntime(context.getApplicationContext());
    }
    return instance;
  }

  /** 已创建的实例；还没有创建时返回 null。 */
  static synchronized ListenerRuntime peek() {
    return instance;
  }

  private ListenerRuntime(Context context) {
    this.context = context;
    this.settings = context.getSharedPreferences(SETTINGS, Context.MODE_PRIVATE);
    this.advertiser = new ListenerAdvertiser(context, this::stateChanged);
    this.host = new ListenerServer.Host() {
      @Override
      public String deviceId() {
        try {
          return DirectoryRuntime.store(context).deviceId();
        } catch (DirectoryFailure unavailable) {
          throw new IllegalStateException(unavailable);
        }
      }

      @Override
      public String displayName() {
        return DeviceNames.current(context);
      }

      @Override
      public List<Object> roots() throws Exception {
        try {
          String json = DirectoryRuntime.store(context)
            .listRoots(new CancellationSignal())
            .toString();
          return list(TransferJson.parse(json.getBytes(StandardCharsets.UTF_8)));
        } catch (DirectoryFailure failure) {
          throw new ArchiveFailure(failure.code, failure.getMessage());
        }
      }

      @Override
      public Map<String, Object> directory(String rootId, String parentId) throws Exception {
        try {
          String json = DirectoryRuntime.store(context)
            .listDirectory(rootId, parentId, new CancellationSignal())
            .toString();
          return map(TransferJson.parse(json.getBytes(StandardCharsets.UTF_8)));
        } catch (DirectoryFailure failure) {
          throw new ArchiveFailure(failure.code, failure.getMessage());
        }
      }

      @Override
      public boolean isDialing() {
        TransferRuntime transfers = TransferRuntime.peek();
        return transfers != null && transfers.engine.isDialing();
      }
    };
  }

  /** 添加监听器。 */
  void subscribe(Observer observer) {
    observers.add(observer);
  }

  /** 移除监听器。 */
  void unsubscribe(Observer observer) {
    observers.remove(observer);
  }

  /** 服务是否在监听。 */
  synchronized boolean isRunning() {
    return server != null;
  }

  /** 是否有设备连着本机服务的控制通道。 */
  synchronized boolean hasPeer() {
    return server != null && server.control().peerId() != null;
  }

  /** 保存的端口；还没有时在 {@link #MIN_PORT} 到 {@link #MAX_PORT} 之间随机生成一个并保存。 */
  synchronized int port() {
    int port = settings.getInt(PORT, 0);
    if (port < 1 || port > 65535) {
      port = randomPort(0);
      settings.edit().putInt(PORT, port).apply();
    }
    return port;
  }

  /**
   * 换一个随机端口并保存。
   *
   * @throws ArchiveFailure 服务在运行时抛出 busy。
   */
  synchronized void randomizePort() throws ArchiveFailure {
    if (server != null) {
      throw new ArchiveFailure("busy", "Stop the local service before changing the port.");
    }
    settings.edit().putInt(PORT, randomPort(port())).apply();
    stateChanged();
  }

  private static int randomPort(int except) {
    SecureRandom random = new SecureRandom();
    int port;
    do {
      port = MIN_PORT + random.nextInt(MAX_PORT - MIN_PORT + 1);
    } while (port == except);
    return port;
  }

  /**
   * 打开开关：在保存的端口监听 0.0.0.0，启动前台服务和局域网广播。已在运行时不做任何事。
   *
   * @throws ArchiveFailure 端口被占用或系统不允许启动前台服务时抛出 io-failure，开关状态不变。
   */
  void start() throws ArchiveFailure {
    ListenerServer created;
    synchronized (this) {
      if (server != null) {
        return;
      }
      try {
        created = new ListenerServer(
          host,
          new ListenerLibrary.Store() {
            @Override
            public String read() {
              return AppStoragePlugin.readLibrary(context);
            }

            @Override
            public void write(String value) throws ArchiveFailure {
              AppStoragePlugin.writeLibrary(context, value);
            }
          },
          this::libraryChanged,
          this::peerChanged,
          InetAddress.getByAddress(new byte[4]),
          port()
        );
      } catch (IOException cause) {
        fail(
          "io-failure",
          "Cannot listen on the port. Check whether it is in use or choose another port."
        );
        throw new ArchiveFailure("io-failure", "Cannot listen on the port.", false, cause);
      }
      server = created;
      error = null;
    }
    try {
      // 在调用线程上等：服务在主线程进入前台，插件方法不在主线程运行。
      ListenerService.launch(context).get(5, TimeUnit.SECONDS);
    } catch (Exception cause) {
      synchronized (this) {
        if (server == created) {
          server = null;
        }
      }
      created.stop();
      ListenerService.finish(context);
      fail("io-failure", "The system did not allow the local service to start.");
      throw new ArchiveFailure("io-failure", "The local service could not start.", false, cause);
    }
    settings.edit().putBoolean(ENABLED, true).apply();
    advertiser.start(host.displayName(), host.deviceId(), created.port());
    stateChanged();
  }

  /**
   * 开关开着但服务没在运行时重新启动；启动失败时关掉开关，失败原因保留在 {@link #status} 的 error 里。
   */
  void resume() {
    if (settings.getBoolean(ENABLED, false) && !isRunning()) {
      try {
        start();
      } catch (ArchiveFailure failed) {
        settings.edit().putBoolean(ENABLED, false).apply();
      }
    }
  }

  /** 关掉开关：断开连接、注销广播、停止前台服务。可以重复调用。 */
  void stop() {
    ListenerServer current;
    synchronized (this) {
      settings.edit().putBoolean(ENABLED, false).apply();
      current = server;
      server = null;
      error = null;
    }
    if (current != null) {
      current.stop();
    }
    advertiser.stop();
    ListenerService.finish(context);
    stateChanged();
  }

  private synchronized void fail(String code, String message) {
    error = object("code", code, "message", message, "canRetry", true);
  }

  /**
   * 状态快照：设备 ID、保存的端口、开关、实际监听地址和开始时间、本机 IPv4 地址、广播状态、最近一次启动错误和当前连着的设备 ID。
   */
  synchronized Map<String, Object> status() {
    Map<String, Object> listener =
      server == null ? null : object("port", server.port(), "startedAt", server.startedAt());
    return object(
      "deviceId",
      host.deviceId(),
      "configuredPort",
      port(),
      "isEnabled",
      settings.getBoolean(ENABLED, false),
      "listener",
      listener,
      "ipv4Addresses",
      server == null ? new ArrayList<>() : addresses(),
      "discovery",
      server == null ? "off" : advertiser.status(),
      "error",
      error,
      "peerId",
      server == null ? null : server.control().peerId()
    );
  }

  /** 交换过目录表的设备，元素为 {deviceId, name, platform, isOpen, games}；服务没运行时为空。 */
  List<Object> peers() throws Exception {
    ListenerServer current;
    synchronized (this) {
      current = server;
    }
    return current == null ? new ArrayList<>() : current.library().peers();
  }

  /** 断开连着本机的设备；服务没运行时不做任何事。 */
  void disconnect(String peerId) {
    ListenerServer current;
    synchronized (this) {
      current = server;
    }
    if (current != null) {
      current.library().disconnect(peerId);
    }
  }

  /**
   * 经控制通道读取连着本机的设备的一层目录。
   *
   * @throws ArchiveFailure 服务没运行、对方离线、超时或答复错误时抛出。
   */
  Object directory(String peerId, String rootId, String parentId) throws Exception {
    ListenerServer current;
    synchronized (this) {
      current = server;
    }
    if (current == null) {
      throw new ArchiveFailure("not-found", "The local service has stopped.");
    }
    try {
      return current
        .library()
        .directory(peerId, rootId, parentId)
        .get(ListenerControl.REQUEST_TIMEOUT_MS + 2000, TimeUnit.MILLISECONDS);
    } catch (java.util.concurrent.ExecutionException failed) {
      Throwable cause = failed.getCause();
      throw cause instanceof ArchiveFailure ? (ArchiveFailure) cause : failed;
    }
  }

  /** 本机游戏或关联已改变，通知连着本机的设备重新交换目录表。 */
  void catalogChanged() {
    ListenerServer current;
    synchronized (this) {
      current = server;
    }
    String peerId = current == null ? null : current.control().peerId();
    if (peerId != null) {
      current.control().emit(peerId, "catalog.changed", object());
    }
  }

  /** 推荐的连接地址 `IPv4:端口`；服务没运行或没有可用地址时为 null。 */
  synchronized String recommendedAddress() {
    if (server == null) {
      return null;
    }
    List<String> addresses = addresses();
    return addresses.isEmpty() ? null : addresses.get(0) + ":" + server.port();
  }

  /** 连着本机的设备在本机保存的名称；没有保存的名称时返回设备 ID，没有连接时为 null。 */
  synchronized String peerName() {
    String peerId = server == null ? null : server.control().peerId();
    if (peerId == null) {
      return null;
    }
    try {
      String saved = AppStoragePlugin.readLibrary(context);
      if (saved != null) {
        for (Object device : list(
          map(TransferJson.parse(saved.getBytes(StandardCharsets.UTF_8))).get("devices")
        )) {
          if (peerId.equals(map(device).get("id"))) {
            return (String) map(device).get("name");
          }
        }
      }
    } catch (Exception unreadable) {
      // 读不到名称时通知只显示设备 ID。
    }
    return peerId;
  }

  /**
   * 其他设备可能访问到的本机 IPv4 地址，按推荐顺序：先 Wi-Fi 和有线网卡，再热点网卡；都没有时用其他网卡。
   * 排除回环、链路本地、蜂窝、VPN 和 198.18.0.0/15，去重后最多 {@link #MAX_ADDRESSES} 个。
   */
  static List<String> addresses() {
    Set<String> preferred = new LinkedHashSet<>();
    Set<String> hotspot = new LinkedHashSet<>();
    Set<String> others = new LinkedHashSet<>();
    try {
      for (NetworkInterface item : Collections.list(NetworkInterface.getNetworkInterfaces())) {
        String name = item.getName().toLowerCase(Locale.ROOT);
        if (
          !item.isUp() ||
          item.isLoopback() ||
          item.isPointToPoint() ||
          name.matches("(rmnet|ccmni|pdp|tun|ppp|ipsec|dummy|p2p|v4-|clat|lo).*")
        ) {
          continue;
        }
        Set<String> target = name.matches("(wlan|eth).*")
          ? preferred
          : name.matches("(ap|swlan|softap).*")
            ? hotspot
            : others;
        for (InetAddress address : Collections.list(item.getInetAddresses())) {
          byte[] bytes = address.getAddress();
          boolean isBenchmark = (bytes[0] & 0xff) == 198 && (bytes[1] & 0xff & 0xfe) == 18;
          if (
            address instanceof Inet4Address &&
            !address.isLoopbackAddress() &&
            !address.isLinkLocalAddress() &&
            !address.isAnyLocalAddress() &&
            !isBenchmark
          ) {
            target.add(address.getHostAddress());
          }
        }
      }
    } catch (Exception unavailable) {
      // 读不到网卡时按没有地址处理，设备页显示没有可用地址。
    }
    List<String> result = new ArrayList<>(preferred);
    result.addAll(hotspot);
    if (result.isEmpty()) {
      result.addAll(others);
    }
    return result.size() > MAX_ADDRESSES ? result.subList(0, MAX_ADDRESSES) : result;
  }

  private void peerChanged() {
    stateChanged();
  }

  private void stateChanged() {
    ListenerService.refresh(context);
    for (Observer observer : observers) {
      observer.stateChanged();
    }
  }

  private void libraryChanged() {
    for (Observer observer : observers) {
      observer.libraryChanged();
    }
  }
}
