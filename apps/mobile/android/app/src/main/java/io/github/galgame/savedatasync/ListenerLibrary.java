package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.copy;
import static io.github.galgame.savedatasync.TransferJson.fail;
import static io.github.galgame.savedatasync.TransferJson.list;
import static io.github.galgame.savedatasync.TransferJson.map;
import static io.github.galgame.savedatasync.TransferJson.object;
import static io.github.galgame.savedatasync.TransferSchema.id;
import static io.github.galgame.savedatasync.TransferSchema.require;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * 本机作为监听方时的游戏库：处理拨号方提交的目录表，保存设备和关联，答复本机目录表；对端目录表和读到的条目只在本次服务会话内保留。
 * 改写游戏库配置后，在调用线程上、不持有本对象的锁时调用 {@link Changes#changed}。
 *
 * <p>会话内的对端状态和游戏库配置的读改写由本对象的锁保护；持锁时会读写 {@link Store} 和读取 {@link Host#roots}，
 * 不做网络读写，不调用外部回调。
 */
final class ListenerLibrary {

  /** 游戏库配置的保存位置，读写都是共享 LibraryConfig 格式的完整 JSON 文本。 */
  interface Store {
    /** 返回保存的配置；从没保存过时返回 null。 */
    String read() throws Exception;

    void write(String value) throws Exception;
  }

  /** 本机的目录登记和拨号状态。 */
  interface Host {
    /** 本机已登记的根目录，元素是共享 DirectoryReference 的 JSON 对象。 */
    List<Object> roots() throws Exception;

    /** 本机是否正作为拨号方连着或正在连接别的设备。 */
    boolean isDialing();

    /**
     * 读出本机一个游戏的封面文件。
     *
     * @return WebP 文件内容。
     * @throws ArchiveFailure 文件不存在时为 not-found，读取失败时为 io-failure。
     */
    byte[] poster(String gameId, String posterHash) throws Exception;
  }

  /** 游戏库配置被本类改写后调用。 */
  interface Changes {
    void changed();
  }

  private static final class Peer {

    final Map<String, Object> hello;
    final long seenAt;
    final Set<String> entries;

    Peer(Map<String, Object> hello, long seenAt, Set<String> entries) {
      this.hello = hello;
      this.seenAt = seenAt;
      this.entries = entries;
    }
  }

  /** 游戏库配置的格式版本，与共享 LIBRARY_SCHEMA_VERSION 相同。 */
  static final int LIBRARY_VERSION = 3;
  /** 游戏库配置的迁移链，步骤与共享 LIBRARY_MIGRATIONS 一一对应。 */
  static final DataMigration.Chain LIBRARY_MIGRATIONS = new DataMigration.Chain(
    2,
    LIBRARY_VERSION,
    // 版本 3 的平台多了 linux，已有内容不变；版本号加一让 1.0 拒绝启动，而不是把含 linux 的游戏库当成损坏数据删除。
    Map.of(2, value -> {
      Map<String, Object> next = new LinkedHashMap<>(value);
      next.put("schemaVersion", 3);
      return next;
    })
  );
  /** 已保存设备的最多台数，也是一个游戏的关联和排除设备的最多条数；与共享 LIBRARY_LIMITS.maxDevices 相同。 */
  private static final int MAX_DEVICES = 32;
  /** 设备名和游戏名的最大长度（UTF-16 码元），与共享 LIBRARY_LIMITS.maxNameLength 相同。 */
  static final int MAX_NAME_LENGTH = 128;
  /** 游戏库和目录表里游戏的最多条数，目录表里关联的最多条数；与共享 LIBRARY_LIMITS.maxGames 相同。 */
  private static final int MAX_GAMES = 128;
  /** 每台对端设备在本会话里记下的已读条目的最多条数。 */
  private static final int MAX_ENTRIES = 32768;
  /** 保存的封面文件的最大字节数，与共享 POSTER_LIMITS.maxSavedBytes 相同。 */
  private static final int POSTER_MAX_SAVED_BYTES = 1024 * 1024;
  private final Store store;
  private final Host host;
  private final ListenerControl control;
  private final Changes changes;
  private final Map<String, Peer> runtime = new LinkedHashMap<>();
  private final Set<String> disconnected = new HashSet<>();

  ListenerLibrary(Store store, Host host, ListenerControl control, Changes changes) {
    this.store = store;
    this.host = host;
    this.control = control;
    this.changes = changes;
  }

  /**
   * 处理拨号方提交的目录表：保存设备和关联，返回本机游戏表和与它的关联。对方告别时断开它并返回空表。
   *
   * @param isNewConnection 对方新建连接；本机断开过的设备只能这样重新交换。
   * @throws ArchiveFailure 内容无效时为 invalid-request，设备停用时为 permission-denied，本机断开过它时为
   *     session-mismatch，另一台设备在用或本机正连着别的设备时为 busy，已保存的设备达到 {@link #MAX_DEVICES} 台时为 resource-limit。
   */
  Map<String, Object> exchange(Object value, boolean isNewConnection) throws Exception {
    Map<String, Object> body = map(value);
    if (body.containsKey("goodbye")) {
      TransferSchema.shape(body, "deviceId", "goodbye");
      require(Boolean.TRUE.equals(body.get("goodbye")));
      String peerId = id(body.get("deviceId"));
      synchronized (this) {
        runtime.remove(peerId);
        disconnected.remove(peerId);
      }
      control.disconnect(peerId);
      return object("games", new ArrayList<>(), "links", new ArrayList<>());
    }
    Map<String, Object> hello = hello(body);
    Map<String, Object> reply;
    boolean isChanged;
    synchronized (this) {
      isChanged = accept(hello, isNewConnection);
      reply = local((String) hello.get("deviceId"));
    }
    if (isChanged) {
      changes.changed();
    }
    return reply;
  }

  /** 登记 hello 的设备并保存设备和关联；返回配置是否改变。调用前必须持有本对象的锁。 */
  private boolean accept(Map<String, Object> hello, boolean isNewConnection) throws Exception {
    String peerId = (String) hello.get("deviceId");
    Map<String, Object> config = config();
    Map<String, Object> saved = find(list(config.get("devices")), peerId);
    if (saved != null && Boolean.TRUE.equals(saved.get("isBlocked"))) {
      throw new ArchiveFailure("permission-denied", "This device is disabled.");
    }
    if (isNewConnection) {
      disconnected.remove(peerId);
    } else if (disconnected.contains(peerId)) {
      throw fail("session-mismatch");
    }
    if (host.isDialing() || hasOtherPeer(peerId)) {
      throw new ArchiveFailure(
        "busy",
        "This device is connected to another device. Disconnect it first."
      );
    }
    if (saved == null && list(config.get("devices")).size() >= MAX_DEVICES) {
      throw new ArchiveFailure(
        "resource-limit",
        "At most " + MAX_DEVICES + " devices can be saved."
      );
    }
    Peer previous = runtime.get(peerId);
    runtime.put(
      peerId,
      new Peer(
        hello,
        System.currentTimeMillis(),
        previous == null ? new HashSet<>() : previous.entries
      )
    );
    List<Object> devices = new ArrayList<>(list(config.get("devices")));
    // 每次新连接把设备移到开头，已保存的设备按最近连接排序；连接期间的目录刷新不改顺序。
    if (isNewConnection || saved == null) {
      devices.remove(saved);
      devices.add(
        0,
        saved != null
          ? saved
          : object(
              "id",
              peerId,
              "name",
              hello.get("name"),
              "platform",
              hello.get("platform"),
              "address",
              null,
              "isBlocked",
              false
            )
      );
    }
    List<Object> links = new ArrayList<>();
    Set<String> gameIds = new HashSet<>();
    for (Object game : list(hello.get("games"))) {
      gameIds.add((String) map(game).get("id"));
    }
    for (Object link : list(hello.get("links"))) {
      if (gameIds.contains(map(link).get("localGameId"))) {
        links.add(link);
      }
    }
    Map<String, Object> next = new LinkedHashMap<>(config);
    next.put("devices", devices);
    return save(mergeLinks(next, peerId, links), config);
  }

  /** 本机发给 peerId 的目录表：本机游戏和与它的关联。 */
  synchronized Map<String, Object> local(String peerId) throws Exception {
    Map<String, Object> config = config();
    List<Object> roots = host.roots();
    List<Object> games = new ArrayList<>();
    List<Object> links = new ArrayList<>();
    for (Object item : list(config.get("games"))) {
      Map<String, Object> game = map(item);
      Object root = null;
      for (Object candidate : roots) {
        if (Objects.equals(map(candidate).get("rootId"), game.get("rootId"))) {
          root = candidate;
          break;
        }
      }
      games.add(
        object(
          "id",
          game.get("id"),
          "name",
          game.get("name"),
          "root",
          root,
          "posterHash",
          game.get("posterHash")
        )
      );
      for (Object link : list(game.get("links"))) {
        if (peerId.equals(map(link).get("deviceId"))) {
          links.add(object("localGameId", game.get("id"), "remoteGameId", map(link).get("gameId")));
        }
      }
    }
    return object("games", games, "links", links);
  }

  /** 判断设备能否建立控制通道：本会话交换过目录表、没有停用、没有被本机断开，没有其他设备连着，本机也没有在拨号。 */
  synchronized boolean canControl(String peerId) {
    try {
      Map<String, Object> saved = find(list(config().get("devices")), peerId);
      return (
        saved != null &&
        !Boolean.TRUE.equals(saved.get("isBlocked")) &&
        runtime.containsKey(peerId) &&
        !disconnected.contains(peerId) &&
        !hasOtherPeer(peerId) &&
        !host.isDialing()
      );
    } catch (Exception unreadable) {
      return false;
    }
  }

  /** 断开 peerId：以 {@link ListenerControl#CLOSE_DISCONNECTED} 关闭控制通道，之后它只能以新连接重新交换目录表。 */
  void disconnect(String peerId) {
    synchronized (this) {
      disconnected.add(peerId);
      runtime.remove(peerId);
    }
    control.disconnect(peerId);
  }

  /** 交换过目录表的设备和它们的游戏表，元素为 {deviceId, name, platform, isOpen, games}。 */
  synchronized List<Object> peers() throws Exception {
    List<Object> result = new ArrayList<>();
    for (Map.Entry<String, Peer> entry : runtime.entrySet()) {
      Map<String, Object> hello = entry.getValue().hello;
      result.add(
        object(
          "deviceId",
          entry.getKey(),
          "name",
          hello.get("name"),
          "platform",
          hello.get("platform"),
          "isOpen",
          control.isOpen(entry.getKey()),
          "games",
          copy(hello.get("games"))
        )
      );
    }
    return result;
  }

  /**
   * 经控制通道读取对端一个已关联游戏目录的一层；parentId 必须来自本会话读到的条目。
   *
   * @return 以共享 DirectoryListing 完成；对方离线、目录不在它的目录表里或父目录没读到过时以 ArchiveFailure 完成。
   */
  CompletableFuture<Object> directory(String peerId, String rootId, String parentId) {
    CompletableFuture<Object> failed = new CompletableFuture<>();
    Set<String> entries;
    synchronized (this) {
      Peer peer = runtime.get(peerId);
      boolean hasRoot = false;
      if (peer != null) {
        try {
          for (Object game : list(peer.hello.get("games"))) {
            Object root = map(game).get("root");
            hasRoot |= root != null && rootId.equals(map(root).get("rootId"));
          }
        } catch (ArchiveFailure invalid) {
          hasRoot = false;
        }
      }
      if (peer == null || !control.isOpen(peerId) || !hasRoot) {
        failed.completeExceptionally(
          new ArchiveFailure(
            "not-found",
            "The device is offline or the directory reference expired."
          )
        );
        return failed;
      }
      if (parentId != null && !peer.entries.contains(rootId + "\n" + parentId)) {
        failed.completeExceptionally(
          new ArchiveFailure("invalid-request", "Browse again from the game's root directory.")
        );
        return failed;
      }
      entries = peer.entries;
    }
    return control
      .request(peerId, "directory.list", object("rootId", rootId, "parentId", parentId))
      .thenApply(value -> {
        try {
          Map<String, Object> listing = TransferSchema.directory(value, rootId, parentId);
          synchronized (this) {
            for (Object item : list(listing.get("entries"))) {
              if (entries.size() < MAX_ENTRIES) {
                entries.add(rootId + "\n" + map(item).get("entryId"));
              }
            }
          }
          return listing;
        } catch (ArchiveFailure invalid) {
          throw new java.util.concurrent.CompletionException(invalid);
        }
      });
  }

  /**
   * 读出本机一个游戏的封面。
   *
   * @return 共享 PeerPoster 的 JSON 对象。
   * @throws ArchiveFailure 游戏不存在、没有封面或封面文件不存在时为 not-found，读取失败时为 io-failure。
   */
  Map<String, Object> localPoster(String gameId) throws Exception {
    Map<String, Object> game;
    synchronized (this) {
      game = find(list(config().get("games")), gameId);
    }
    Object hash = game == null ? null : game.get("posterHash");
    if (!(hash instanceof String)) {
      throw new ArchiveFailure("not-found", "The game has no poster.");
    }
    // 读文件不持锁：封面文件只经改名出现，读到的总是完整的文件。
    byte[] content = host.poster(gameId, (String) hash);
    return object(
      "hash",
      hash,
      "source",
      game.get("posterSource"),
      "data",
      Base64.getEncoder().encodeToString(content)
    );
  }

  /**
   * 经控制通道读取连着本机的设备一个游戏的封面。
   *
   * @return 以共享 PeerPoster 完成；对方离线或它的目录表里这个游戏没有封面时以 not-found 的 ArchiveFailure 完成，
   *     超时、断开或答复不合格式时以对应的 ArchiveFailure 完成。
   */
  CompletableFuture<Object> peerPoster(String peerId, String gameId) {
    boolean hasPoster = false;
    synchronized (this) {
      Peer peer = runtime.get(peerId);
      if (peer != null && control.isOpen(peerId)) {
        try {
          Map<String, Object> game = find(list(peer.hello.get("games")), gameId);
          hasPoster = game != null && game.get("posterHash") != null;
        } catch (ArchiveFailure invalid) {
          hasPoster = false;
        }
      }
    }
    if (!hasPoster) {
      CompletableFuture<Object> failed = new CompletableFuture<>();
      failed.completeExceptionally(
        new ArchiveFailure("not-found", "The device is offline or the game has no poster.")
      );
      return failed;
    }
    return control.request(peerId, "poster.read", object("gameId", gameId)).thenApply(value -> {
      try {
        return checkPeerPoster(value);
      } catch (ArchiveFailure invalid) {
        throw new java.util.concurrent.CompletionException(invalid);
      }
    });
  }

  /** 校验对端答复的封面，规则同共享 isPeerPoster；返回原值。 */
  private static Object checkPeerPoster(Object value) throws ArchiveFailure {
    Map<String, Object> poster = TransferSchema.shape(value, "hash", "source", "data");
    Object hash = poster.get("hash");
    require(hash instanceof String && PosterRules.isPosterHash((String) hash));
    Object source = poster.get("source");
    if (source != null) {
      TransferSchema.one(source, "vndb", "nextmoe", "bangumi", "steam", "local");
    }
    Object data = poster.get("data");
    // base64 后的长度上限：POSTER_MAX_SAVED_BYTES 字节编码出的长度。
    require(
      data instanceof String &&
        !((String) data).isEmpty() &&
        ((String) data).length() <= ((POSTER_MAX_SAVED_BYTES + 2) / 3) * 4
    );
    return value;
  }

  /** 目录表里的 posterHash 只能是 null 或 64 位小写十六进制。 */
  private static void requirePosterHash(Object value) throws ArchiveFailure {
    require(value == null || (value instanceof String && PosterRules.isPosterHash((String) value)));
  }

  /**
   * 本机项目与 peerId 的关联：对端项目 ID、本机根目录 ID 和对端根目录 ID，依次放在数组里。
   *
   * @return 项目没选目录、没有关联这台设备、对端目录表里没有关联的项目或它没选目录时返回 null。
   */
  synchronized String[] link(String projectId, String peerId) throws Exception {
    Map<String, Object> game = find(list(config().get("games")), projectId);
    Peer peer = runtime.get(peerId);
    if (game == null || game.get("rootId") == null || peer == null) {
      return null;
    }
    for (Object item : list(game.get("links"))) {
      Map<String, Object> link = map(item);
      if (peerId.equals(link.get("deviceId"))) {
        Map<String, Object> remote = find(
          list(peer.hello.get("games")),
          (String) link.get("gameId")
        );
        Object root = remote == null ? null : remote.get("root");
        return root == null
          ? null
          : new String[] {
              (String) link.get("gameId"),
              (String) game.get("rootId"),
              (String) map(root).get("rootId"),
            };
      }
    }
    return null;
  }

  /**
   * 核对项目与对端的双向关联和公开根目录：本机项目用 localRootId、关联 peerId 的 remoteProjectId，对端目录表也关联回来，
   * 对端项目的根目录是 remoteRootId、属于 peerId 且已授权；设备已保存、没停用、本会话交换过目录表且没被本机断开。
   *
   * @throws ArchiveFailure 任一项不符时抛出 session-mismatch。
   */
  synchronized void verifyProject(
    String projectId,
    String peerId,
    String remoteProjectId,
    String localRootId,
    String remoteRootId
  ) throws Exception {
    boolean isLinked;
    try {
      Map<String, Object> config = config();
      Map<String, Object> game = find(list(config.get("games")), projectId);
      Map<String, Object> device = find(list(config.get("devices")), peerId);
      Peer peer = runtime.get(peerId);
      Map<String, Object> remote =
        peer == null ? null : find(list(peer.hello.get("games")), remoteProjectId);
      Object root = remote == null ? null : remote.get("root");
      Object excluded = game == null ? null : game.get("excludedLinks");
      isLinked =
        game != null &&
        localRootId.equals(game.get("rootId")) &&
        device != null &&
        !Boolean.TRUE.equals(device.get("isBlocked")) &&
        peer != null &&
        !disconnected.contains(peerId) &&
        (excluded == null ||
          !list(excluded).contains(object("deviceId", peerId, "gameId", remoteProjectId))) &&
        list(game.get("links")).contains(object("deviceId", peerId, "gameId", remoteProjectId)) &&
        list(peer.hello.get("links")).contains(
          object("localGameId", remoteProjectId, "remoteGameId", projectId)
        ) &&
        root != null &&
        remoteRootId.equals(map(root).get("rootId")) &&
        peerId.equals(map(root).get("deviceId")) &&
        "granted".equals(map(root).get("authorization"));
    } catch (ArchiveFailure invalid) {
      isLinked = false;
    }
    if (!isLinked) {
      throw new ArchiveFailure(
        "session-mismatch",
        "The project link or device directory changed. Confirm again."
      );
    }
  }

  /**
   * 核对 peerId 仍是本会话连着本机的设备，复制请求和内容到达时调用。
   *
   * @throws ArchiveFailure 设备没保存、已停用、本会话没交换过目录表或被本机断开时抛出 session-mismatch，另一台设备在用或本机在拨号时抛出 busy。
   */
  synchronized void touch(String peerId) throws Exception {
    Map<String, Object> saved = find(list(config().get("devices")), peerId);
    if (
      saved == null ||
      Boolean.TRUE.equals(saved.get("isBlocked")) ||
      !runtime.containsKey(peerId) ||
      disconnected.contains(peerId)
    ) {
      throw new ArchiveFailure(
        "session-mismatch",
        "The device connection changed. Reconnect the device."
      );
    }
    if (hasOtherPeer(peerId) || host.isDialing()) {
      throw new ArchiveFailure(
        "busy",
        "This device is connected to another device. Disconnect it first."
      );
    }
  }

  /** 清空会话内的对端状态。 */
  synchronized void reset() {
    runtime.clear();
    disconnected.clear();
  }

  private boolean hasOtherPeer(String peerId) {
    String open = control.peerId();
    return open != null && !open.equals(peerId);
  }

  private Map<String, Object> config() throws Exception {
    String saved = store.read();
    if (saved == null) {
      return object(
        "schemaVersion",
        LIBRARY_VERSION,
        "games",
        new ArrayList<>(),
        "devices",
        new ArrayList<>()
      );
    }
    Object value;
    try {
      value = TransferJson.parse(saved.getBytes(StandardCharsets.UTF_8));
      checkConfig(value);
    } catch (ArchiveFailure invalid) {
      throw new ArchiveFailure(
        "internal-error",
        "The game configuration is damaged. Preserve app data and inspect it.",
        false,
        invalid
      );
    }
    return map(value);
  }

  /** 保存 next；返回配置是否改变。 */
  private boolean save(Map<String, Object> next, Map<String, Object> previous) throws Exception {
    // 网页层读到不符合 isLibraryConfig 的配置会当作损坏，所以写入前先校验。
    checkConfig(next);
    byte[] bytes = TransferJson.bytes(next);
    if (Arrays.equals(bytes, TransferJson.bytes(previous))) {
      return false;
    }
    store.write(new String(bytes, StandardCharsets.UTF_8));
    return true;
  }

  private static Map<String, Object> find(List<Object> items, String id) throws ArchiveFailure {
    for (Object item : items) {
      if (id.equals(map(item).get("id"))) {
        return map(item);
      }
    }
    return null;
  }

  /**
   * 按对端目录表同步本机游戏与该设备的关联，规则同共享 mergeCatalogLinks：对端关联到本机游戏的加入关联（本机游戏的 excludedLinks 里有这条关联的除外）；
   * 本机记录的对端游戏已改为关联本机另一个现存游戏的，移除旧关联。
   */
  static Map<String, Object> mergeLinks(
    Map<String, Object> config,
    String peerId,
    List<Object> links
  ) throws ArchiveFailure {
    Set<Object> gameIds = new HashSet<>();
    for (Object item : list(config.get("games"))) {
      gameIds.add(map(item).get("id"));
    }
    List<Object> games = new ArrayList<>();
    for (Object item : list(config.get("games"))) {
      Map<String, Object> game = map(item);
      Map<String, Object> previous = null;
      List<Object> others = new ArrayList<>();
      for (Object existing : list(game.get("links"))) {
        if (peerId.equals(map(existing).get("deviceId"))) {
          previous = map(existing);
        } else {
          others.add(existing);
        }
      }
      Object excluded = game.get("excludedLinks");
      boolean hasPeerLink = false;
      Map<String, Object> link = null;
      // 对端可能有几个游戏都关联着这个游戏，如本机解除过的旧关联加上对端新导入的。跳过排除的；
      // 本机已有的那条优先，否则每次交换换一条，对端会按“改关联了”删掉自己的关联。
      for (Object candidate : links) {
        Map<String, Object> value = map(candidate);
        if (!Objects.equals(value.get("remoteGameId"), game.get("id"))) {
          continue;
        }
        hasPeerLink = true;
        if (
          excluded != null &&
          list(excluded).contains(object("deviceId", peerId, "gameId", value.get("localGameId")))
        ) {
          continue;
        }
        if (
          link == null ||
          (previous != null && Objects.equals(value.get("localGameId"), previous.get("gameId")))
        ) {
          link = value;
        }
      }
      boolean isMoved = false;
      if (!hasPeerLink && previous != null) {
        for (Object candidate : links) {
          Map<String, Object> value = map(candidate);
          // 对端的关联指向本机已删除的游戏时是它没来得及更新的旧关联，不能据此删掉本机刚建的关联。
          isMoved |=
            Objects.equals(value.get("localGameId"), previous.get("gameId")) &&
            !Objects.equals(value.get("remoteGameId"), game.get("id")) &&
            gameIds.contains(value.get("remoteGameId"));
        }
      }
      if (isMoved) {
        Map<String, Object> next = new LinkedHashMap<>(game);
        next.put("links", others);
        games.add(next);
      } else if (link != null) {
        others.add(object("deviceId", peerId, "gameId", link.get("localGameId")));
        Map<String, Object> next = new LinkedHashMap<>(game);
        next.put("links", others);
        games.add(next);
      } else {
        games.add(game);
      }
    }
    Map<String, Object> result = new LinkedHashMap<>(config);
    result.put("games", games);
    return result;
  }

  /** 校验拨号方提交的目录表，规则同共享 isCatalogHello；返回副本。 */
  static Map<String, Object> hello(Map<String, Object> value) throws Exception {
    Map<String, Object> hello = TransferSchema.shape(
      copy(value),
      "deviceId",
      "name",
      "platform",
      "games",
      "links"
    );
    final String peerId = id(hello.get("deviceId"));
    require(isName(hello.get("name")));
    TransferSchema.platform(hello.get("platform"));
    List<Object> games = list(hello.get("games"));
    List<Object> links = list(hello.get("links"));
    require(games.size() <= MAX_GAMES && links.size() <= MAX_GAMES);
    Set<String> gameIds = new HashSet<>();
    Map<String, Object> roots = new HashMap<>();
    for (Object item : games) {
      Map<String, Object> game = TransferSchema.shape(item, "id", "name", "root", "posterHash");
      require(gameIds.add(id(game.get("id"))) && isName(game.get("name")));
      requirePosterHash(game.get("posterHash"));
      Object root = game.get("root");
      if (root != null) {
        String rootId = id(map(root).get("rootId"));
        // 同一个目录可以属于多个游戏，引用必须一致。
        require(!roots.containsKey(rootId) || roots.get(rootId).equals(root));
        roots.put(rootId, root);
      }
    }
    TransferSchema.roots(new ArrayList<>(roots.values()), peerId);
    Set<String> linked = new HashSet<>();
    for (Object item : links) {
      Map<String, Object> link = TransferSchema.shape(item, "localGameId", "remoteGameId");
      require(linked.add(id(link.get("localGameId"))));
      id(link.get("remoteGameId"));
    }
    return hello;
  }

  /**
   * 校验整份游戏库配置，规则同共享 isLibraryConfig。
   *
   * @throws ArchiveFailure 不符合时抛出 invalid-request。
   */
  static void checkConfig(Object value) throws ArchiveFailure {
    Map<String, Object> config = map(value);
    require(Long.valueOf(LIBRARY_VERSION).equals(asLong(config.get("schemaVersion"))));
    List<Object> games = list(config.get("games"));
    List<Object> devices = list(config.get("devices"));
    require(games.size() <= MAX_GAMES && devices.size() <= MAX_DEVICES);
    Set<String> deviceIds = new HashSet<>();
    for (Object item : devices) {
      Map<String, Object> device = map(item);
      require(deviceIds.add(id(device.get("id"))) && isName(device.get("name")));
      TransferSchema.platform(device.get("platform"));
      require(device.get("isBlocked") instanceof Boolean);
      Object address = device.get("address");
      require(
        device.containsKey("address") &&
          (address == null || (address instanceof String && ((String) address).length() <= 256))
      );
    }
    Set<String> gameIds = new HashSet<>();
    for (Object item : games) {
      Map<String, Object> game = map(item);
      require(gameIds.add(id(game.get("id"))) && isName(game.get("name")));
      require(game.containsKey("rootId"));
      if (game.get("rootId") != null) {
        id(game.get("rootId"));
      }
      List<Object> links = list(game.get("links"));
      require(links.size() <= MAX_DEVICES);
      Set<String> linkedDevices = new HashSet<>();
      for (Object link : links) {
        Map<String, Object> value2 = map(link);
        String deviceId = id(value2.get("deviceId"));
        id(value2.get("gameId"));
        require(linkedDevices.add(deviceId) && deviceIds.contains(deviceId));
      }
      if (game.containsKey("excludedLinks")) {
        List<Object> excluded = list(game.get("excludedLinks"));
        require(excluded.size() <= MAX_DEVICES);
        for (Object link : excluded) {
          id(map(link).get("deviceId"));
          id(map(link).get("gameId"));
        }
      }
    }
  }

  private static Long asLong(Object value) {
    return value instanceof Number ? ((Number) value).longValue() : null;
  }

  /**
   * 共享 library.ts 的名称规则：1 到 {@link #MAX_NAME_LENGTH} 个 UTF-16 码元，没有控制字符，
   * 去掉 JavaScript trim 认的空白后不为空。
   */
  static boolean isName(Object value) {
    if (!(value instanceof String)) {
      return false;
    }
    String text = (String) value;
    if (text.isEmpty() || text.length() > MAX_NAME_LENGTH) {
      return false;
    }
    boolean isBlank = true;
    for (int i = 0; i < text.length(); i++) {
      char c = text.charAt(i);
      if (c < 32) {
        return false;
      }
      isBlank &= isJavaScriptSpace(c);
    }
    return !isBlank;
  }

  /** String.prototype.trim 去掉的字符：WhiteSpace 和 LineTerminator（ECMA-262）。 */
  private static boolean isJavaScriptSpace(char c) {
    return (
      c == 0x20 ||
      c == 0xa0 ||
      c == 0xfeff ||
      c == 0x2028 ||
      c == 0x2029 ||
      Character.getType(c) == Character.SPACE_SEPARATOR
    );
  }
}
