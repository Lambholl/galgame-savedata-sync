package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferSchema.id;

import android.content.Context;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * 进程内共享的复制入口：本机作为拨号方时交给复制引擎，作为监听方时交给本机服务当前会话的任务登记表；确认执行或对方登记任务后启动传输通知。
 */
final class SyncTransferRuntime {

  /** 复制任务的通知。 */
  interface Events {
    /** 对方开始了一个复制任务，本机这一端的项目是 projectId；在对方登记任务的连接线程上调用。 */
    void peerJobStarted(String jobId, String projectId);
  }

  /** 记住先后顺序的任务 ID 上限；超出时丢掉最早的。 */
  private static final int MAX_ORDER = 64;
  private static SyncTransferRuntime instance;
  final SyncTransferEngine engine;
  private final TransferEngine transport;
  private final SyncTransferEngine.Local local;
  private final SyncWriter writer;
  private final DirectoryStore store;
  private final Context context;
  private final ExecutorService controls = Executors.newSingleThreadExecutor();
  /** 两种角色的任务 ID，按开始的先后；由本对象的锁保护。 */
  private final Set<String> order = new LinkedHashSet<>();
  private volatile Events events;

  static synchronized SyncTransferRuntime get(Context context) throws Exception {
    if (instance == null) {
      instance = new SyncTransferRuntime(context.getApplicationContext());
    }
    return instance;
  }

  static synchronized SyncTransferRuntime peek() {
    return instance;
  }

  private SyncTransferRuntime(Context context) throws Exception {
    this.context = context;
    store = DirectoryRuntime.store(context);
    BackupStore backups = DirectoryRuntime.backups(context);
    writer = new SyncWriter(new DirectorySyncBackend(context, store, this::authorize), backups);
    local = new SyncTransferEngine.Local() {
      @Override
      public String deviceId() {
        return store.deviceId();
      }

      @Override
      public Map<String, Object> snapshot(String rootId, ArchiveControl control) throws Exception {
        return DirectoryRuntime.scanner(context).snapshotNow(rootId, control);
      }

      @Override
      public List<ArchiveModel.Source> sources(SyncPlanModel.Plan plan) throws Exception {
        List<ArchiveModel.Source> sources = new ArrayList<>();
        for (Map<String, Object> operation : plan.writes) {
          if (SyncPlanModel.isFileWrite(operation)) {
            sources.add(
              new DirectoryArchiveSource(
                store,
                plan.source.root,
                id(operation.get("sourceEntryId"))
              )
            );
          }
        }
        return sources;
      }

      @Override
      public long checkReceiveSpace(
        SyncPlanModel.Plan plan,
        java.nio.file.Path cacheRoot,
        long cacheBytes,
        ArchiveControl control,
        SyncWriter.Execution execution
      ) throws Exception {
        return writer.checkReceiveSpace(plan, cacheRoot, cacheBytes, control, execution);
      }

      @Override
      public Map<String, Object> apply(
        SyncPlanModel.Plan plan,
        SyncWriter.Material material,
        ArchiveControl control,
        SyncWriter.Execution execution
      ) throws Exception {
        return writer.apply(plan.value, material, control, execution);
      }

      @Override
      public boolean retryCleanup() {
        return writer.retryCleanup();
      }

      @Override
      public void close() throws Exception {
        writer.close();
      }
    };
    transport = TransferRuntime.get(context).engine;
    engine = new SyncTransferEngine(transport, local);
  }

  /** 设置复制任务通知的接收者；null 表示不通知。 */
  void events(Events value) {
    events = value;
  }

  /** 本机服务用的复制能力；每次调用创建一个新的扫描器，归调用方的服务会话所有。 */
  ListenerServer.Sync listenerSync() {
    ArchiveAdapter archives = transport.syncArchive();
    SyncScanner scanner = new SyncScanner(new DirectorySyncSource(store));
    return new ListenerServer.Sync() {
      @Override
      public SyncTransferEngine.Local local() {
        return local;
      }

      @Override
      public ArchiveAdapter archives() {
        return archives;
      }

      @Override
      public SyncScanner scanner() {
        return scanner;
      }

      @Override
      public boolean isBusy() {
        return engine.busy();
      }

      @Override
      public void registered(String jobId, String projectId, boolean isPeerInitiated) {
        remember(jobId);
        // 前台服务让任务在页面退到后台后继续。
        try {
          TransferService.launch(context);
        } catch (Exception ignored) {
          // 服务正在启动时由它刷新通知；系统不接受时任务照常进行，只是没有通知。
        }
        Events receiver = events;
        if (isPeerInitiated && receiver != null) {
          receiver.peerJobStarted(jobId, projectId);
        }
      }
    };
  }

  private synchronized void remember(String jobId) {
    order.remove(jobId);
    order.add(jobId);
    while (order.size() > MAX_ORDER) {
      String oldest = order.iterator().next();
      order.remove(oldest);
    }
  }

  /** 本机服务当前会话的复制任务；服务没运行时为 null。 */
  private static ListenerServer server() {
    ListenerRuntime runtime = ListenerRuntime.peek();
    ListenerServer server = runtime == null ? null : runtime.server();
    return server == null || server.jobs() == null ? null : server;
  }

  private static ListenerSyncJobs jobs() {
    ListenerServer server = server();
    return server == null ? null : server.jobs();
  }

  private static ListenerSyncRequests requests() {
    ListenerServer server = server();
    return server == null ? null : server.requests();
  }

  /** 设备连着本机服务的控制通道时，复制由本机服务经控制通道请对方开始。 */
  private static ListenerServer listenerFor(String deviceId) {
    // 本机作为拨号方时本机服务不接受目录表交换，同一台设备不会两种连接并存。
    ListenerServer server = server();
    return server != null && server.control().isOpen(deviceId) ? server : null;
  }

  private void authorize(String projectId, String rootId) throws Exception {
    ListenerSyncJobs jobs = jobs();
    if (jobs != null && jobs.ownsTarget()) {
      jobs.verifyTargetContext(projectId, rootId);
    } else {
      engine.verifyTargetContext(projectId, rootId);
    }
  }

  /**
   * 开始准备，返回格式同共享 SyncPreparationState；见 {@link SyncTransferEngine#prepare}，本机作为监听方时见 {@link
   * ListenerSyncRequests#start}。
   */
  Map<String, Object> prepare(Object rawBinding, String direction) throws Exception {
    Map<String, Object> binding = SyncJobModel.binding(rawBinding);
    ListenerServer server = listenerFor((String) binding.get("remoteDeviceId"));
    if (server == null) {
      return engine.prepare(binding, direction);
    }
    return server
      .requests()
      .start((String) binding.get("projectId"), (String) binding.get("remoteDeviceId"), direction);
  }

  private static boolean isRequest(String id) {
    ListenerSyncRequests requests = requests();
    return requests != null && requests.has(id);
  }

  Map<String, Object> preparationState(String id) throws Exception {
    return isRequest(id) ? requests().state(id) : engine.preparationState(id);
  }

  /** 返回准备或任务的预览；id 是准备 ID 或任务 ID。 */
  Map<String, Object> preview(String id) throws Exception {
    ListenerSyncJobs jobs = jobs();
    if (jobs != null && jobs.has(id)) {
      return jobs.preview(id);
    }
    return isRequest(id) ? requests().preview(id) : engine.preview(id);
  }

  Map<String, Object> cancelPreparation(String id) throws Exception {
    return isRequest(id) ? requests().cancel(id) : engine.cancelPreparation(id);
  }

  /** 释放准备或已结束的任务；对方登记的任务随本机服务的会话释放，这里不做任何事。 */
  void release(String id) throws Exception {
    if (isRequest(id)) {
      requests().release(id);
      return;
    }
    ListenerSyncJobs jobs = jobs();
    if (jobs != null && jobs.has(id)) {
      return;
    }
    engine.release(id);
  }

  /**
   * 按预览确认执行，返回任务两个角色的状态。本机作为拨号方时先启动传输通知再开始；作为监听方时请对方开始，对方登记任务时启动通知。
   *
   * @throws ArchiveFailure 没有通知权限或系统不接受传输通知时为 permission-denied，其余见引擎和 {@link
   *     ListenerSyncRequests#confirm}。
   */
  Map<String, Object> execute(String id, Object plan) throws Exception {
    if (!TransferService.notificationsAllowed(context)) {
      throw new ArchiveFailure("permission-denied", "Allow file transfer notifications first.");
    }
    if (isRequest(id)) {
      String jobId = requests().confirm(id, plan);
      remember(jobId);
      return query(jobId, false);
    }
    engine.reserve(id, plan);
    remember(id);
    try {
      TransferService.launch(context).get(10, TimeUnit.SECONDS);
      engine.begin(id);
    } catch (Exception cause) {
      ArchiveFailure failure = new ArchiveFailure(
        "permission-denied",
        "The system did not accept this file transfer service.",
        false,
        cause
      );
      engine.failStart(id, failure);
      throw failure;
    }
    return engine.query(id, false);
  }

  /** 返回任务两个角色的状态；对方还没登记的已确认任务返回占位状态。 */
  Map<String, Object> query(String id, boolean shouldRefresh) throws Exception {
    ListenerSyncJobs jobs = jobs();
    if (jobs != null && jobs.has(id)) {
      return jobs.query(id);
    }
    ListenerSyncRequests requests = requests();
    Map<String, Object> pending = requests == null ? null : requests.pending(id);
    if (pending != null) {
      return pending;
    }
    return engine.query(id, shouldRefresh);
  }

  private boolean exists(String id) {
    try {
      query(id, false);
      return true;
    } catch (Exception missing) {
      return false;
    }
  }

  /** 正在进行的任务的 ID，没有时为最近一次还查得到的任务；都没有时为 null。 */
  Object current() throws Exception {
    String active = activeId();
    if (active != null) {
      return active;
    }
    List<String> ids;
    synchronized (this) {
      ids = new ArrayList<>(order);
    }
    for (int i = ids.size() - 1; i >= 0; i--) {
      if (exists(ids.get(i))) {
        return ids.get(i);
      }
    }
    return engine.current();
  }

  /** 本机项目 projectId 最近一次还查得到的任务的 ID；没有时为 null。 */
  Object latest(String projectId) throws Exception {
    id(projectId);
    Object dialer = engine.latest(projectId);
    ListenerSyncJobs jobs = jobs();
    ListenerSyncRequests requests = requests();
    List<String> ids;
    synchronized (this) {
      ids = new ArrayList<>(order);
    }
    for (int i = ids.size() - 1; i >= 0; i--) {
      String id = ids.get(i);
      boolean isListener =
        (jobs != null && jobs.has(id) && projectId.equals(jobs.projectId(id))) ||
        (requests != null && projectId.equals(requests.projectId(id)) && exists(id));
      if (id.equals(dialer) || isListener) {
        return id;
      }
    }
    return dialer;
  }

  /**
   * 取消任务，返回取消请求后的状态。
   *
   * @throws ArchiveFailure 任务不存在时为 not-found。
   */
  Map<String, Object> cancelJob(String id) throws Exception {
    ListenerSyncJobs jobs = jobs();
    if (jobs != null && jobs.has(id)) {
      return jobs.localCancel(id);
    }
    ListenerSyncRequests requests = requests();
    if (requests != null && requests.pending(id) != null) {
      requests.cancelPending(id);
      return query(id, false);
    }
    return engine.cancel(id, false);
  }

  /** 重试两种角色的任务的缓存清理。 */
  void retryCleanup() throws Exception {
    engine.retryCleanup();
    ListenerSyncJobs jobs = jobs();
    if (jobs != null) {
      jobs.retryCleanup();
    }
  }

  /** 是否有复制任务占着名额，或本机作为监听方时对方还在执行。 */
  boolean busy() {
    ListenerSyncJobs jobs = jobs();
    return engine.busy() || (jobs != null && jobs.busy());
  }

  /** 正在进行的任务的 ID；没有时为 null。 */
  String activeId() {
    String active = engine.activeId();
    if (active != null) {
      return active;
    }
    ListenerSyncJobs jobs = jobs();
    return jobs == null ? null : jobs.activeId();
  }

  /** 通知用的阶段和进度快照；没有活动任务时返回 null。 */
  Map<String, Object> notice() {
    if (engine.busy()) {
      return engine.notice();
    }
    ListenerSyncJobs jobs = jobs();
    return jobs == null ? null : jobs.notice();
  }

  /**
   * 在后台取消活动任务；expectedId 不为 null 时只取消这个任务。
   *
   * @param isTimeout 为 true 时按超时结束本机作为拨号方的任务。
   */
  void cancel(String expectedId, boolean isTimeout) {
    controls.execute(() -> {
      String active = engine.activeId();
      if (active != null && (expectedId == null || active.equals(expectedId))) {
        try {
          engine.cancel(active, isTimeout);
        } catch (Exception ignored) {
          /* 任务已终止时保留可查询的实际结果。 */
        }
        return;
      }
      ListenerSyncJobs jobs = jobs();
      String listening = jobs == null ? null : jobs.activeId();
      if (listening != null && (expectedId == null || listening.equals(expectedId))) {
        try {
          jobs.localCancel(listening);
        } catch (Exception ignored) {
          /* 任务已终止时保留可查询的实际结果。 */
        }
      }
    });
  }

  /** 在后台重试 expectedId 任务的缓存清理。 */
  void retry(String expectedId) {
    controls.execute(() -> {
      if (expectedId == null) {
        return;
      }
      try {
        if (expectedId.equals(engine.activeId())) {
          engine.retryCleanup();
        } else {
          ListenerSyncJobs jobs = jobs();
          if (jobs != null && expectedId.equals(jobs.activeId())) {
            jobs.retryCleanup();
          }
        }
      } catch (Exception ignored) {
        /* 清理失败时保留通知和名额，下次显式重试。 */
      }
    });
  }
}
