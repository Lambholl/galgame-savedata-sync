package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.copy;
import static io.github.galgame.savedatasync.TransferJson.fail;
import static io.github.galgame.savedatasync.TransferJson.list;
import static io.github.galgame.savedatasync.TransferJson.map;
import static io.github.galgame.savedatasync.TransferJson.object;
import static io.github.galgame.savedatasync.TransferSchema.device;
import static io.github.galgame.savedatasync.TransferSchema.id;
import static io.github.galgame.savedatasync.TransferSchema.parent;
import static io.github.galgame.savedatasync.TransferSchema.require;
import static io.github.galgame.savedatasync.TransferSchema.roots;
import static io.github.galgame.savedatasync.TransferSchema.shape;
import static io.github.galgame.savedatasync.TransferSchema.string;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** 拨号方的设备连接：交换目录表、维护控制通道，并提供浏览对方目录和复制任务用的连接。 */
final class TransferEngine {

  interface Local {
    String deviceId();

    /** 是否有设备连着本机服务的控制通道。 */
    boolean hasListenerPeer();
  }

  /** 接收控制通道的消息和连接状态，消息未经校验。 */
  interface ControlListener {
    void message(String deviceId, String text);

    void state(String deviceId, boolean isOpen, int code);
  }

  /** 原生直接处理的控制消息；返回 true 表示已接管，不再转给页面。 */
  interface ControlInterceptor {
    boolean intercept(String deviceId, String text);
  }

  private final ArchiveAdapter archives;
  private final Local local;
  private final ScheduledExecutorService watch = Executors.newSingleThreadScheduledExecutor(r -> {
    Thread t = new Thread(r, "transfer-control-retry");
    t.setDaemon(true);
    return t;
  });
  private final Map<String, Map<String, Object>> remoteRoots = new HashMap<>();
  private final Map<String, Map<String, Object>> remoteEntries = new HashMap<>();
  private TransferHttp http;
  private Map<String, Object> remoteDevice;
  private String session;
  private String remoteDeviceId;

  private static final class Connection {

    final TransferHttp http;
    final Map<String, Object> descriptor;
    Map<String, Object> hello;
    Map<String, Object> reply;
    boolean wasAnnounced;
    boolean isControlOpen;
    ControlClient control;

    Connection(TransferHttp http, Map<String, Object> descriptor) {
      this.http = http;
      this.descriptor = descriptor;
    }
  }

  private final Map<String, Connection> connections = new LinkedHashMap<>();
  private volatile ControlListener controlListener;
  private volatile ControlInterceptor controlInterceptor;
  private boolean isClosed;
  private boolean isConnecting;

  TransferEngine(ArchiveAdapter archives, Local local) {
    this.archives = archives;
    this.local = local;
  }

  private synchronized void available() throws ArchiveFailure {
    if (isClosed) {
      throw fail("unsupported-operation");
    }
  }

  Map<String, Object> connect(TransferHttp client, ArchiveControl control) throws Exception {
    synchronized (this) {
      available();
      // 本机同一时间只和一台设备保持控制通道，有设备连着本机服务时也不能再拨号。
      if (
        TargetOperation.hasWork() ||
        isConnecting ||
        !connections.isEmpty() ||
        local.hasListenerPeer()
      ) {
        throw fail("busy");
      }
      isConnecting = true;
      http = null;
    }
    try {
      Map<String, Object> descriptor = device(
        client.json("GET", "/v1/device", null, null, 200, control)
      );
      synchronized (this) {
        available();
        control.check();
        http = client;
        remoteDevice = descriptor;
        session = string(descriptor.get("sessionId"));
        remoteDeviceId = string(map(descriptor.get("device")).get("deviceId"));
        if (!connections.containsKey(remoteDeviceId) && connections.size() >= 32) {
          throw fail("resource-limit");
        }
        connections.put(remoteDeviceId, new Connection(client, descriptor));
        remoteRoots.clear();
        remoteEntries.clear();
      }
      return map(copy(descriptor));
    } finally {
      synchronized (this) {
        isConnecting = false;
      }
    }
  }

  void disconnect() throws ArchiveFailure {
    ControlClient client;
    synchronized (this) {
      available();
      if (TargetOperation.hasWork() || isConnecting) {
        throw fail("busy");
      }
      client = detachControl(connections.remove(remoteDeviceId));
      http = null;
      remoteDevice = null;
      session = null;
      remoteRoots.clear();
      remoteEntries.clear();
    }
    if (client != null) {
      client.close();
    }
  }

  /** 本机是否作为拨号方连着或正在连接别的设备。 */
  synchronized boolean isDialing() {
    return isConnecting || !connections.isEmpty();
  }

  synchronized List<Object> connections() throws Exception {
    available();
    List<Object> result = new ArrayList<>();
    for (Connection value : connections.values()) {
      result.add(copy(value.descriptor));
    }
    return result;
  }

  synchronized Map<String, Object> selectDevice(String id) throws Exception {
    available();
    if (isConnecting || (TargetOperation.hasWork() && !id.equals(remoteDeviceId))) {
      throw fail("busy");
    }
    Connection value = connections.get(id);
    if (value == null) {
      throw fail("not-found");
    }
    http = value.http;
    remoteDevice = value.descriptor;
    remoteDeviceId = id;
    session = string(remoteDevice.get("sessionId"));
    remoteRoots.clear();
    remoteEntries.clear();
    return map(copy(remoteDevice));
  }

  void disconnectDevice(String id, ArchiveControl control) throws Exception {
    Connection value;
    synchronized (this) {
      available();
      if (isConnecting || TargetOperation.hasWork()) {
        throw fail("busy");
      }
      value = connections.get(id);
    }
    if (value != null) {
      try {
        value.http.json(
          "POST",
          "/v1/catalog",
          string(value.descriptor.get("sessionId")),
          object("deviceId", local.deviceId(), "goodbye", true),
          200,
          control
        );
      } catch (Exception ignored) {
        /* 本机仍断开；电脑收不到告别时，控制通道关闭后同样把这台移动端算作离线。 */
      }
    }
    ControlClient client;
    synchronized (this) {
      client = detachControl(connections.remove(id));
      if (id.equals(remoteDeviceId)) {
        http = null;
        remoteDevice = null;
        session = null;
        remoteRoots.clear();
        remoteEntries.clear();
      }
    }
    if (client != null) {
      client.close();
    }
  }

  /** 与一台电脑交换目录表，每台电脑独立；当前浏览连接和活动任务不受影响。 */
  Object exchangeCatalog(String id, Object payload, String name, ArchiveControl control)
    throws Exception {
    Connection value;
    synchronized (this) {
      available();
      value = connections.get(id);
    }
    if (value == null) {
      throw fail("not-found");
    }
    Map<String, Object> catalog = shape(copy(payload), "games", "links");
    List<Object> games = list(catalog.get("games"));
    require(games.size() <= 128 && list(catalog.get("links")).size() <= 128);
    List<Object> roots = new ArrayList<>();
    Set<String> rootIds = new HashSet<>();
    for (Object entry : games) {
      Map<String, Object> game = shape(entry, "id", "name", "root", "posterHash");
      id(game.get("id"));
      require(string(game.get("name")).length() <= 128);
      Object posterHash = game.get("posterHash");
      require(
        posterHash == null ||
          (posterHash instanceof String && PosterRules.isPosterHash((String) posterHash))
      );
      if (game.get("root") != null && rootIds.add(id(map(game.get("root")).get("rootId")))) {
        roots.add(game.get("root"));
      }
    }
    TransferSchema.roots(roots, local.deviceId());
    Map<String, Object> hello = object(
      "deviceId",
      local.deviceId(),
      "name",
      name,
      "platform",
      "android",
      "games",
      games,
      "links",
      catalog.get("links")
    );
    boolean isNewConnection;
    synchronized (this) {
      isNewConnection = !value.wasAnnounced;
    }
    Object reply = value.http.json(
      "POST",
      "/v1/catalog",
      string(value.descriptor.get("sessionId")),
      hello,
      200,
      control,
      isNewConnection
    );
    Map<String, Object> replyMap = shape(copy(reply), "games", "links");
    synchronized (this) {
      require(connections.get(id) == value);
      value.wasAnnounced = true;
      value.hello = map(copy(hello));
      value.reply = replyMap;
      openControl(id, value);
    }
    return reply;
  }

  void controlListener(ControlListener listener) {
    controlListener = listener;
  }

  void controlInterceptor(ControlInterceptor interceptor) {
    controlInterceptor = interceptor;
  }

  /** 当前订阅是 listener 时清除它。 */
  synchronized void releaseControlListener(ControlListener listener) {
    // Activity 重建时新的订阅可能先到，所以只清除自己的订阅。
    if (controlListener == listener) {
      controlListener = null;
    }
  }

  /** 首次交换目录表后连上控制通道；意外断开 2 秒后重连，直到本机断开这台设备。 */
  private synchronized void openControl(String id, Connection value) {
    String origin = value.http.origin();
    if (isClosed || value.control != null || connections.get(id) != value || origin == null) {
      return;
    }
    try {
      ControlClient client = new ControlClient(
        origin,
        string(value.descriptor.get("sessionId")),
        local.deviceId(),
        new ControlClient.Events() {
          @Override
          public void opened(ControlClient source) {
            controlChanged(id, source, true, 0);
          }

          @Override
          public void message(ControlClient source, String text) {
            ControlListener listener = controlListener;
            ControlInterceptor interceptor = controlInterceptor;
            boolean isCurrent;
            synchronized (TransferEngine.this) {
              isCurrent = value.control == source && connections.get(id) == value;
            }
            if (!isCurrent || (interceptor != null && interceptor.intercept(id, text))) {
              return;
            }
            if (listener != null) {
              listener.message(id, text);
            }
          }

          @Override
          public void closed(ControlClient source, int code) {
            controlChanged(id, source, false, code);
            retryControl(id, value);
          }
        }
      );
      value.control = client;
      client.connect();
    } catch (Exception cause) {
      retryControl(id, value);
    }
  }

  private void retryControl(String id, Connection value) {
    try {
      watch.schedule(() -> openControl(id, value), 2, TimeUnit.SECONDS);
    } catch (java.util.concurrent.RejectedExecutionException stopped) {
      /* 引擎已关闭。 */
    }
  }

  private void controlChanged(String id, ControlClient source, boolean isOpen, int code) {
    synchronized (this) {
      Connection value = connections.get(id);
      if (value == null || value.control != source) {
        return;
      }
      value.isControlOpen = isOpen;
      if (!isOpen) {
        value.control = null;
      }
    }
    ControlListener listener = controlListener;
    if (listener != null) {
      listener.state(id, isOpen, code);
    }
  }

  /** 摘下控制通道并返回；返回的通道要在引擎锁外关闭。 */
  private static ControlClient detachControl(Connection value) {
    // 读线程持有 WebSocket 的锁回调 onClose，再等引擎锁；持着引擎锁关闭会死锁。
    if (value == null || value.control == null) {
      return null;
    }
    ControlClient client = value.control;
    value.control = null;
    value.isControlOpen = false;
    return client;
  }

  synchronized List<Object> controlStates() throws Exception {
    available();
    List<Object> result = new ArrayList<>();
    for (Map.Entry<String, Connection> item : connections.entrySet()) {
      result.add(object("deviceId", item.getKey(), "isOpen", item.getValue().isControlOpen));
    }
    return result;
  }

  void sendControl(String id, String text) throws Exception {
    ControlClient.check(text);
    ControlClient client;
    synchronized (this) {
      available();
      Connection value = connections.get(id);
      client = value == null || !value.isControlOpen ? null : value.control;
    }
    if (client == null) {
      throw fail("not-found");
    }
    try {
      client.send(text);
    } catch (RuntimeException cause) {
      throw fail("not-found");
    }
  }

  /** 复制任务使用的连接身份，固定为当前已交换目录表的连接。 */
  static final class SyncConnection {

    final TransferHttp http;
    final String session;
    final String deviceId;
    private final Connection identity;

    SyncConnection(Connection identity, String localDeviceId) throws Exception {
      this.identity = identity;
      http = identity.http.forSync(localDeviceId);
      session = id(identity.descriptor.get("sessionId"));
      deviceId = id(map(identity.descriptor.get("device")).get("deviceId"));
    }
  }

  synchronized SyncConnection syncConnection(Map<String, Object> binding) throws Exception {
    connected();
    SyncJobModel.binding(binding);
    require(
      local.deviceId().equals(binding.get("localDeviceId")) &&
        remoteDeviceId.equals(binding.get("remoteDeviceId"))
    );
    Connection connection = connections.get(remoteDeviceId);
    if (
      connection == null ||
      !connection.wasAnnounced ||
      connection.hello == null ||
      connection.reply == null
    ) {
      throw fail("session-mismatch");
    }
    SyncConnection result = new SyncConnection(connection, local.deviceId());
    // 这里只核对会话：存着的电脑目录表可能已过期，准备时 refreshSync 重新交换后再核对目录绑定。
    verifySession(result, binding);
    return result;
  }

  synchronized void verifySync(SyncConnection connection, Map<String, Object> binding)
    throws Exception {
    Connection current = verifySession(connection, binding);
    SyncJobModel.catalogBinding(current.hello, current.reply, binding);
  }

  /** 核对 connection 仍是当前会话、binding 的两端设备与它一致，返回当前连接。 */
  private synchronized Connection verifySession(
    SyncConnection connection,
    Map<String, Object> binding
  ) throws Exception {
    available();
    Connection current = connections.get(connection.deviceId);
    if (
      isConnecting ||
      current != connection.identity ||
      http != current.http ||
      !connection.session.equals(session) ||
      !connection.deviceId.equals(remoteDeviceId)
    ) {
      throw fail("session-mismatch");
    }
    require(
      local.deviceId().equals(binding.get("localDeviceId")) &&
        connection.deviceId.equals(binding.get("remoteDeviceId"))
    );
    return current;
  }

  void refreshSync(SyncConnection connection, Map<String, Object> binding, ArchiveControl control)
    throws Exception {
    Map<String, Object> hello;
    synchronized (this) {
      // 交换前不核对目录绑定：上次交换存下的“不可用”会挡住这次刷新，目录恢复后也一直失败。
      verifySession(connection, binding);
      hello = map(copy(connection.identity.hello));
    }
    exchangeCatalog(
      connection.deviceId,
      object("games", hello.get("games"), "links", hello.get("links")),
      string(hello.get("name")),
      control
    );
    synchronized (this) {
      verifySync(connection, binding);
    }
  }

  ArchiveAdapter syncArchive() {
    return archives;
  }

  private synchronized TransferHttp connected() throws ArchiveFailure {
    available();
    if (isConnecting) {
      throw fail("busy");
    }
    if (http == null) {
      throw fail("not-found");
    }
    return http;
  }

  List<Object> roots(ArchiveControl control) throws Exception {
    TransferHttp client;
    String currentSession;
    String deviceId;
    synchronized (this) {
      client = connected();
      currentSession = session;
      deviceId = remoteDeviceId;
    }
    List<Object> values = TransferSchema.roots(
      client.json("GET", "/v1/roots", currentSession, null, 200, control),
      deviceId
    );
    synchronized (this) {
      available();
      control.check();
      require(http == client && currentSession.equals(session));
      remoteRoots.clear();
      remoteEntries.clear();
      for (Object r : values) {
        remoteRoots.put(string(map(r).get("rootId")), map(r));
      }
    }
    return list(copy(values));
  }

  Map<String, Object> directory(String rootId, String parentId, ArchiveControl control)
    throws Exception {
    id(rootId);
    parent(parentId);
    TransferHttp client;
    String currentSession;
    synchronized (this) {
      client = connected();
      currentSession = session;
      require(remoteRoots.containsKey(rootId));
      if (parentId != null) {
        Map<String, Object> p = remoteEntries.get(rootId + "\n" + parentId);
        require(p != null && "directory".equals(p.get("kind")));
      }
    }
    String path =
      "/v1/roots/" + rootId + "/entries" + (parentId == null ? "" : "?parentId=" + parentId);
    Map<String, Object> listing = TransferSchema.directory(
      client.json("GET", path, currentSession, null, 200, control),
      rootId,
      parentId
    );
    synchronized (this) {
      available();
      control.check();
      require(http == client && currentSession.equals(session));
      for (Object e : list(listing.get("entries"))) {
        String key = rootId + "\n" + string(map(e).get("entryId"));
        if (!remoteEntries.containsKey(key) && remoteEntries.size() >= 32768) {
          throw fail("resource-limit");
        }
        remoteEntries.put(key, map(e));
      }
    }
    return map(copy(listing));
  }

  /** 销毁引擎：关闭全部控制通道，之后的调用报 unsupported-operation。 */
  void close() {
    List<ControlClient> clients = new ArrayList<>();
    synchronized (this) {
      if (isClosed) {
        return;
      }
      isClosed = true;
      for (Connection value : connections.values()) {
        ControlClient client = detachControl(value);
        if (client != null) {
          clients.add(client);
        }
      }
    }
    for (ControlClient client : clients) {
      client.close();
    }
    watch.shutdown();
  }
}
