package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.copy;
import static io.github.galgame.savedatasync.TransferJson.list;
import static io.github.galgame.savedatasync.TransferJson.map;
import static io.github.galgame.savedatasync.TransferJson.object;
import static io.github.galgame.savedatasync.TransferSchema.id;
import static io.github.galgame.savedatasync.TransferSchema.number;
import static io.github.galgame.savedatasync.TransferSchema.one;
import static io.github.galgame.savedatasync.TransferSchema.require;
import static io.github.galgame.savedatasync.TransferSchema.shape;
import static io.github.galgame.savedatasync.TransferSchema.string;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Predicate;

/**
 * 本机作为监听方时，当前服务会话里拨号方登记的复制任务；本机可以是接收端或发送端。
 *
 * <p>本机接收时内容只接受一次，边收边解包到私有缓存，收齐后写入目录；本机发送时重新扫描核对来源，内容只能读取一次，边读边打包发送。
 * 任务从登记到写入和缓存清理结束一直占用 {@link TargetOperation} 的名额。用过的任务 ID 保留到会话结束；结束的任务保留
 * {@link #RETENTION_NANOS}，最多 {@link #MAX_TASKS} 个，只存在内存中。
 *
 * <p>任务状态由本对象的锁保护；持锁时不做文件和网络读写。
 */
final class ListenerSyncJobs {

  /** 任务登记的通知。 */
  interface Events {
    /**
     * 拨号方登记了一个任务；在登记请求的连接线程上调用，抛出的异常被忽略。
     *
     * @param projectId 本机这一端的项目 ID。
     * @param isPeerInitiated 任务不是本机经控制通道请对方开始的。
     */
    void registered(String jobId, String projectId, boolean isPeerInitiated);
  }

  /** 等拨号方读取内容的最长时间。 */
  static final long READY_NANOS = TimeUnit.MINUTES.toNanos(10);
  /** 等拨号方上传内容的最长时间。 */
  static final long AWAITING_CONTENT_NANOS = TimeUnit.MINUTES.toNanos(2);
  /** 任务从登记起的总期限。 */
  static final long TOTAL_NANOS = TimeUnit.MINUTES.toNanos(30);
  /** 内容连接没有进展、或拨号方没有推送摘要的最长时间。 */
  static final long NETWORK_IDLE_NANOS = TimeUnit.SECONDS.toNanos(60);
  /** 结束的任务保留多久。 */
  static final long RETENTION_NANOS = TimeUnit.MINUTES.toNanos(10);
  /** 读取对端结果失败后，隔多久再试一次。 */
  static final long REMOTE_READ_RETRY_NANOS = TimeUnit.SECONDS.toNanos(5);
  /** 确认的扫描结果的有效期（毫秒），与共享 SYNC_LIMITS.snapshotLifetimeMs 相同。 */
  static final long SNAPSHOT_LIFETIME_MS = 600000;
  /** 停止时等待任务结束和清理的最长时间（秒）。 */
  static final long STOP_WAIT_SECONDS = 30;
  static final int MAX_TASKS = 32;
  static final int MAX_USED_IDS = 4096;
  private static final String CONTENT_TYPE = "application/gzip";

  private static final class Task {

    final Map<String, Object> request;
    final SyncPlanModel.Plan plan;
    final String peerId;
    final boolean isReceiver;
    final boolean isPeerInitiated;
    final String localProject;
    final String remoteProject;
    final long acceptedAt = System.currentTimeMillis();
    final long startedAt = System.nanoTime();
    final ArchiveControl control = new ArchiveControl();
    /** 接收的内容全部解包后完成，失败或取消时带着原因异常完成。 */
    final CompletableFuture<Void> content = new CompletableFuture<>();
    /** 计划里要传的文件，按 tar 成员的顺序。 */
    final List<Map<String, Object>> entries;
    Map<String, Object> state;
    ArchiveAdapter.Staged staged;
    /** 接收端开始等内容的时间；领取内容后为 null。 */
    Long awaitingSince;
    boolean isBackupDone;
    boolean isContentClaimed;
    boolean isContentReceived;
    /** 内容连接还在读请求体。 */
    boolean isReceiving;
    boolean isWorking;
    boolean isFinishing;
    boolean isAborted;
    /** 本机发起了取消、正在通知对端；这期间任务因任何原因中止都按取消记录。 */
    boolean isCancelling;
    boolean hasLease = true;
    Map<String, Object> reason;
    long stageAt = System.nanoTime();
    long networkAt = System.nanoTime();
    Long terminalAt;
    /** 对端角色最新的状态；接收端已结束但结果没读到时，保持 running/cleaning。 */
    Map<String, Object> remote;
    /** 对端的 remote 已不可信（断开或读取失败）；新的摘要或结果到达后清除。 */
    Map<String, Object> remoteError;
    boolean shouldReadRemote;
    boolean isReadingRemote;
    long remoteReadAt;
    long remoteSeenAt = System.nanoTime();
    /** 正在收发内容的连接；中止任务时关闭它，唤醒阻塞的读写。 */
    Closeable connection;

    Task(
      Map<String, Object> request,
      SyncPlanModel.Plan plan,
      String peerId,
      boolean isPeerInitiated,
      List<Map<String, Object>> entries
    ) throws Exception {
      this.request = request;
      this.plan = plan;
      this.peerId = peerId;
      this.isReceiver = plan.value.get("direction").equals("dialer-to-listener");
      this.isPeerInitiated = isPeerInitiated;
      this.localProject = id(request.get(isReceiver ? "targetProjectId" : "sourceProjectId"));
      this.remoteProject = id(request.get(isReceiver ? "sourceProjectId" : "targetProjectId"));
      this.entries = entries;
    }

    String jobId() {
      return plan.id;
    }

    String opposite() {
      return isReceiver ? "sender" : "receiver";
    }

    boolean isRunning() {
      return state.get("status").equals("running");
    }

    long count() throws Exception {
      return number(plan.value.get("transferFileCount"), 0, 1024);
    }

    long total() throws Exception {
      return number(plan.value.get("totalFileBytes"), 0, BackupModel.MAX_TOTAL);
    }
  }

  private interface Operation {
    void run() throws Exception;
  }

  private final SyncTransferEngine.Local local;
  private final ArchiveAdapter archives;
  private final SyncScanner scanner;
  private final ListenerLibrary library;
  private final ListenerControl control;
  private final Predicate<String> isOwnJob;
  private final Events events;
  private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
    Thread thread = new Thread(r, "listener-sync");
    thread.setDaemon(true);
    return thread;
  });
  private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> {
    Thread thread = new Thread(r, "listener-sync-timer");
    thread.setDaemon(true);
    return thread;
  });
  private final Map<String, Task> tasks = new LinkedHashMap<>();
  private final Set<String> used = new HashSet<>();
  private Task active;
  /** 不再接受新任务：已停止，或任务状态不符合公开校验。 */
  private boolean isStopped;
  private boolean isClosing;

  /**
   * 创建当前服务会话的任务登记表；scanner 归本对象所有，{@link #stop} 时关闭。
   *
   * @param isOwnJob 判断任务 ID 是否是本机经控制通道请对方开始的。
   */
  ListenerSyncJobs(
    SyncTransferEngine.Local local,
    ArchiveAdapter archives,
    SyncScanner scanner,
    ListenerLibrary library,
    ListenerControl control,
    Predicate<String> isOwnJob,
    Events events
  ) {
    this.local = local;
    this.archives = archives;
    this.scanner = scanner;
    this.library = library;
    this.control = control;
    this.isOwnJob = isOwnJob;
    this.events = events;
    timer.scheduleWithFixedDelay(this::sweep, 1, 1, TimeUnit.SECONDS);
  }

  /** 本机的复制能力，格式同共享 SyncCapabilities。 */
  Map<String, Object> capabilities() {
    return object(
      "schemaVersion",
      SyncJobModel.CAPABILITIES_VERSION,
      "deviceId",
      local.deviceId(),
      "canScan",
      "supported",
      "canCopy",
      "supported",
      "canBackup",
      "supported",
      "canRestore",
      "unsupported",
      "limits",
      object(
        "maxEntries",
        SyncScanner.MAX_ENTRIES,
        "maxDepth",
        SyncScanner.MAX_DEPTH,
        "maxPathLength",
        SyncScanner.MAX_PATH,
        "maxNameLength",
        255,
        "maxRetainedScans",
        SyncScanner.MAX_RESULTS,
        "snapshotLifetimeMs",
        SNAPSHOT_LIFETIME_MS,
        "scanTimeoutMs",
        TOTAL_NANOS / 1000000
      )
    );
  }

  /**
   * 按共享 SyncScanRequest 开始扫描本机根目录。
   *
   * @throws ArchiveFailure 请求格式不对时为 invalid-request，已有扫描在进行时为 busy。
   */
  Map<String, Object> startScan(Object value) throws Exception {
    Map<String, Object> body = shape(value, "schemaVersion", "rootId");
    number(body.get("schemaVersion"), 1, 1);
    return scanner.start(id(body.get("rootId")));
  }

  /** 读取扫描状态；扫描不存在时抛出 not-found。 */
  Map<String, Object> scan(String scanId) throws Exception {
    return scanner.query(scanId);
  }

  /** 取消扫描，返回取消请求后的状态。 */
  Map<String, Object> cancelScan(String scanId) throws Exception {
    return scanner.cancel(scanId);
  }

  /**
   * 返回本机项目的描述，格式同共享 SyncProjectDescriptor。
   *
   * @throws ArchiveFailure 项目没选目录或没有与 peerId 双向关联时抛出 not-found 或 session-mismatch。
   */
  Map<String, Object> project(String projectId, String peerId) throws Exception {
    String[] link = library.link(projectId, peerId);
    if (link == null) {
      throw new ArchiveFailure("not-found", "The project directory or device link does not exist.");
    }
    library.verifyProject(projectId, peerId, link[0], link[1], link[2]);
    return object(
      "schemaVersion",
      1,
      "projectId",
      projectId,
      "deviceId",
      local.deviceId(),
      "rootId",
      link[1]
    );
  }

  /**
   * 登记拨号方的任务。本机发送时立即返回，核对来源在后台进行；本机接收时先核对目标和空间再返回，之后开始备份并等内容。
   *
   * @throws ArchiveFailure 请求或方向不对时为 invalid-request，已有任务或待清理资源时为 busy，任务 ID 用过时为
   *     task-conflict，确认的扫描过期时为 not-found。登记之后的错误记在任务状态里。
   */
  Map<String, Object> register(Object value, String peerId) throws Exception {
    Map<String, Object> request;
    SyncPlanModel.Plan plan;
    boolean isUpload;
    try {
      request = shape(
        copy(value),
        "schemaVersion",
        "jobId",
        "sourceProjectId",
        "targetProjectId",
        "plan"
      );
      number(request.get("schemaVersion"), 1, 1);
      plan = new SyncPlanModel.Plan(request.get("plan"));
      one(plan.value.get("direction"), "dialer-to-listener", "listener-to-dialer");
      isUpload = plan.value.get("direction").equals("dialer-to-listener");
      id(request.get("sourceProjectId"));
      String self = local.deviceId();
      require(
        plan.id.equals(id(request.get("jobId"))) &&
          plan.reason.equals("copy") &&
          plan.project.equals(id(request.get("targetProjectId"))) &&
          (isUpload
            ? plan.target.device.equals(self) && plan.source.device.equals(peerId)
            : plan.source.device.equals(self) && plan.target.device.equals(peerId))
      );
    } catch (Exception invalid) {
      throw new ArchiveFailure(
        "invalid-request",
        "The copy request or device direction is invalid."
      );
    }
    List<Map<String, Object>> entries = contentEntries(plan);
    Task task = new Task(request, plan, peerId, !isOwnJob.test(plan.id), entries);
    sweep();
    synchronized (this) {
      if (isStopped || active != null) {
        throw new ArchiveFailure("busy", "A sync task or resources are awaiting cleanup.");
      }
      if (used.contains(plan.id)) {
        throw new ArchiveFailure(
          "task-conflict",
          "This confirmation was already used. Query the original task."
        );
      }
      if (used.size() >= MAX_USED_IDS) {
        throw new ArchiveFailure("resource-limit", "The session task capacity is full.");
      }
      SyncPlanModel.Snapshot snapshot = isUpload ? plan.target : plan.source;
      long observed = number(
        snapshot.value.get("observedAt"),
        -BackupModel.MAX_DATE,
        BackupModel.MAX_DATE
      );
      long now = System.currentTimeMillis();
      if (observed > now || now - observed > SNAPSHOT_LIFETIME_MS) {
        throw new ArchiveFailure("not-found", "The confirmed scan expired. Scan again.");
      }
      Map<String, Object> cached;
      try {
        cached = scanner.query(snapshot.scan);
      } catch (ArchiveFailure missing) {
        cached = null;
      }
      if (
        cached == null ||
        !"succeeded".equals(cached.get("status")) ||
        !SyncPlanModel.same(cached.get("snapshot"), snapshot.value)
      ) {
        throw new ArchiveFailure(
          "invalid-request",
          "The target scan differs from the result stored in the current session."
        );
      }
      if (!TargetOperation.acquire(task)) {
        throw new ArchiveFailure("busy", "A sync task or resources are awaiting cleanup.");
      }
      task.state = object(
        "schemaVersion",
        SyncJobModel.JOB_SCHEMA_VERSION,
        "jobId",
        plan.id,
        "direction",
        plan.value.get("direction"),
        "role",
        isUpload ? "receiver" : "sender",
        "status",
        "running",
        "stage",
        "preparing",
        "updatedAt",
        now,
        "isCancelRequested",
        false,
        "failureStage",
        null,
        "result",
        null,
        "error",
        null,
        "cleanupError",
        null,
        "progress",
        object(
          "transferredBytes",
          0L,
          "totalFileBytes",
          task.total(),
          "totalFiles",
          task.count(),
          "publishedFiles",
          0L,
          "fileBytesPublished",
          0L,
          "backupBytesCopied",
          0L,
          "totalBackupBytes",
          number(plan.value.get("backupFileBytes"), 0, BackupModel.MAX_TOTAL)
        )
      );
      used.add(plan.id);
      tasks.put(plan.id, task);
      active = task;
    }
    try {
      events.registered(plan.id, task.localProject, task.isPeerInitiated);
    } catch (RuntimeException ignored) {
      // 通知只用于前台服务和界面，失败不影响任务。
    }
    if (!isUpload) {
      submit(task, () -> prepareSource(task));
      return state(task);
    }
    work(task, () -> admit(task));
    boolean shouldApply;
    synchronized (this) {
      // 通过容量核对后立即开始备份，同时等发送端上传内容。
      shouldApply = task.isRunning() && task.count() > 0;
      if (shouldApply) {
        task.awaitingSince = System.nanoTime();
      }
    }
    if (shouldApply) {
      submit(task, () -> apply(task));
    }
    return state(task);
  }

  private synchronized Map<String, Object> state(Task task) throws Exception {
    return map(copy(task.state));
  }

  /** 计划里要传的文件，按写入操作的顺序，对应 tar 成员 f000001、f000002……。 */
  private static List<Map<String, Object>> contentEntries(SyncPlanModel.Plan plan)
    throws Exception {
    List<Map<String, Object>> entries = new ArrayList<>();
    for (Map<String, Object> operation : plan.writes) {
      if (SyncPlanModel.isFileWrite(operation)) {
        entries.add(plan.source.entry(operation.get("sourceEntryId")));
      }
    }
    return entries;
  }

  /** 在当前线程运行 operation，失败时按任务的原因结束任务。 */
  private void work(Task task, Operation operation) {
    synchronized (this) {
      task.isWorking = true;
    }
    finishWork(task, operation);
  }

  /** 在工作线程上运行 operation；线程已关闭时按取消结束任务。 */
  private void submit(Task task, Operation operation) {
    synchronized (this) {
      task.isWorking = true;
    }
    try {
      worker.execute(() -> finishWork(task, operation));
    } catch (java.util.concurrent.RejectedExecutionException stopped) {
      finishWork(task, () -> {
        throw cancelled();
      });
    }
  }

  private void finishWork(Task task, Operation operation) {
    try {
      operation.run();
    } catch (Exception cause) {
      fail(task, cause);
    } finally {
      boolean isAborted;
      synchronized (this) {
        isAborted = task.isAborted && task.isRunning();
      }
      if (isAborted) {
        fail(task, cancelled());
      }
      synchronized (this) {
        task.isWorking = false;
      }
    }
  }

  private static ArchiveFailure cancelled() {
    return new ArchiveFailure("io-failure", "The sync task was cancelled.", true, null);
  }

  private static Map<String, Object> problem(String code, String message) {
    return object("code", code, "message", message, "canRetry", false);
  }

  private static Map<String, Object> cleanupFailure() {
    return problem(
      "cleanup-failed",
      "This archive or write candidate still needs cleanup. Retry cleanup."
    );
  }

  // 内容请求失败时错误直接回在 HTTP 应答里，拨号方分不出是哪一端的目录；登记之后的文件、目录和存储访问
  // 都发生在本机，这里注明 listener。
  private static ArchiveFailure located(ArchiveFailure failure) {
    if (failure.device == null && SyncTransferEngine.DEVICE_ERRORS.contains(failure.code)) {
      failure.device = "listener";
    }
    return failure;
  }

  /** 把异常转成任务错误；结果待确认只在写入时出现，准备阶段的按读写失败记录。 */
  private static Map<String, Object> known(Exception cause) {
    ArchiveFailure failure = ArchiveFailure.from(cause);
    if (failure.code.equals("result-unknown")) {
      return problem("io-failure", "Receive preparation failed.");
    }
    String message = failure.getMessage();
    return problem(
      failure.code,
      message == null || message.trim().isEmpty() ? "The sync task failed." : message
    );
  }

  /** 核对项目关联和根目录仍与确认时一致。 */
  private void verify(Task task) throws Exception {
    task.control.check();
    SyncPlanModel.Plan plan = task.plan;
    library.verifyProject(
      task.localProject,
      task.peerId,
      task.remoteProject,
      task.isReceiver ? plan.target.root : plan.source.root,
      task.isReceiver ? plan.source.root : plan.target.root
    );
    task.control.check();
  }

  private static List<Object> entryFields(Object snapshot) throws Exception {
    List<Object> result = new ArrayList<>();
    for (Object item : list(map(snapshot).get("entries"))) {
      Map<String, Object> entry = map(item);
      result.add(
        object(
          "entryId",
          entry.get("entryId"),
          "path",
          entry.get("path"),
          "kind",
          entry.get("kind"),
          "sizeBytes",
          entry.get("sizeBytes"),
          "modifiedAt",
          entry.get("modifiedAt"),
          "error",
          entry.get("error")
        )
      );
    }
    return result;
  }

  private void prepareSource(Task task) throws Exception {
    verify(task);
    Map<String, Object> snapshot = local.snapshot(task.plan.source.root, task.control);
    task.control.check();
    if (!SyncPlanModel.same(entryFields(snapshot), entryFields(task.plan.source.value))) {
      throw new ArchiveFailure(
        "source-changed",
        "The source directory differs from confirmation. Scan again."
      );
    }
    if (task.count() == 0) {
      finishSender(task, "sent", null);
      return;
    }
    update(task, "ready");
  }

  private void admit(Task task) throws Exception {
    verify(task);
    long total = task.total();
    long extra = local.checkReceiveSpace(
      task.plan,
      archives.privateRoot(),
      total,
      task.control,
      execution(task)
    );
    archives.checkStagingSpace(total, extra);
    verify(task);
    if (task.count() == 0) {
      apply(task);
    } else {
      update(task, "backing-up");
    }
  }

  private Task owned(String id, String peerId) throws ArchiveFailure {
    sweep();
    synchronized (this) {
      Task task = tasks.get(id);
      if (task == null || !task.peerId.equals(peerId)) {
        throw new ArchiveFailure(
          "not-found",
          "This sync task does not exist in the current session."
        );
      }
      return task;
    }
  }

  /** 返回拨号方的任务在本机这一端的状态；这次读取不算网络进展，也不延长期限。 */
  Map<String, Object> get(String id, String peerId) throws Exception {
    return state(owned(id, peerId));
  }

  /** 取消任务，返回取消请求后的状态。已结束的结果不会被改写，前面已成功的文件不会被撤销。 */
  Map<String, Object> cancel(String id, String peerId) throws Exception {
    Task task = owned(id, peerId);
    abort(task, null);
    return state(task);
  }

  /**
   * 边读来源边打包，以 chunked 的 200 响应写进 output；每个任务只能领取一次。
   *
   * @param connection 内容连接，中止任务时关闭它。
   * @return true 表示响应完整发出，连接可以继续读下一个请求；false 表示响应已开始但没发完，连接要关闭。
   * @throws ArchiveFailure 来源还没核对完或已被领取时为 task-conflict；响应开始前就失败时为任务的错误。
   */
  boolean sendContent(String id, String peerId, OutputStream output, Closeable connection)
    throws Exception {
    Task task = owned(id, peerId);
    synchronized (this) {
      if (
        task.isReceiver ||
        !task.isRunning() ||
        !task.state.get("stage").equals("ready") ||
        task.isWorking ||
        task.isContentClaimed
      ) {
        throw new ArchiveFailure(
          "task-conflict",
          "This source content is not ready or was already claimed."
        );
      }
      task.isContentClaimed = true;
      update(task, "transferring");
      task.networkAt = System.nanoTime();
      task.connection = connection;
    }
    ListenerHttp.ChunkedOutput chunked = new ListenerHttp.ChunkedOutput(output, CONTENT_TYPE);
    work(task, () -> {
      try {
        verify(task);
        List<ArchiveModel.Source> sources = local.sources(task.plan);
        require(sources.size() == task.entries.size());
        List<ArchiveAdapter.Outgoing> files = new ArrayList<>();
        for (int i = 0; i < sources.size(); i++) {
          Map<String, Object> entry = task.entries.get(i);
          files.add(
            new ArchiveAdapter.Outgoing(
              sources.get(i),
              string(entry.get("entryId")),
              number(entry.get("sizeBytes"), 0, BackupModel.MAX_FILE),
              TransferSchema.nullable(
                entry.get("modifiedAt"),
                -BackupModel.MAX_DATE,
                BackupModel.MAX_DATE
              )
            )
          );
        }
        archives.sendFiles(files, chunked, task.control, (stage, value, ignored) ->
          transferred(task, value)
        );
        try {
          chunked.finish();
        } catch (IOException lost) {
          throw new ArchiveFailure("network-failure", "The connection closed.", false, lost);
        }
        finishSender(task, "sent", null);
      } catch (ArchiveFailure failure) {
        if (failure.code.equals("network-failure")) {
          abort(
            task,
            problem("network-failure", "The sending connection was interrupted before completion.")
          );
        }
        throw failure;
      } finally {
        synchronized (this) {
          task.connection = null;
        }
      }
    });
    synchronized (this) {
      if (task.state.get("status").equals("sent")) {
        return true;
      }
      if (chunked.isStarted()) {
        return false;
      }
      Map<String, Object> error =
        task.state.get("error") == null ? null : map(task.state.get("error"));
      throw located(
        new ArchiveFailure(
          error == null ? "network-failure" : string(error.get("code")),
          error == null
            ? "This send operation was aborted. Query the actual status."
            : string(error.get("message"))
        )
      );
    }
  }

  private void transferred(Task task, long value) throws Exception {
    synchronized (this) {
      task.networkAt = System.nanoTime();
      progress(
        task,
        task.isReceiver ? contentStage(task) : "transferring",
        "transferredBytes",
        value
      );
    }
  }

  /**
   * 接收 tar.gz 内容，每个任务只能领取一次，备份期间也可以开始；边收边解包，返回时内容已完整解包，写入结果在任务状态里。
   *
   * @param connection 内容连接，中止任务时关闭它。
   * @throws ArchiveFailure 任务不在等内容或内容已被领取时为 task-conflict，内容类型不对时为 invalid-request；
   *     任务被取消或超时时为任务的原因，其他接收失败时为接收的错误。
   */
  Map<String, Object> receive(
    String id,
    String peerId,
    ListenerHttp.Request request,
    Closeable connection
  ) throws Exception {
    Task task = owned(id, peerId);
    synchronized (this) {
      if (
        !task.isReceiver || !task.isRunning() || task.awaitingSince == null || task.isContentClaimed
      ) {
        throw new ArchiveFailure(
          "task-conflict",
          "This content was already claimed or the task is no longer awaiting content."
        );
      }
      if (!CONTENT_TYPE.equals(request.header("content-type"))) {
        throw new ArchiveFailure("invalid-request", "The content type is not gzip.");
      }
      task.isContentClaimed = true;
      task.awaitingSince = null;
      update(task, contentStage(task));
      task.networkAt = System.nanoTime();
      task.isReceiving = true;
      task.connection = connection;
    }
    try {
      verify(task);
      List<Long> sizes = new ArrayList<>();
      for (Map<String, Object> entry : task.entries) {
        sizes.add(number(entry.get("sizeBytes"), 0, BackupModel.MAX_FILE));
      }
      ArchiveAdapter.Staged staged = archives.receiveFiles(
        sizes,
        new UploadBody(request.body, task),
        task.control,
        (stage, value, ignored) -> transferred(task, value)
      );
      synchronized (this) {
        task.staged = staged;
      }
      if (!request.isBodyComplete()) {
        throw new ArchiveFailure("checksum-mismatch", "The upload message is incomplete.");
      }
      synchronized (this) {
        task.isContentReceived = true;
        update(task, contentStage(task));
        task.isReceiving = false;
        task.connection = null;
        notifyAll();
      }
      task.content.complete(null);
      return state(task);
    } catch (Exception cause) {
      ArchiveFailure reply;
      synchronized (this) {
        // 任务被取消、超时或写入器先失败时接收被中止；回给发送端的是任务的原因或 task-conflict，发送端再按任务状态结束。
        reply = task.isAborted
          ? new ArchiveFailure(
              task.reason == null ? "task-conflict" : string(task.reason.get("code")),
              task.reason == null
                ? "The task was cancelled or has ended. Query its result."
                : string(task.reason.get("message"))
            )
          : ArchiveFailure.from(cause);
        task.isReceiving = false;
        task.connection = null;
        notifyAll();
      }
      // 写入器可能还在备份，中止它，任务按内容的错误结束。
      abort(task, known(cause));
      task.content.completeExceptionally(cause);
      throw located(reply);
    }
  }

  /** 备份完成前是备份阶段，之后按内容的进展是等待内容、传输或写入。 */
  private static String contentStage(Task task) {
    if (!task.isBackupDone) {
      return "backing-up";
    }
    if (task.isContentReceived) {
      return "writing";
    }
    return task.isContentClaimed ? "transferring" : "awaiting-content";
  }

  /** 改阶段；任务已结束时不改。调用方持有本对象的锁。 */
  private void update(Task task, String stage) {
    if (!task.isRunning()) {
      return;
    }
    if (!stage.equals(task.state.get("stage"))) {
      task.stageAt = System.nanoTime();
    }
    task.state.put("stage", stage);
    task.state.put("updatedAt", System.currentTimeMillis());
  }

  private void progress(Task task, String stage, String counter, long value) throws Exception {
    if (!task.isRunning()) {
      return;
    }
    Map<String, Object> counters = map(task.state.get("progress"));
    long maximum = counter.equals("backupBytesCopied")
      ? number(counters.get("totalBackupBytes"), 0, BackupModel.MAX_TOTAL)
      : task.total();
    if (value < number(counters.get(counter), 0, maximum) || value > maximum) {
      throw new ArchiveFailure("source-changed", "The source file exceeds the confirmed plan.");
    }
    counters.put(counter, value);
    update(task, stage);
    task.state.put("updatedAt", System.currentTimeMillis());
  }

  private SyncWriter.Material material(Task task) {
    return new SyncWriter.Material() {
      @Override
      public Map<String, Object> snapshot() throws Exception {
        return map(copy(task.plan.source.value));
      }

      @Override
      public boolean ready(ArchiveControl control) throws Exception {
        synchronized (ListenerSyncJobs.this) {
          task.isBackupDone = true;
          update(task, contentStage(task));
        }
        while (true) {
          control.check();
          try {
            task.content.get(100, TimeUnit.MILLISECONDS);
            return true;
          } catch (TimeoutException waiting) {
            // 内容还在上传，继续等，期间响应取消。
          } catch (ExecutionException failed) {
            Throwable cause = failed.getCause();
            throw cause instanceof Exception ? (Exception) cause : failed;
          }
        }
      }

      @Override
      public ArchiveModel.Source file(String entryId) throws Exception {
        for (int i = 0; i < task.entries.size(); i++) {
          Map<String, Object> entry = task.entries.get(i);
          if (entry.get("entryId").equals(entryId)) {
            String fileId = ArchiveModel.id(i);
            List<String> path = BackupModel.path(entry.get("path"));
            ArchiveModel.Observation observation = new ArchiveModel.Observation(
              task.jobId() + ":" + fileId,
              entryId,
              task.plan.source.parent(path),
              path.get(path.size() - 1),
              number(entry.get("sizeBytes"), 0, BackupModel.MAX_FILE),
              TransferSchema.nullable(
                entry.get("modifiedAt"),
                -BackupModel.MAX_DATE,
                BackupModel.MAX_DATE
              )
            );
            return new ArchiveModel.Source() {
              @Override
              public void validateRoot(String rootId) throws ArchiveFailure {
                require(rootId.equals(task.plan.source.root));
              }

              @Override
              public ArchiveModel.Observation observe(ArchiveControl control) throws Exception {
                control.check();
                return observation;
              }

              @Override
              public InputStream open(ArchiveControl control) throws Exception {
                control.check();
                ArchiveAdapter.Staged staged;
                synchronized (ListenerSyncJobs.this) {
                  staged = task.staged;
                }
                if (staged == null) {
                  throw new ArchiveFailure(
                    "invalid-request",
                    "The content is missing a source file for this operation."
                  );
                }
                return staged.openFile(fileId);
              }
            };
          }
        }
        throw new ArchiveFailure(
          "invalid-request",
          "The content is missing a source file for this operation."
        );
      }
    };
  }

  private SyncWriter.Execution execution(Task task) {
    return new SyncWriter.Execution(
      task,
      task.acceptedAt,
      new SyncWriter.Observer() {
        @Override
        public void stage(String stage) {
          // 写入前核对目标是备份的一部分，备份要按核对过的目录复制。
          synchronized (ListenerSyncJobs.this) {
            update(task, stage.equals("writing") ? "writing" : contentStage(task));
          }
        }

        @Override
        public void backup(long bytesCopied) throws Exception {
          synchronized (ListenerSyncJobs.this) {
            progress(task, contentStage(task), "backupBytesCopied", bytesCopied);
          }
        }

        @Override
        public void outcome(Map<String, Object> result) throws Exception {
          if (!result.get("status").equals("succeeded") || !SyncPlanModel.isFileWrite(result)) {
            return;
          }
          synchronized (ListenerSyncJobs.this) {
            if (!task.isRunning()) {
              return;
            }
            Map<String, Object> counters = map(task.state.get("progress"));
            counters.put("publishedFiles", number(counters.get("publishedFiles"), 0, 1024) + 1);
            counters.put(
              "fileBytesPublished",
              number(counters.get("fileBytesPublished"), 0, BackupModel.MAX_TOTAL) +
                number(result.get("sizeBytes"), 0, BackupModel.MAX_FILE)
            );
            update(task, "writing");
          }
        }
      }
    );
  }

  private void apply(Task task) throws Exception {
    verify(task);
    SyncWriter.Material material = task.count() > 0 ? material(task) : null;
    Map<String, Object> result = local.apply(task.plan, material, task.control, execution(task));
    boolean hasCancellation = false;
    boolean hasAllSucceeded = result.get("error") == null;
    for (Object item : list(result.get("outcomes"))) {
      String status = string(map(item).get("status"));
      hasCancellation |= status.equals("cancelled");
      hasAllSucceeded &= status.equals("succeeded");
    }
    Map<String, Object> reason;
    boolean isAborted;
    synchronized (this) {
      reason = task.reason;
      isAborted = task.isAborted;
    }
    Map<String, Object> actual = result;
    // 超时引起的取消有稳定的根错误；已成功或提交结果不确定的写入，保留实际观察到的结果。
    if (reason != null && !hasAllSucceeded && (hasCancellation || result.get("error") == null)) {
      actual = map(copy(result));
      actual.put("error", reason);
      List<Object> outcomes = new ArrayList<>();
      for (Object item : list(actual.get("outcomes"))) {
        Map<String, Object> outcome = map(item);
        if (outcome.get("status").equals("cancelled")) {
          outcome.put("status", "failed");
          outcome.put("error", reason);
        }
        outcomes.add(outcome);
      }
      actual.put("outcomes", outcomes);
    }
    finish(task, actual, reason == null && (hasCancellation || (!hasAllSucceeded && isAborted)));
  }

  private void fail(Task task, Exception cause) {
    boolean wasCancelled;
    Map<String, Object> error;
    synchronized (this) {
      if (!task.isRunning()) {
        return;
      }
      wasCancelled =
        task.reason == null && (task.isAborted || ArchiveFailure.from(cause).isCancelled);
      error = wasCancelled ? null : task.reason != null ? task.reason : known(cause);
    }
    if (!task.isReceiver) {
      finishSender(task, wasCancelled ? "cancelled" : "failed", error);
      return;
    }
    try {
      finish(task, emptyResult(task.plan, error, wasCancelled), wasCancelled);
    } catch (Exception invalid) {
      synchronized (this) {
        isStopped = true;
      }
    }
  }

  /** 还没写入就结束时 plan 的完整结果，格式同共享 SyncApplyResult：第一项记录原因，其余为未尝试。 */
  static Map<String, Object> emptyResult(
    SyncPlanModel.Plan plan,
    Map<String, Object> error,
    boolean wasCancelled
  ) {
    List<Object> outcomes = new ArrayList<>();
    for (int i = 0; i < plan.writes.size(); i++) {
      Map<String, Object> operation = plan.writes.get(i);
      outcomes.add(
        object(
          "path",
          operation.get("path"),
          "action",
          operation.get("action"),
          "status",
          i == 0 ? (wasCancelled ? "cancelled" : "failed") : "not-attempted",
          "sizeBytes",
          null,
          "error",
          i == 0 ? error : null
        )
      );
    }
    return object(
      "schemaVersion",
      1,
      "planId",
      plan.id,
      "backupId",
      null,
      "backupFileCount",
      null,
      "outcomes",
      outcomes,
      "error",
      error,
      "cleanupError",
      null
    );
  }

  /** 返回任务停下时的阶段；要在清理改写阶段之前调用。 */
  private static Object stoppedAt(Task task) {
    Object stage = task.state.get("stage");
    return stage.equals("cleaning") || stage.equals("done") ? null : stage;
  }

  private void finishSender(Task task, String status, Map<String, Object> error) {
    Object failureStage;
    synchronized (this) {
      if (task.isFinishing) {
        return;
      }
      task.isFinishing = true;
      // 清理会改写当前阶段，要在这之前记下任务停在哪里。
      failureStage = status.equals("sent") ? null : stoppedAt(task);
      update(task, "cleaning");
    }
    boolean isClean = clean(task);
    synchronized (this) {
      task.state.put("status", status);
      task.state.put("stage", "done");
      task.state.put("failureStage", failureStage);
      task.state.put("updatedAt", System.currentTimeMillis());
      task.state.put("result", null);
      task.state.put("error", error);
      task.state.put("cleanupError", isClean ? null : cleanupFailure());
      if (status.equals("cancelled")) {
        task.state.put("isCancelRequested", true);
      }
      task.terminalAt = System.nanoTime();
      try {
        SyncJobModel.state(copy(task.state), task.plan, "sender");
      } catch (Exception invalid) {
        isStopped = true;
      }
    }
  }

  private void finish(Task task, Map<String, Object> result, boolean wasCancelled)
    throws Exception {
    Object failureStage;
    Closeable connection;
    boolean shouldStopReceiving;
    synchronized (this) {
      if (task.isFinishing) {
        return;
      }
      task.isFinishing = true;
      failureStage = stoppedAt(task);
      // 写入器先失败时内容可能还在接收，停下它再清理缓存。
      shouldStopReceiving = task.isReceiving && !task.isContentReceived;
      connection = task.connection;
    }
    if (shouldStopReceiving) {
      task.control.cancel();
      close(connection);
    }
    synchronized (this) {
      while (task.isReceiving) {
        wait();
      }
      update(task, "cleaning");
    }
    Object cleanupError = result.get("cleanupError");
    if (!clean(task)) {
      cleanupError = cleanupFailure();
    }
    synchronized (this) {
      Map<String, Object> actual = map(copy(result));
      actual.put("cleanupError", cleanupError);
      Object error = actual.get("error");
      boolean hasAllSucceeded = error == null;
      for (Object item : list(actual.get("outcomes"))) {
        hasAllSucceeded &= map(item).get("status").equals("succeeded");
      }
      String status =
        error != null && map(error).get("code").equals("result-unknown")
          ? "unknown"
          : error != null
            ? "failed"
            : wasCancelled && !hasAllSucceeded
              ? "cancelled"
              : "succeeded";
      task.state.put("status", status);
      task.state.put("stage", "done");
      task.state.put("failureStage", hasAllSucceeded ? null : failureStage);
      task.state.put("updatedAt", System.currentTimeMillis());
      task.state.put("result", actual);
      task.state.put("error", error);
      task.state.put("cleanupError", cleanupError);
      if (status.equals("cancelled")) {
        task.state.put("isCancelRequested", true);
      }
      task.terminalAt = System.nanoTime();
      try {
        long[] counts = SyncJobModel.result(actual, task.plan);
        Map<String, Object> counters = map(task.state.get("progress"));
        counters.put("publishedFiles", counts[0]);
        counters.put("fileBytesPublished", counts[1]);
        SyncJobModel.state(copy(task.state), task.plan, "receiver");
      } catch (Exception invalid) {
        // 结果不符合公开校验时保留结果并停止接受任务，不能把这个错误当成成功。
        Map<String, Object> unknown = problem(
          "result-unknown",
          "The target result cannot be matched to this confirmation. Read the target again."
        );
        task.state.put("status", "unknown");
        task.state.put("error", unknown);
        actual.put("error", unknown);
        isStopped = true;
      }
    }
  }

  private boolean clean(Task task) {
    try {
      if (!local.retryCleanup()) {
        return false;
      }
      ArchiveAdapter.Staged staged;
      synchronized (this) {
        staged = task.staged;
      }
      if (staged != null) {
        staged.close();
        synchronized (this) {
          task.staged = null;
        }
      }
      archives.retryCleanup();
      synchronized (this) {
        if (task.hasLease) {
          TargetOperation.release(task);
          task.hasLease = false;
        }
        if (active == task) {
          active = null;
        }
      }
      return true;
    } catch (Exception failed) {
      return false;
    }
  }

  private static void close(Closeable connection) {
    if (connection == null) {
      return;
    }
    try {
      connection.close();
    } catch (IOException ignored) {
      // 连接已经关闭。
    }
  }

  /** 中止任务；reason 为 null 表示按取消记录。已结束或已中止的任务不受影响。 */
  private void abort(Task task, Map<String, Object> reason) {
    Closeable connection;
    boolean shouldFail;
    synchronized (this) {
      if (!task.isRunning() || task.isAborted) {
        return;
      }
      task.isAborted = true;
      task.reason = task.isCancelling ? null : reason;
      task.state.put("isCancelRequested", task.reason == null);
      task.state.put("updatedAt", System.currentTimeMillis());
      connection = task.connection;
      shouldFail = !task.isWorking;
    }
    task.control.cancel();
    task.content.completeExceptionally(cancelled());
    close(connection);
    if (shouldFail) {
      submit(task, () -> {
        throw cancelled();
      });
    }
  }

  /**
   * 应用拨号方推送的任务摘要，不属于本会话任务的摘要忽略；对端作为接收端结束后读取一次逐项结果。
   * 本机作为接收端还没收到内容时，发送端报告失败或取消，本机任务随之取消。
   */
  void observe(String peerId, Object raw) {
    Task task;
    boolean shouldAbort = false;
    boolean shouldRead = false;
    synchronized (this) {
      String jobId;
      try {
        jobId = id(map(raw).get("jobId"));
      } catch (ArchiveFailure invalid) {
        return;
      }
      task = tasks.get(jobId);
      if (task == null || !task.peerId.equals(peerId)) {
        return;
      }
      task.remoteSeenAt = System.nanoTime();
      Map<String, Object> digest;
      try {
        digest = digest(raw, task);
      } catch (Exception invalid) {
        task.remoteError = problem(
          "result-unknown",
          "The peer reported a state that does not match this task."
        );
        return;
      }
      task.remoteError = null;
      Map<String, Object> previous = task.remote;
      String status = (String) digest.get("status");
      if (!digest.get("role").equals("receiver") || status.equals("running")) {
        task.remote = digest;
        remoteChanged(task, previous);
        // 发送端在交出内容前就结束了，内容不会再来；和收到它的取消请求一样处理，不等总期限。
        shouldAbort =
          task.isReceiver &&
          !task.isContentClaimed &&
          (status.equals("failed") || status.equals("cancelled"));
      } else if (previous != null && previous.get("result") != null) {
        Map<String, Object> next = new LinkedHashMap<>(previous);
        Map<String, Object> result = new LinkedHashMap<>(mapUnchecked(previous.get("result")));
        result.put("cleanupError", digest.get("cleanupError"));
        next.put("updatedAt", digest.get("updatedAt"));
        next.put("cleanupError", digest.get("cleanupError"));
        next.put("result", result);
        task.remote = next;
      } else {
        Map<String, Object> placeholder = new LinkedHashMap<>(digest);
        placeholder.put("status", "running");
        placeholder.put("stage", "cleaning");
        placeholder.put("failureStage", null);
        placeholder.put("error", null);
        placeholder.put("result", null);
        task.remote = placeholder;
        task.shouldReadRemote = true;
        shouldRead = true;
      }
    }
    if (shouldAbort) {
      abort(task, null);
    }
    if (shouldRead) {
      readRemoteResult(task);
    }
  }

  /** 校验摘要并补上 result: null；接收端的终态摘要不带逐项结果，只核对身份和状态。 */
  private static Map<String, Object> digest(Object raw, Task task) throws Exception {
    Map<String, Object> value = shape(
      copy(raw),
      "schemaVersion",
      "jobId",
      "direction",
      "role",
      "status",
      "stage",
      "updatedAt",
      "isCancelRequested",
      "progress",
      "failureStage",
      "error",
      "cleanupError"
    );
    Map<String, Object> state = new LinkedHashMap<>(value);
    state.put("result", null);
    if (task.opposite().equals("sender") || "running".equals(value.get("status"))) {
      return SyncJobModel.state(state, task.plan, task.opposite());
    }
    number(
      value.get("schemaVersion"),
      SyncJobModel.JOB_SCHEMA_VERSION,
      SyncJobModel.JOB_SCHEMA_VERSION
    );
    require(
      task.jobId().equals(value.get("jobId")) &&
        task.plan.value.get("direction").equals(value.get("direction")) &&
        task.opposite().equals(value.get("role"))
    );
    number(value.get("updatedAt"), -BackupModel.MAX_DATE, BackupModel.MAX_DATE);
    one(value.get("status"), "succeeded", "failed", "cancelled", "unknown");
    if (value.get("cleanupError") != null) {
      require(TransferSchema.error(value.get("cleanupError")).get("code").equals("cleanup-failed"));
    }
    return state;
  }

  /** 对端刚结束时重新计算留存期，发送先结束、对端写入很久的任务不会被提前清掉。 */
  private static void remoteChanged(Task task, Map<String, Object> previous) {
    if (
      previous != null &&
      previous.get("status").equals("running") &&
      task.remote != null &&
      !task.remote.get("status").equals("running") &&
      task.terminalAt != null
    ) {
      task.terminalAt = System.nanoTime();
    }
  }

  private void readRemoteResult(Task task) {
    synchronized (this) {
      if (task.isReadingRemote) {
        return;
      }
      task.isReadingRemote = true;
      task.remoteReadAt = System.nanoTime();
    }
    control
      .request(task.peerId, "sync.job.read", object("jobId", task.jobId()))
      .whenComplete((value, error) -> {
        synchronized (this) {
          task.isReadingRemote = false;
          try {
            if (error != null) {
              throw new ArchiveFailure("result-unknown", "The peer result could not be read.");
            }
            Map<String, Object> state = SyncJobModel.state(value, task.plan, task.opposite());
            require(!state.get("status").equals("running"));
            task.remoteError = null;
            task.shouldReadRemote = false;
            Map<String, Object> previous = task.remote;
            task.remote = state;
            remoteChanged(task, previous);
          } catch (Exception invalid) {
            task.remoteError = problem(
              "result-unknown",
              "The result from the peer could not be read. It will be read again."
            );
          }
        }
      });
  }

  /** 对端还没有最终结论：等它的摘要或结果。接收端自己已结束时，不用等发送端的状态。 */
  private static boolean isRemoteUnsettled(Task task) {
    if (task.remote != null) {
      return task.remote.get("status").equals("running");
    }
    Object status = task.state.get("status");
    return status.equals("running") || status.equals("sent");
  }

  private static boolean isRemoteLive(Task task) {
    return task.remoteError == null && isRemoteUnsettled(task);
  }

  private void sweep() {
    List<Task> expired = new ArrayList<>();
    List<Task> reads = new ArrayList<>();
    synchronized (this) {
      long now = System.nanoTime();
      Iterator<Task> items = tasks.values().iterator();
      while (items.hasNext()) {
        Task task = items.next();
        boolean isOpen = control.isOpen(task.peerId);
        // 控制通道断开或长时间没有摘要时，对端的进度已不可信；对端重连后摘要会清掉这个错误。
        if (
          isRemoteUnsettled(task) &&
          task.remoteError == null &&
          (!isOpen || now - task.remoteSeenAt >= NETWORK_IDLE_NANOS)
        ) {
          task.remoteError = problem(
            "result-unknown",
            "The connection to the peer was lost. The result is unconfirmed."
          );
        }
        if (task.shouldReadRemote && now - task.remoteReadAt >= REMOTE_READ_RETRY_NANOS && isOpen) {
          reads.add(task);
        }
        if (task.isRunning()) {
          Object stage = task.state.get("stage");
          if (
            now - task.startedAt >= TOTAL_NANOS ||
            (task.awaitingSince != null && now - task.awaitingSince >= AWAITING_CONTENT_NANOS) ||
            (stage.equals("ready") && now - task.stageAt >= READY_NANOS) ||
            ((stage.equals("transferring") || (task.isContentClaimed && !task.isContentReceived)) &&
              now - task.networkAt >= NETWORK_IDLE_NANOS) ||
            // 发送端打包期间每秒推送摘要；这么久没收到，说明它已经不在，内容等不到。
            (task.isReceiver &&
              stage.equals("preparing") &&
              now - task.remoteSeenAt >= NETWORK_IDLE_NANOS)
          ) {
            expired.add(task);
          }
        } else if (
          !task.hasLease &&
          !isRemoteLive(task) &&
          task.terminalAt != null &&
          now - task.terminalAt >= RETENTION_NANOS
        ) {
          items.remove();
        }
      }
      while (tasks.size() > MAX_TASKS) {
        String oldest = null;
        for (Task task : tasks.values()) {
          if (!task.isRunning() && !task.hasLease) {
            oldest = task.jobId();
            break;
          }
        }
        if (oldest == null) {
          break;
        }
        tasks.remove(oldest);
      }
    }
    for (Task task : expired) {
      abort(task, problem("timeout", "The sync task exceeded its deadline. Query its result."));
    }
    for (Task task : reads) {
      readRemoteResult(task);
    }
  }

  private Task localTask(String id) throws ArchiveFailure {
    sweep();
    synchronized (this) {
      Task task = tasks.get(id);
      if (task == null) {
        throw new ArchiveFailure(
          "not-found",
          "This sync task ended or expired. Read the directory again."
        );
      }
      return task;
    }
  }

  /** 判断当前会话是否登记了这个任务。 */
  synchronized boolean has(String id) {
    return tasks.containsKey(id);
  }

  /** 返回任务两个角色的状态，格式同共享 SyncTransferState；任务不存在时抛出 not-found。 */
  Map<String, Object> query(String id) throws Exception {
    Task task = localTask(id);
    synchronized (this) {
      return transfer(task);
    }
  }

  private static Map<String, Object> transfer(Task task) throws Exception {
    return map(
      copy(
        object(
          "schemaVersion",
          1,
          "jobId",
          task.jobId(),
          "local",
          task.state,
          "remote",
          task.remote,
          "remoteError",
          task.remoteError
        )
      )
    );
  }

  /** 返回任务的预览，格式同共享 SyncPreparationPreview，本机一侧是监听方；任务不存在时抛出 not-found。 */
  Map<String, Object> preview(String id) throws Exception {
    Task task = localTask(id);
    SyncPlanModel.Plan plan = task.plan;
    return map(
      copy(
        object(
          "schemaVersion",
          1,
          "preparationId",
          plan.id,
          "direction",
          plan.value.get("direction"),
          "localSide",
          "listener",
          "binding",
          object(
            "projectId",
            task.localProject,
            "remoteProjectId",
            task.remoteProject,
            "localDeviceId",
            local.deviceId(),
            "remoteDeviceId",
            task.peerId,
            "localRootId",
            task.isReceiver ? plan.target.root : plan.source.root,
            "remoteRootId",
            task.isReceiver ? plan.source.root : plan.target.root
          ),
          "source",
          plan.source.value,
          "target",
          plan.target.value,
          "shouldBackup",
          plan.shouldBackup,
          "shouldDeleteExtras",
          plan.shouldDeleteExtras
        )
      )
    );
  }

  /**
   * 取消任务：对端还没结束时先经控制通道请它取消，再取消本机这一端；在调用线程上最多等 {@link
   * ListenerControl#REQUEST_TIMEOUT_MS}。
   *
   * @throws ArchiveFailure 任务不存在时为 not-found；本机这一端已结束且通知对端失败时为通知的错误。
   */
  Map<String, Object> localCancel(String id) throws Exception {
    Task task = localTask(id);
    boolean isLocalRunning;
    boolean shouldNotify;
    synchronized (this) {
      isLocalRunning = task.isRunning();
      shouldNotify = isRemoteUnsettled(task) && control.isOpen(task.peerId);
      // 对端取消后会关掉内容连接，本机看到的是连接断开；通知期间的中止按取消记录，两端结论一致。
      if (shouldNotify) {
        task.isCancelling = isLocalRunning;
      }
    }
    if (shouldNotify) {
      try {
        control
          .request(task.peerId, "sync.job.cancel", object("jobId", id))
          .get(ListenerControl.REQUEST_TIMEOUT_MS + 2000, TimeUnit.MILLISECONDS);
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        throw ArchiveFailure.from(interrupted);
      } catch (ExecutionException | TimeoutException failed) {
        if (!isLocalRunning) {
          Throwable cause = failed.getCause();
          throw cause instanceof ArchiveFailure
            ? (ArchiveFailure) cause
            : ArchiveFailure.from(failed);
        }
      }
    }
    abort(task, null);
    synchronized (this) {
      return transfer(task);
    }
  }

  /**
   * 重试活动任务的缓存清理；失败时继续占名额。
   *
   * @throws ArchiveFailure 任务还在运行时为 busy，清理失败时为 cleanup-failed。
   */
  void retryCleanup() throws Exception {
    Task task;
    synchronized (this) {
      task = active;
      if (task == null) {
        return;
      }
      if (task.isRunning()) {
        throw new ArchiveFailure("busy", "The sync task has not finished.");
      }
    }
    if (!clean(task)) {
      throw new ArchiveFailure("cleanup-failed", "Cleanup failed. Retry later.");
    }
    synchronized (this) {
      task.state.put("cleanupError", null);
      if (task.state.get("result") != null) {
        mapUnchecked(task.state.get("result")).put("cleanupError", null);
      }
    }
  }

  /** 是否有任务占着名额，或本机或对端还在执行。 */
  synchronized boolean busy() {
    if (active != null) {
      return true;
    }
    for (Task task : tasks.values()) {
      if (task.isRunning() || isRemoteLive(task)) {
        return true;
      }
    }
    return false;
  }

  /** 占着名额或还在执行的最近一个任务的 ID；没有时为 null。 */
  synchronized String activeId() {
    if (active != null) {
      return active.jobId();
    }
    String last = null;
    for (Task task : tasks.values()) {
      if (task.isRunning() || isRemoteLive(task)) {
        last = task.jobId();
      }
    }
    return last;
  }

  /** 最近登记的任务的 ID；没有时为 null。 */
  synchronized String current() {
    if (active != null) {
      return active.jobId();
    }
    String last = null;
    for (Task task : tasks.values()) {
      last = task.jobId();
    }
    return last;
  }

  /** 任务在本机这一端的项目 ID；任务不存在时为 null。 */
  synchronized String projectId(String id) {
    Task task = tasks.get(id);
    return task == null ? null : task.localProject;
  }

  /** 本机项目 projectId 最近一次任务的 ID；没有时为 null。 */
  synchronized String latest(String projectId) {
    String last = null;
    for (Task task : tasks.values()) {
      if (task.localProject.equals(projectId)) {
        last = task.jobId();
      }
    }
    return last;
  }

  /** 通知用的阶段和进度快照，字段同 {@link SyncTransferEngine#notice}；没有 {@link #activeId} 时返回 null。 */
  synchronized Map<String, Object> notice() {
    String id = activeId();
    Task task = id == null ? null : tasks.get(id);
    if (task == null) {
      return null;
    }
    boolean isRunning = task.isRunning();
    String stage = (String) task.state.get("stage");
    Map<String, Object> progress = mapUnchecked(task.state.get("progress"));
    // 本机发送完后对端还在写入，通知跟随对端的阶段和进度。
    if (!isRunning && isRemoteLive(task) && task.remote != null) {
      stage = (String) task.remote.get("stage");
      progress = mapUnchecked(task.remote.get("progress"));
    }
    return object(
      "transferId",
      task.jobId(),
      "isUpload",
      !task.isReceiver,
      "running",
      isRunning || isRemoteLive(task),
      "stage",
      stage,
      "progress",
      new LinkedHashMap<>(progress)
    );
  }

  /** 本机是否正作为接收端占着写入名额。 */
  synchronized boolean ownsTarget() {
    return active != null && active.isReceiver && TargetOperation.owns(active);
  }

  /**
   * 核对写入目标仍属于活动的接收任务，并且项目关联和备份设置与确认时一致。
   *
   * @throws ArchiveFailure 没有对应的接收任务时为 permission-denied；关联或设置改变时为 verify 的错误。
   */
  void verifyTargetContext(String projectId, String rootId) throws Exception {
    Task task;
    synchronized (this) {
      task = active;
      if (
        task == null ||
        !task.isReceiver ||
        !task.isRunning() ||
        !task.plan.project.equals(projectId) ||
        !task.plan.target.root.equals(rootId) ||
        !TargetOperation.owns(task)
      ) {
        throw new ArchiveFailure("permission-denied", "No sync task owns this target.");
      }
    }
    verify(task);
  }

  /**
   * 停止接受任务并取消进行中的任务，立即返回；后台线程最多等 {@link #STOP_WAIT_SECONDS} 秒让任务结束和清理，然后关闭扫描器。可以重复调用。
   */
  void stop() {
    Task task;
    synchronized (this) {
      if (isClosing) {
        return;
      }
      isClosing = true;
      isStopped = true;
      task = active;
    }
    timer.shutdownNow();
    if (task != null) {
      abort(task, null);
    }
    worker.shutdown();
    // 调用方可能在主线程上，等待放到单独的线程。
    Thread closing = new Thread(this::awaitStop, "listener-sync-stop");
    closing.setDaemon(true);
    closing.start();
  }

  private void awaitStop() {
    try {
      if (!worker.awaitTermination(STOP_WAIT_SECONDS, TimeUnit.SECONDS)) {
        worker.shutdownNow();
      }
      retryCleanup();
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
    } catch (Exception failed) {
      // 清理失败时名额保留，之后的复制或恢复会报 busy，直到进程结束。
    }
    try {
      scanner.close();
    } catch (Exception ignored) {
      // 扫描器只持有只读的流和内存结果。
    }
    synchronized (this) {
      tasks.clear();
    }
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> mapUnchecked(Object value) {
    return (Map<String, Object>) value;
  }

  /** 上传的请求体：读到数据算网络进展，连接断开或格式不对时按 network-failure 报告。close 不关闭连接。 */
  private final class UploadBody extends InputStream {

    private final InputStream input;
    private final Task task;

    UploadBody(InputStream input, Task task) {
      this.input = input;
      this.task = task;
    }

    @Override
    public int read() throws IOException {
      byte[] one = new byte[1];
      return read(one, 0, 1) < 0 ? -1 : one[0] & 0xff;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
      int count;
      try {
        count = input.read(buffer, offset, length);
      } catch (IOException lost) {
        throw new ArchiveFailure(
          "network-failure",
          "The upload connection was interrupted.",
          false,
          lost
        );
      }
      if (count > 0) {
        synchronized (ListenerSyncJobs.this) {
          task.networkAt = System.nanoTime();
        }
      }
      return count;
    }

    @Override
    public void close() {
      // 请求体属于连接；中止任务时由 abort 关闭连接唤醒阻塞的读取。
    }
  }
}
