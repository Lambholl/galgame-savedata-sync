package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.bytes;
import static io.github.galgame.savedatasync.TransferJson.copy;
import static io.github.galgame.savedatasync.TransferJson.fail;
import static io.github.galgame.savedatasync.TransferJson.list;
import static io.github.galgame.savedatasync.TransferJson.map;
import static io.github.galgame.savedatasync.TransferJson.object;
import static io.github.galgame.savedatasync.TransferJson.parse;
import static io.github.galgame.savedatasync.TransferSchema.device;
import static io.github.galgame.savedatasync.TransferSchema.error;
import static io.github.galgame.savedatasync.TransferSchema.id;
import static io.github.galgame.savedatasync.TransferSchema.limits;
import static io.github.galgame.savedatasync.TransferSchema.number;
import static io.github.galgame.savedatasync.TransferSchema.one;
import static io.github.galgame.savedatasync.TransferSchema.require;
import static io.github.galgame.savedatasync.TransferSchema.shape;
import static io.github.galgame.savedatasync.TransferSchema.state;
import static io.github.galgame.savedatasync.TransferSchema.string;
import static io.github.galgame.savedatasync.TransferSchema.text;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 复制任务的引擎：prepare 只读准备，reserve 按预览占名额，begin 开始执行。
 *
 * <p>任务只保存在内存里。活动任务和未释放的缓存占用同一个进程名额。
 */
final class SyncTransferEngine implements AutoCloseable {

  interface Local {
    String deviceId();

    Map<String, Object> snapshot(String rootId, ArchiveControl control) throws Exception;

    List<ArchiveModel.Source> sources(SyncPlanModel.Plan plan) throws Exception;

    default boolean backup(String projectId) throws Exception {
      throw fail("unsupported-operation");
    }

    default long backupKeep(String projectId) throws Exception {
      throw fail("unsupported-operation");
    }

    default long checkReceiveSpace(
      SyncPlanModel.Plan plan,
      java.nio.file.Path cacheRoot,
      long cacheBytes,
      ArchiveControl control,
      SyncWriter.Execution execution
    ) throws Exception {
      throw fail("unsupported-operation");
    }

    default Map<String, Object> apply(
      SyncPlanModel.Plan plan,
      SyncWriter.Material material,
      ArchiveControl control,
      SyncWriter.Execution execution
    ) throws Exception {
      throw fail("unsupported-operation");
    }

    default boolean retryCleanup() throws Exception {
      return true;
    }

    default void close() throws Exception {}
  }

  private static final long RETENTION = TimeUnit.MINUTES.toNanos(10);
  private static final long REPORT_INTERVAL = TimeUnit.SECONDS.toNanos(1);
  /** 能归到某一端的错误码；shared 的 locateSyncError 是同一份清单。 */
  private static final Set<String> DEVICE_ERRORS = new HashSet<>(
    java.util.Arrays.asList(
      "authorization-expired",
      "permission-denied",
      "not-found",
      "not-readable",
      "unsupported-operation",
      "name-conflict",
      "path-outside-root",
      "insufficient-space",
      "io-failure"
    )
  );

  // 打包阶段两端都可能报授权失效，界面按阶段推断不出是哪一端，要在这里注明。
  // 电脑不产生 authorization-expired，转述电脑的错误时已注明 pc，所以没注明的授权失效都是本机目录。
  /** 返回任务错误该注明的一端（phone 或 pc）；分不出时为 null。 */
  private static String failedDevice(ArchiveFailure failure) {
    if (failure.device != null || !DEVICE_ERRORS.contains(failure.code)) {
      return failure.device;
    }
    return failure.code.equals("authorization-expired") ? "phone" : null;
  }

  private final TransferEngine transport;
  private final ArchiveAdapter archives;
  private final Local local;
  private final ExecutorService preparer = Executors.newSingleThreadExecutor();
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  /** 接收时与下载并行运行写入器的线程。 */
  private final ExecutorService writers = Executors.newSingleThreadExecutor();
  private final ScheduledExecutorService watcher = Executors.newSingleThreadScheduledExecutor();
  private final ScheduledExecutorService heartbeats = Executors.newSingleThreadScheduledExecutor();
  /** 向电脑推送任务摘要、应答读取和取消的线程，页面被回收后照常工作。 */
  private final ScheduledExecutorService reports = Executors.newSingleThreadScheduledExecutor();
  private final Map<String, Preparation> preparations = new LinkedHashMap<>();
  private final Map<String, Job> jobs = new LinkedHashMap<>();
  private final Set<String> used = new HashSet<>();
  private Preparation preparing;
  private Job active;
  private Job heartbeatOwner;
  private ArchiveControl heartbeatControl;
  private boolean isClosed;

  private static final class Preparation {

    final String id = UUID.randomUUID().toString();
    final Map<String, Object> binding;
    final TransferEngine.SyncConnection connection;
    final String direction;
    final ArchiveControl control = new ArchiveControl();
    String status = "preparing";
    String scanId;
    Map<String, Object> preview;
    Map<String, Object> error;
    long settled;
    volatile boolean hasTimedOut;
    boolean isConsumed;
    boolean wasCancelRequested;

    Preparation(
      Map<String, Object> binding,
      TransferEngine.SyncConnection connection,
      String direction
    ) {
      this.binding = binding;
      this.connection = connection;
      this.direction = direction;
    }

    boolean upload() {
      return direction.equals("android-to-windows");
    }

    Map<String, Object> state() {
      return object(
        "schemaVersion",
        1,
        "preparationId",
        id,
        "direction",
        direction,
        "status",
        status,
        "error",
        error
      );
    }
  }

  private static final class Job {

    final Preparation preparation;
    final SyncPlanModel.Plan plan;
    final long acceptedAt = System.currentTimeMillis();
    final ArchiveControl control = new ArchiveControl();
    Map<String, Object> state;
    Map<String, Object> remote;
    Map<String, Object> remoteError;
    ArchiveAdapter.Staged staged;
    /** 接收的内容全部解包后完成，失败时带着原因异常完成。 */
    final CompletableFuture<Void> content = new CompletableFuture<>();
    volatile boolean isBackupDone;
    volatile boolean isContentClaimed;
    volatile boolean isContentReceived;
    /** 写入器在内容到齐前就结束了；由 job 的锁保护。 */
    boolean hasWriterStopped;
    volatile boolean isRunning = true;
    boolean hasStarted;
    boolean wasRemoteAttempted;
    boolean wasCancelSent;
    boolean isUploadComplete;
    boolean hasLease = true;
    long ended;
    volatile boolean hasTimedOut;
    volatile boolean isPreparingArchive;
    /** 只由 reports 线程读写；只在发送成功后更新，断开期间的变化重连后补发。 */
    String reported;
    long reportedAt;

    Job(Preparation preparation, SyncPlanModel.Plan plan) {
      this.preparation = preparation;
      this.plan = plan;
    }

    String path() {
      return "/v1/sync/jobs/" + plan.id;
    }
  }

  SyncTransferEngine(TransferEngine transport, Local local) {
    this.transport = transport;
    this.archives = transport.syncArchive();
    this.local = local;
    watcher.scheduleAtFixedRate(this::tick, 100, 100, TimeUnit.MILLISECONDS);
    heartbeats.scheduleAtFixedRate(this::heartbeat, 3, 3, TimeUnit.SECONDS);
    reports.scheduleAtFixedRate(this::report, 500, 500, TimeUnit.MILLISECONDS);
    transport.controlInterceptor(this::controlRequest);
  }

  /** 推送有变化的任务摘要；进行中的任务没有变化也每秒推送一次，作为在线信号。 */
  private void report() {
    Map<Job, String> pending = new LinkedHashMap<>();
    long now = System.nanoTime();
    synchronized (this) {
      if (isClosed) {
        return;
      }
      for (Job job : jobs.values()) {
        try {
          Map<String, Object> digest = new LinkedHashMap<>(job.state);
          digest.remove("result");
          String text = new String(
            bytes(object("v", 1, "type", "event", "method", "sync.job", "body", digest)),
            StandardCharsets.UTF_8
          );
          if (
            !text.equals(job.reported) ||
            (job.state.get("status").equals("running") && now - job.reportedAt >= REPORT_INTERVAL)
          ) {
            pending.put(job, text);
          }
        } catch (Exception invalid) {
          /* 单个任务序列化失败不影响其他任务，下一轮再试。 */
        }
      }
    }
    for (Map.Entry<Job, String> item : pending.entrySet()) {
      try {
        transport.sendControl(item.getKey().preparation.connection.deviceId, item.getValue());
        item.getKey().reported = item.getValue();
        item.getKey().reportedAt = now;
      } catch (Exception offline) {
        /* 控制通道没开时保留变化，重连后补发。 */
      }
    }
  }

  private boolean controlRequest(String deviceId, String text) {
    Map<String, Object> message;
    try {
      message = map(parse(text.getBytes(StandardCharsets.UTF_8)));
    } catch (Exception invalid) {
      return false;
    }
    Object method = message.get("method");
    if (
      !"request".equals(message.get("type")) ||
      !("sync.job.read".equals(method) || "sync.job.cancel".equals(method))
    ) {
      return false;
    }
    try {
      reports.execute(() -> answer(deviceId, message));
    } catch (java.util.concurrent.RejectedExecutionException stopped) {
      /* 引擎已关闭，电脑按超时处理。 */
    }
    return true;
  }

  /** 应答电脑读取和取消任务的请求，只应答发起这次任务的电脑；已结束任务的取消没有效果，结果以读取为准。 */
  private void answer(String deviceId, Map<String, Object> message) {
    Map<String, Object> result;
    try {
      String jobId = id(map(message.get("body")).get("jobId"));
      Object value = null;
      Job job;
      synchronized (this) {
        job = jobs.get(jobId);
      }
      if (job == null || !job.preparation.connection.deviceId.equals(deviceId)) {
        throw fail("not-found");
      }
      if ("sync.job.read".equals(message.get("method"))) {
        synchronized (this) {
          value = copy(job.state);
        }
      } else if (job.isRunning) {
        cancel(jobId, false);
      }
      result = object("status", "success", "value", value);
    } catch (Exception cause) {
      result = object("status", "error", "error", error(ArchiveFailure.from(cause).code));
    }
    try {
      transport.sendControl(
        deviceId,
        new String(
          bytes(object("v", 1, "type", "response", "id", message.get("id"), "result", result)),
          StandardCharsets.UTF_8
        )
      );
    } catch (Exception offline) {
      /* 电脑收不到应答时按超时处理，稍后重新读取。 */
    }
  }

  private void available() throws ArchiveFailure {
    if (isClosed) {
      throw fail("unsupported-operation");
    }
  }

  private void purge() {
    long now = System.nanoTime();
    jobs.values().removeIf(job -> !job.isRunning && !job.hasLease && now - job.ended >= RETENTION);
    preparations
      .values()
      .removeIf(
        preparation ->
          preparation != preparing &&
          preparation.settled != 0 &&
          !jobs.containsKey(preparation.id) &&
          now - preparation.settled >= RETENTION
      );
  }

  private void trim(Preparation retained) {
    purge();
    if (jobs.size() >= 32) {
      for (Job job : new ArrayList<>(jobs.values())) {
        if (!job.isRunning && !job.hasLease) {
          jobs.remove(job.plan.id);
          break;
        }
      }
    }
    if (preparations.size() >= 32) {
      for (Preparation preparation : new ArrayList<>(preparations.values())) {
        if (
          preparation != preparing && preparation != retained && !jobs.containsKey(preparation.id)
        ) {
          preparations.remove(preparation.id);
          break;
        }
      }
    }
  }

  private void tick() {
    Preparation preparation;
    Job job;
    synchronized (this) {
      purge();
      preparation = preparing;
      job = active;
    }
    if (preparation != null) {
      try {
        preparation.control.check();
      } catch (ArchiveFailure failure) {
        if (!failure.isCancelled) {
          preparation.hasTimedOut = true;
        }
        preparation.control.cancel();
      }
    }
    if (job != null && job.isRunning) {
      try {
        job.control.check();
      } catch (ArchiveFailure failure) {
        if (!failure.isCancelled) {
          job.hasTimedOut = true;
        }
        job.control.cancel();
      }
    }
  }

  private void heartbeat() {
    Job job;
    ArchiveControl control;
    synchronized (this) {
      job = active;
      if (isClosed || job == null || !job.isRunning || !job.isPreparingArchive) {
        return;
      }
      control = shortControl();
      heartbeatOwner = job;
      heartbeatControl = control;
    }
    try {
      Object raw = job.preparation.connection.http.json(
        "GET",
        job.path(),
        job.preparation.connection.session,
        null,
        200,
        control
      );
      SyncJobModel.state(raw, job.plan);
      // 心跳只核对通信，不写入远端快照，避免与清单和内容回执的顺序竞争。
    } catch (Exception ignored) {
      /* 之后的提交或查询由主 worker 判断；心跳不重做写入。 */
    } finally {
      control.cancel();
      synchronized (this) {
        if (heartbeatControl == control) {
          heartbeatControl = null;
          heartbeatOwner = null;
        }
      }
    }
  }

  private void stopHeartbeat(Job job) {
    ArchiveControl control;
    synchronized (this) {
      control = heartbeatOwner == job ? heartbeatControl : null;
    }
    if (control != null) {
      control.cancel();
    }
  }

  /**
   * 开始只读准备，进度和结果按返回的 preparationId 查询；准备不占传输名额。
   *
   * <p>新的准备会取消还没结束的准备，并等它收尾后才开始。
   */
  Map<String, Object> prepare(Object rawBinding, String direction) throws Exception {
    Preparation preparation;
    Preparation superseded;
    synchronized (this) {
      available();
      one(direction, "android-to-windows", "windows-to-android");
      Map<String, Object> binding = SyncJobModel.binding(rawBinding);
      require(local.deviceId().equals(binding.get("localDeviceId")));
      trim(null);
      if (preparations.size() >= 32) {
        throw fail("busy");
      }
      preparation = new Preparation(binding, transport.syncConnection(binding), direction);
      superseded = preparing;
      if (superseded != null) {
        superseded.wasCancelRequested = true;
      }
      preparations.put(preparation.id, preparation);
      preparing = preparation;
      preparer.execute(() -> prepareNow(preparation));
    }
    if (superseded != null) {
      superseded.control.cancel();
    }
    synchronized (this) {
      return preparation.state();
    }
  }

  private void prepareNow(Preparation preparation) {
    boolean hasRemoteScan = false;
    // 正在访问哪一端的目录；失败时写进错误，界面据此说明是哪一端的问题。
    String accessing = null;
    Map<String, Object> prepared = null;
    ArchiveFailure problem = null;
    try {
      Map<String, Object> binding = preparation.binding;
      TransferEngine.SyncConnection connection = preparation.connection;
      transport.refreshSync(connection, binding, preparation.control);
      // 能力版本和固定上限必须先协商；批量接口不能承担覆盖。
      Object advertised;
      try {
        advertised = connection.http.json(
          "GET",
          "/v1/sync/capabilities",
          connection.session,
          null,
          200,
          preparation.control
        );
      } catch (ArchiveFailure failure) {
        if (failure.code.equals("not-found") || failure.code.equals("unsupported-operation")) {
          throw new ArchiveFailure(
            "unsupported-operation",
            "Update both apps before syncing.",
            false,
            failure
          );
        }
        throw failure;
      }
      Map<String, Object> capabilities = shape(
        advertised,
        "schemaVersion",
        "deviceId",
        "canScan",
        "canCopy",
        "canBackup",
        "canRestore",
        "limits"
      );
      if (
        number(capabilities.get("schemaVersion"), 0, 9007199254740991L) !=
        SyncJobModel.CAPABILITIES_VERSION
      ) {
        throw new ArchiveFailure("protocol-mismatch", "Update both apps before syncing.");
      }
      require(connection.deviceId.equals(capabilities.get("deviceId")));
      for (String key : new String[] { "canScan", "canCopy", "canBackup", "canRestore" }) {
        one(capabilities.get(key), "supported", "unsupported", "unknown");
      }
      if (
        !capabilities.get("canScan").equals("supported") ||
        !capabilities.get("canCopy").equals("supported") ||
        !capabilities.get("canBackup").equals("supported")
      ) {
        throw new ArchiveFailure(
          "unsupported-operation",
          "The peer does not provide this sync capability yet. Update both apps."
        );
      }
      Map<String, Object> limits = object(
        "maxEntries",
        10000,
        "maxDepth",
        64,
        "maxPathLength",
        4096,
        "maxNameLength",
        255,
        "maxRetainedScans",
        32,
        "snapshotLifetimeMs",
        600000,
        "scanTimeoutMs",
        1800000
      );
      if (!SyncPlanModel.same(limits, capabilities.get("limits"))) {
        throw new ArchiveFailure(
          "protocol-mismatch",
          "Sync budgets differ between devices. Update both apps."
        );
      }
      String targetRoot = string(binding.get("remoteRootId"));
      final String sourceRoot = string(binding.get("localRootId"));
      accessing = "pc";
      Map<String, Object> remote = SyncJobModel.scan(
        startRemoteScan(preparation, targetRoot),
        connection.deviceId,
        targetRoot,
        null
      );
      synchronized (this) {
        preparation.scanId = id(remote.get("scanId"));
      }
      hasRemoteScan = true;
      accessing = "phone";
      final Map<String, Object> source = SyncJobModel.snapshot(
        local.snapshot(sourceRoot, preparation.control),
        local.deviceId(),
        sourceRoot
      );
      accessing = "pc";
      while (remote.get("status").equals("running")) {
        preparation.control.check();
        Thread.sleep(100);
        remote = SyncJobModel.scan(
          connection.http.json(
            "GET",
            "/v1/sync/scans/" + preparation.scanId,
            connection.session,
            null,
            200,
            preparation.control
          ),
          connection.deviceId,
          targetRoot,
          preparation.scanId
        );
      }
      hasRemoteScan = false;
      if (!remote.get("status").equals("succeeded")) {
        if (remote.get("error") != null) {
          throw new ArchiveFailure(
            string(map(remote.get("error")).get("code")),
            "The PC directory scan is incomplete."
          );
        }
        throw new ArchiveFailure("io-failure", "The PC directory scan was cancelled.");
      }
      Object descriptor = connection.http.json(
        "GET",
        "/v1/sync/projects/" + binding.get("remoteProjectId"),
        connection.session,
        null,
        200,
        preparation.control
      );
      boolean shouldBackupRemote = SyncJobModel.backup(descriptor, binding);
      accessing = null;
      boolean shouldBackup = preparation.upload()
        ? shouldBackupRemote
        : local.backup(string(binding.get("projectId")));
      long backupKeepCount = preparation.upload()
        ? SyncJobModel.backupKeepCount(descriptor)
        : local.backupKeep(string(binding.get("projectId")));
      transport.verifySync(connection, binding);
      preparation.control.check();
      Map<String, Object> preview = object(
        "schemaVersion",
        1,
        "preparationId",
        preparation.id,
        "direction",
        preparation.direction,
        "binding",
        binding,
        "source",
        preparation.upload() ? source : remote.get("snapshot"),
        "target",
        preparation.upload() ? remote.get("snapshot") : source,
        "shouldBackup",
        shouldBackup,
        "shouldDeleteExtras",
        false,
        "backupKeepCount",
        backupKeepCount
      );
      bytes(preview);
      prepared = preview;
    } catch (Exception cause) {
      problem = ArchiveFailure.from(cause);
    } finally {
      if (hasRemoteScan) {
        cancelScan(preparation);
      }
      if (problem == null) {
        try {
          preparation.control.check();
        } catch (ArchiveFailure failure) {
          problem = failure;
        }
      }
      synchronized (this) {
        if (problem == null) {
          preparation.preview = prepared;
          preparation.status = "ready";
        } else {
          preparation.status =
            !preparation.hasTimedOut && (problem.isCancelled || preparation.wasCancelRequested)
              ? "cancelled"
              : "failed";
          preparation.error = preparation.status.equals("cancelled")
            ? null
            : object(
                "code",
                preparation.hasTimedOut ? "timeout" : problem.code,
                "message",
                preparation.hasTimedOut
                  ? "Sync preparation timed out. Scan again."
                  : problem.getMessage(),
                "canRetry",
                false
              );
          // 开始前核对两端时 accessing 还没设置，这时错误自己带着是哪一端。
          String device = problem.device != null ? problem.device : accessing;
          if (
            preparation.error != null &&
            device != null &&
            DEVICE_ERRORS.contains(preparation.error.get("code"))
          ) {
            preparation.error.put("device", device);
          }
        }
        preparation.settled = System.nanoTime();
        if (preparing == preparation) {
          preparing = null;
        }
      }
    }
  }

  /** 请对端开始扫描。电脑同一时间只跑一个扫描，刚取消的扫描可能还在收尾，等一小会儿再报 busy。 */
  private Object startRemoteScan(Preparation preparation, String rootId) throws Exception {
    TransferEngine.SyncConnection connection = preparation.connection;
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
    for (;;) {
      try {
        return connection.http.json(
          "POST",
          "/v1/sync/scans",
          connection.session,
          object("schemaVersion", 1, "rootId", rootId),
          202,
          preparation.control
        );
      } catch (ArchiveFailure failure) {
        if (!failure.code.equals("busy") || System.nanoTime() >= deadline) {
          throw failure;
        }
        preparation.control.check();
        Thread.sleep(100);
      }
    }
  }

  private void cancelScan(Preparation preparation) {
    ArchiveControl control = shortControl();
    try {
      preparation.connection.http.json(
        "DELETE",
        "/v1/sync/scans/" + preparation.scanId,
        preparation.connection.session,
        null,
        202,
        control
      );
    } catch (Exception ignored) {
      /* 只读扫描会自行到期，取消回执丢失后不重发。 */
    } finally {
      control.cancel();
    }
  }

  private Preparation preparation(String id) throws Exception {
    available();
    id(id);
    purge();
    Preparation preparation = preparations.get(id);
    if (preparation == null) {
      throw fail("not-found");
    }
    return preparation;
  }

  synchronized Map<String, Object> preparationState(String id) throws Exception {
    return map(copy(preparation(id).state()));
  }

  synchronized Map<String, Object> preview(String id) throws Exception {
    Preparation preparation = preparation(id);
    if (preparation.preview == null) {
      throw fail("task-conflict");
    }
    return map(copy(preparation.preview));
  }

  Map<String, Object> cancelPreparation(String id) throws Exception {
    Preparation preparation;
    synchronized (this) {
      preparation = preparation(id);
      if (preparation.isConsumed) {
        throw fail("task-conflict");
      }
      preparation.wasCancelRequested = true;
    }
    preparation.control.cancel();
    synchronized (this) {
      if (preparation.status.equals("ready") && !preparation.isConsumed) {
        preparation.status = "cancelled";
        preparation.preview = null;
        preparation.settled = System.nanoTime();
      }
      return map(copy(preparation.state()));
    }
  }

  /** 按预览占用传输名额；之后只能调用一次 begin 或 failStart。 */
  synchronized Map<String, Object> reserve(String id, Object rawPlan) throws Exception {
    Preparation preparation = preparation(id);
    SyncPlanModel.Plan plan = new SyncPlanModel.Plan(rawPlan);
    if (!preparation.status.equals("ready") || preparation.isConsumed || used.contains(id)) {
      throw fail("task-conflict");
    }
    if (System.nanoTime() - preparation.settled >= RETENTION) {
      throw fail("not-found");
    }
    require(
      plan.id.equals(id) &&
        plan.project.equals(
          preparation.binding.get(preparation.upload() ? "remoteProjectId" : "projectId")
        ) &&
        plan.reason.equals("copy") &&
        plan.value.get("direction").equals(preparation.direction) &&
        preparation.preview != null &&
        SyncPlanModel.same(plan.source.value, preparation.preview.get("source")) &&
        SyncPlanModel.same(plan.target.value, preparation.preview.get("target")) &&
        plan.shouldBackup == (Boolean) preparation.preview.get("shouldBackup")
    );
    transport.verifySync(preparation.connection, preparation.binding);
    bytes(SyncJobModel.request(plan, preparation.binding));
    long observed = number(
      (preparation.upload() ? plan.source : plan.target).value.get("observedAt"),
      -BackupModel.MAX_DATE,
      BackupModel.MAX_DATE
    );
    long now = System.currentTimeMillis();
    if (observed > now || now - observed > 600000) {
      throw fail("not-found");
    }
    trim(preparation);
    if (used.size() >= 4096 || jobs.size() >= 32 || active != null) {
      throw fail("busy");
    }
    Job job = new Job(preparation, plan);
    if (!TargetOperation.acquire(job)) {
      throw fail("busy");
    }
    long count = number(plan.value.get("transferFileCount"), 0, 1024);
    job.state = object(
      "schemaVersion",
      SyncJobModel.JOB_SCHEMA_VERSION,
      "jobId",
      id,
      "direction",
      preparation.direction,
      "role",
      preparation.upload() ? "sender" : "receiver",
      "status",
      "running",
      "stage",
      "preparing",
      "updatedAt",
      now,
      "cancelRequested",
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
        plan.value.get("totalFileBytes"),
        "totalFiles",
        count,
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
    // 页面重建后靠预览读回计划，这里记下这次确认的选择。
    preparation.preview.put("shouldDeleteExtras", plan.shouldDeleteExtras);
    preparation.isConsumed = true;
    used.add(id);
    jobs.put(id, job);
    active = job;
    return transfer(job);
  }

  synchronized void begin(String id) throws Exception {
    Job job = job(id);
    if (job.hasStarted || !job.isRunning) {
      throw fail("task-conflict");
    }
    job.hasStarted = true;
    try {
      worker.execute(() -> run(job));
    } catch (java.util.concurrent.RejectedExecutionException cause) {
      job.hasStarted = false;
      throw fail("unsupported-operation");
    }
  }

  synchronized void failStart(String id, Exception cause) throws Exception {
    Job job = job(id);
    if (job.hasStarted) {
      throw fail("task-conflict");
    }
    if (job.preparation.upload()) {
      ArchiveFailure failure = ArchiveFailure.from(cause);
      terminal(job, "failed", failure.code, failedDevice(failure));
    } else {
      receiverFailed(job, ArchiveFailure.from(cause));
    }
    job.isRunning = false;
    job.ended = System.nanoTime();
    release(job);
  }

  private synchronized void progress(Job job, String stage, String counter, long value)
    throws Exception {
    if (!job.state.get("status").equals("running")) {
      return;
    }
    if (counter != null) {
      Map<String, Object> counters = map(job.state.get("progress"));
      long maximum = number(counters.get("totalFileBytes"), 0, BackupModel.MAX_TOTAL);
      if (value < number(counters.get(counter), 0, maximum) || value > maximum) {
        throw new ArchiveFailure("source-changed", "The source file exceeds the confirmed plan.");
      }
      counters.put(counter, value);
    }
    job.state.put("stage", stage);
    job.state.put("updatedAt", System.currentTimeMillis());
  }

  private void run(Job job) {
    try {
      job.control.check();
      transport.refreshSync(job.preparation.connection, job.preparation.binding, job.control);
      boolean shouldBackupRemote = SyncJobModel.backup(
        job.preparation.connection.http.json(
          "GET",
          "/v1/sync/projects/" + job.preparation.binding.get("remoteProjectId"),
          job.preparation.connection.session,
          null,
          200,
          job.control
        ),
        job.preparation.binding
      );
      boolean shouldBackup = job.preparation.upload()
        ? shouldBackupRemote
        : local.backup(job.plan.project);
      if (shouldBackup != job.plan.shouldBackup) {
        throw new ArchiveFailure(
          "source-changed",
          (job.preparation.upload() ? "PC" : "Mobile device") +
            " backup settings changed. Confirm again."
        );
      }
      job.wasRemoteAttempted = true;
      try {
        accept(
          job,
          job.preparation.connection.http.json(
            "POST",
            "/v1/sync/jobs",
            job.preparation.connection.session,
            SyncJobModel.request(job.plan, job.preparation.binding),
            201,
            job.control
          )
        );
      } catch (Exception lost) {
        refresh(job, job.control);
      }
      if (job.preparation.upload()) {
        long count = number(job.plan.value.get("transferFileCount"), 0, 1024);
        if (count > 0) {
          upload(job);
        } else {
          synchronized (this) {
            job.isUploadComplete = true;
            terminal(job, "sent", null, null);
          }
        }
        awaitRemote(job);
      } else {
        download(job);
      }
    } catch (Exception cause) {
      ArchiveFailure failure = ArchiveFailure.from(cause);
      if (!job.preparation.upload()) {
        synchronized (this) {
          if (job.state.get("status").equals("running")) {
            receiverFailed(job, failure);
          }
        }
      } else if (!job.isUploadComplete) {
        synchronized (this) {
          boolean wasCancelled =
            !job.hasTimedOut &&
            (failure.isCancelled || Boolean.TRUE.equals(job.state.get("cancelRequested")));
          terminal(
            job,
            wasCancelled ? "cancelled" : "failed",
            wasCancelled ? null : job.hasTimedOut ? "timeout" : failure.code,
            wasCancelled || job.hasTimedOut ? null : failedDevice(failure)
          );
        }
      }
      // 移动端接收时总是取消远端。移动端发送时，用户取消、总期限或内容没发完才取消；发完后查询失败时，远端继续写入。
      if (job.wasRemoteAttempted) {
        if (
          !job.preparation.upload() ||
          !job.isUploadComplete ||
          failure.isCancelled ||
          job.hasTimedOut
        ) {
          cancelRemote(job);
        } else {
          synchronized (this) {
            if (job.remote == null || job.remote.get("status").equals("running")) {
              job.remoteError = error("result-unknown");
            }
          }
        }
      }
    } finally {
      job.isPreparingArchive = false;
      stopHeartbeat(job);
      synchronized (this) {
        cleanup(job);
        job.isRunning = false;
        job.ended = System.nanoTime();
        if (job.state.get("status").equals("running")) {
          if (job.preparation.upload()) {
            terminal(job, "failed", "io-failure", null);
          } else {
            receiverFailed(job, fail("io-failure"));
          }
        }
        if (job.hasLease && job.state.get("cleanupError") == null) {
          release(job);
        }
      }
    }
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

  private static long size(Map<String, Object> entry) throws Exception {
    return number(entry.get("sizeBytes"), 0, BackupModel.MAX_FILE);
  }

  private static Long modified(Map<String, Object> entry) throws Exception {
    return TransferSchema.nullable(
      entry.get("modifiedAt"),
      -BackupModel.MAX_DATE,
      BackupModel.MAX_DATE
    );
  }

  /** 把电脑报告的失败转成本机任务的错误，文件访问类的错误注明在电脑上；电脑没报错时为 task-conflict。 */
  private static ArchiveFailure remoteFailure(Job job, String message) throws Exception {
    if (job.remote != null && job.remote.get("error") != null) {
      ArchiveFailure remote = new ArchiveFailure(
        string(map(job.remote.get("error")).get("code")),
        message
      );
      if (DEVICE_ERRORS.contains(remote.code)) {
        remote.device = "pc";
      }
      return remote;
    }
    return fail("task-conflict");
  }

  private void upload(Job job) throws Exception {
    // 电脑登记后核对容量，通过后进入 awaiting-content。
    while (isRemoteRunning(job) && remoteStage(job).equals("preparing")) {
      job.control.check();
      Thread.sleep(100);
      refresh(job, job.control);
    }
    synchronized (this) {
      // 电脑通过核对后立即开始备份，备份期间就可以上传。
      if (
        !isRemoteRunning(job) ||
        !java.util.Arrays.asList("backing-up", "awaiting-content").contains(remoteStage(job))
      ) {
        throw remoteFailure(job, "The PC could not accept this content.");
      }
    }
    List<Map<String, Object>> entries = contentEntries(job.plan);
    List<ArchiveModel.Source> sources = local.sources(job.plan);
    require(sources.size() == entries.size());
    List<ArchiveAdapter.Outgoing> files = new ArrayList<>();
    for (int i = 0; i < entries.size(); i++) {
      Map<String, Object> entry = entries.get(i);
      files.add(
        new ArchiveAdapter.Outgoing(
          sources.get(i),
          string(entry.get("entryId")),
          size(entry),
          modified(entry)
        )
      );
    }
    long total = number(job.plan.value.get("totalFileBytes"), 0, BackupModel.MAX_TOTAL);
    transport.verifySync(job.preparation.connection, job.preparation.binding);
    progress(job, "transferring", null, 0);
    AtomicReference<ArchiveFailure> reading = new AtomicReference<>();
    try {
      accept(
        job,
        job.preparation.connection.http.uploadStream(
          job.path() + "/content",
          job.preparation.connection.session,
          output -> {
            try {
              archives.sendFiles(files, output, job.control, (stage, value, ignored) ->
                progress(job, "transferring", "transferredBytes", value)
              );
            } catch (ArchiveFailure failure) {
              if (!failure.code.equals("network-failure") && !failure.code.equals("timeout")) {
                reading.set(failure);
              }
              throw failure;
            }
          },
          job.control
        )
      );
    } catch (Exception lost) {
      // 读取本机来源失败或取消时按本机错误结束；网络中断时以电脑的实际状态为准。
      if (reading.get() != null) {
        throw reading.get();
      }
      job.control.check();
      refresh(job, job.control);
    }
    synchronized (this) {
      // 电脑的备份或核对先失败时会中止接收，内容没收齐，本机按电脑报告的错误结束。
      if (
        job.remote != null &&
        !isRemoteRunning(job) &&
        number(map(job.remote.get("progress")).get("transferredBytes"), 0, total) < total
      ) {
        throw remoteFailure(job, "The PC stopped receiving this content.");
      }
      require(
        job.remote != null &&
          number(map(job.remote.get("progress")).get("transferredBytes"), 0, total) == total &&
          !java.util.Arrays.asList("preparing", "awaiting-content", "transferring").contains(
            job.remote.get("stage")
          )
      );
      map(job.state.get("progress")).put("transferredBytes", total);
      job.isUploadComplete = true;
      terminal(job, "sent", null, null);
    }
  }

  /** 等电脑核对完来源；查询失败且无法恢复时抛出原错误。 */
  private void awaitRemotePrepared(Job job) throws Exception {
    while (isRemoteRunning(job) && remoteStage(job).equals("preparing")) {
      job.control.check();
      Thread.sleep(100);
      try {
        refresh(job, job.control);
      } catch (Exception cause) {
        job.control.check();
        recover(job);
        synchronized (this) {
          if (job.remoteError != null) {
            throw cause;
          }
        }
      }
    }
  }

  /** 备份完成前是备份阶段，之后按内容的进展是等待内容、传输或写入。 */
  private static String contentStage(Job job) {
    if (!job.isBackupDone) {
      return "backing-up";
    }
    if (job.isContentReceived) {
      return "writing";
    }
    return job.isContentClaimed ? "transferring" : "awaiting-content";
  }

  private static Map<String, Object> awaitWriter(Future<Map<String, Object>> writing)
    throws Exception {
    try {
      return writing.get();
    } catch (ExecutionException failed) {
      Throwable cause = failed.getCause();
      throw cause instanceof Exception ? (Exception) cause : failed;
    }
  }

  /**
   * 边下载边解包到私有缓存，同时由写入器开始备份；内容只能认领一次，全部解包完整后写入器才写入。
   *
   * <p>内容先失败时停下写入器，按内容的错误结束；写入器先结束时停下下载，按写入器的结果结束。
   */
  private void download(Job job) throws Exception {
    long count = number(job.plan.value.get("transferFileCount"), 0, 1024);
    if (count == 0) {
      awaitRemotePrepared(job);
      require(job.remote != null && job.remote.get("status").equals("sent"));
      job.isPreparingArchive = true;
      Map<String, Object> result = local.apply(job.plan, null, job.control, execution(job));
      synchronized (this) {
        receiverResult(job, result);
      }
      return;
    }
    List<Long> sizes = new ArrayList<>();
    for (Map<String, Object> entry : contentEntries(job.plan)) {
      sizes.add(size(entry));
    }
    long total = number(job.plan.value.get("totalFileBytes"), 0, BackupModel.MAX_TOTAL);
    verifyTargetContext(job.plan.project, job.plan.target.root);
    long extra = local.checkReceiveSpace(
      job.plan,
      archives.privateRoot(),
      total,
      job.control,
      execution(job)
    );
    archives.checkStagingSpace(total, extra);
    job.control.check();
    SyncWriter.Material material = material(job);
    Future<Map<String, Object>> writing = writers.submit(() -> {
      try {
        return local.apply(job.plan, material, job.control, execution(job));
      } finally {
        boolean shouldStop;
        synchronized (job) {
          shouldStop = !job.content.isDone();
          job.hasWriterStopped = shouldStop;
        }
        if (shouldStop) {
          job.control.cancel();
        }
      }
    });
    try {
      awaitRemotePrepared(job);
      synchronized (this) {
        if (!isRemoteRunning(job) || !remoteStage(job).equals("ready")) {
          throw remoteFailure(job, "The PC could not prepare this content.");
        }
      }
      java.io.InputStream input = job.preparation.connection.http.downloadStream(
        job.path() + "/content",
        job.preparation.connection.session,
        job.control
      );
      job.isContentClaimed = true;
      progress(job, contentStage(job), null, 0);
      job.staged = archives.receiveFiles(sizes, input, job.control, (stage, value, ignored) ->
        progress(job, contentStage(job), "transferredBytes", value)
      );
      // 内容已完整解包，本机照常写入。这里只刷新一次电脑的状态，查询失败时把电脑的结果记为待确认。
      recover(job);
    } catch (Exception cause) {
      boolean hasWriterStopped;
      synchronized (job) {
        hasWriterStopped = job.hasWriterStopped;
        job.content.completeExceptionally(cause);
      }
      if (!hasWriterStopped) {
        job.control.cancel();
      }
      Map<String, Object> result = null;
      try {
        result = awaitWriter(writing);
      } catch (Exception writerFailure) {
        if (hasWriterStopped) {
          throw writerFailure;
        }
        // 写入器是被下载的失败停下的，任务按下载的原因结束。
      }
      // 写入器只是被取消或超时停下时没有自己的错误，按下载的原因结束，保留取消和超时的判断。
      if (!hasWriterStopped || result == null || result.get("error") == null) {
        throw cause;
      }
      synchronized (this) {
        receiverResult(job, result);
      }
      return;
    }
    job.isContentReceived = true;
    job.isPreparingArchive = true;
    progress(job, contentStage(job), null, 0);
    job.content.complete(null);
    Map<String, Object> result = awaitWriter(writing);
    synchronized (this) {
      receiverResult(job, result);
    }
  }

  private SyncWriter.Material material(Job job) throws Exception {
    List<Map<String, Object>> entries = contentEntries(job.plan);
    return new SyncWriter.Material() {
      @Override
      public Map<String, Object> snapshot() throws Exception {
        return map(copy(job.plan.source.value));
      }

      @Override
      public boolean ready(ArchiveControl control) throws Exception {
        job.isBackupDone = true;
        progress(job, contentStage(job), null, 0);
        while (true) {
          control.check();
          try {
            job.content.get(100, TimeUnit.MILLISECONDS);
            return true;
          } catch (TimeoutException waiting) {
            // 内容还在下载，继续等，期间响应取消。
          } catch (ExecutionException failed) {
            Throwable cause = failed.getCause();
            throw cause instanceof Exception ? (Exception) cause : failed;
          }
        }
      }

      @Override
      public ArchiveModel.Source file(String entryId) throws Exception {
        for (int i = 0; i < entries.size(); i++) {
          Map<String, Object> entry = entries.get(i);
          if (entry.get("entryId").equals(entryId)) {
            String fileId = ArchiveModel.id(i);
            List<String> path = BackupModel.path(entry.get("path"));
            ArchiveModel.Observation observation = new ArchiveModel.Observation(
              job.plan.id + ":" + fileId,
              entryId,
              job.plan.source.parent(path),
              path.get(path.size() - 1),
              size(entry),
              modified(entry)
            );
            return new ArchiveModel.Source() {
              @Override
              public void validateRoot(String rootId) throws ArchiveFailure {
                require(rootId.equals(job.plan.source.root));
              }

              @Override
              public ArchiveModel.Observation observe(ArchiveControl control) throws Exception {
                control.check();
                return observation;
              }

              @Override
              public java.io.InputStream open(ArchiveControl control) throws Exception {
                control.check();
                return job.staged.openFile(fileId);
              }
            };
          }
        }
        throw fail("invalid-request");
      }
    };
  }

  private SyncWriter.Execution execution(Job job) {
    return new SyncWriter.Execution(
      job,
      job.acceptedAt,
      new SyncWriter.Observer() {
        @Override
        public void stage(String stage) throws Exception {
          progress(job, stage.equals("writing") ? stage : contentStage(job), null, 0);
        }

        @Override
        public void backup(long bytesCopied) throws Exception {
          synchronized (SyncTransferEngine.this) {
            if (!job.state.get("status").equals("running")) {
              return;
            }
            map(job.state.get("progress")).put("backupBytesCopied", bytesCopied);
            job.state.put("updatedAt", System.currentTimeMillis());
          }
        }

        @Override
        public void outcome(Map<String, Object> result) throws Exception {
          if (!result.get("status").equals("succeeded") || !SyncPlanModel.isFileWrite(result)) {
            return;
          }
          synchronized (SyncTransferEngine.this) {
            Map<String, Object> counters = map(job.state.get("progress"));
            counters.put("publishedFiles", number(counters.get("publishedFiles"), 0, 1024) + 1);
            counters.put(
              "fileBytesPublished",
              number(counters.get("fileBytesPublished"), 0, BackupModel.MAX_TOTAL) +
                number(result.get("sizeBytes"), 0, BackupModel.MAX_FILE)
            );
            job.state.put("updatedAt", System.currentTimeMillis());
          }
        }
      }
    );
  }

  /** 核对当前会话、目标项目和根目录以及本机备份设置与已确认的任务一致。 */
  synchronized void verifyTargetContext(String project, String root) throws Exception {
    Job job = active;
    if (
      job == null ||
      !job.isRunning ||
      job.preparation.upload() ||
      !job.plan.project.equals(project) ||
      !job.plan.target.root.equals(root) ||
      !TargetOperation.owns(job)
    ) {
      throw fail("permission-denied");
    }
    transport.verifySync(job.preparation.connection, job.preparation.binding);
    if (local.backup(project) != job.plan.shouldBackup) {
      throw new ArchiveFailure(
        "source-changed",
        "Mobile device backup settings changed. Confirm again."
      );
    }
  }

  private void receiverFailed(Job job, ArchiveFailure cause) {
    try {
      boolean isCancelled =
        !job.hasTimedOut &&
        (cause.isCancelled || Boolean.TRUE.equals(job.state.get("cancelRequested")));
      String code = job.hasTimedOut
        ? "timeout"
        : cause.code.equals("result-unknown")
          ? "io-failure"
          : cause.code;
      Object failure = isCancelled
        ? null
        : error(code, job.hasTimedOut ? null : failedDevice(cause));
      List<Object> outcomes = new ArrayList<>();
      for (int i = 0; i < job.plan.writes.size(); i++) {
        Map<String, Object> operation = job.plan.writes.get(i);
        outcomes.add(
          object(
            "path",
            operation.get("path"),
            "action",
            operation.get("action"),
            "status",
            i == 0 ? (isCancelled ? "cancelled" : "failed") : "not-attempted",
            "sizeBytes",
            null,
            "error",
            i == 0 ? failure : null
          )
        );
      }
      receiverResult(
        job,
        object(
          "schemaVersion",
          1,
          "planId",
          job.plan.id,
          "backupId",
          null,
          "backupFileCount",
          null,
          "outcomes",
          outcomes,
          "error",
          failure,
          "cleanupError",
          cause.cleanupFailure == null ? null : error("cleanup-failed")
        )
      );
      if (isCancelled) {
        job.state.put("cancelRequested", true);
        job.state.put("status", "cancelled");
      }
    } catch (Exception invalid) {
      throw new IllegalStateException(
        "The native failure result does not match the confirmed plan.",
        invalid
      );
    }
  }

  private void receiverResult(Job job, Map<String, Object> result) throws Exception {
    long[] actual = SyncJobModel.result(result, job.plan);
    boolean isComplete = true;
    boolean isCancelled = false;
    for (Object item : list(result.get("outcomes"))) {
      String status = string(map(item).get("status"));
      isComplete &= status.equals("succeeded");
      isCancelled |= status.equals("cancelled");
    }
    Map<String, Object> counters = map(job.state.get("progress"));
    counters.put("publishedFiles", actual[0]);
    counters.put("fileBytesPublished", actual[1]);
    Object failure = result.get("error");
    String status =
      failure != null && map(failure).get("code").equals("result-unknown")
        ? "unknown"
        : isComplete && failure == null
          ? "succeeded"
          : isCancelled
            ? "cancelled"
            : "failed";
    job.state.put("result", result);
    job.state.put("error", failure);
    job.state.put("cleanupError", result.get("cleanupError"));
    job.state.put("failureStage", status.equals("succeeded") ? null : stoppedAt(job));
    job.state.put("status", status);
    job.state.put("stage", "done");
    job.state.put("updatedAt", System.currentTimeMillis());
    if (isCancelled) {
      job.state.put("cancelRequested", true);
    }
  }

  private synchronized boolean isRemoteRunning(Job job) {
    return job.remote != null && job.remote.get("status").equals("running");
  }

  private synchronized String remoteStage(Job job) {
    return job.remote == null ? "preparing" : (String) job.remote.get("stage");
  }

  private void awaitRemote(Job job) throws Exception {
    while (isRemoteRunning(job)) {
      job.control.check();
      Thread.sleep(100);
      try {
        refresh(job, job.control);
      } catch (Exception cause) {
        job.control.check();
        recover(job);
        synchronized (this) {
          if (job.remoteError != null) {
            throw cause;
          }
        }
        // 已重新读到运行状态时继续等同一任务，保持通知和名额，不提前结束。
      }
    }
  }

  private void refresh(Job job, ArchiveControl control) throws Exception {
    transport.verifySync(job.preparation.connection, job.preparation.binding);
    Object raw = job.preparation.connection.http.json(
      "GET",
      job.path(),
      job.preparation.connection.session,
      null,
      200,
      control
    );
    accept(job, raw);
  }

  private synchronized void accept(Job job, Object raw) throws Exception {
    Map<String, Object> state = SyncJobModel.state(raw, job.plan);
    if (job.remote != null) {
      if (!job.remote.get("status").equals("running")) {
        require(state.get("status").equals(job.remote.get("status")));
        if (job.remote.get("result") != null) {
          Map<String, Object> previousResult = new LinkedHashMap<>(map(job.remote.get("result")));
          Map<String, Object> nextResult = new LinkedHashMap<>(map(state.get("result")));
          previousResult.remove("cleanupError");
          nextResult.remove("cleanupError");
          require(SyncPlanModel.same(previousResult, nextResult));
        } else {
          require(state.get("result") == null);
        }
      }
      Map<String, Object> previous = map(job.remote.get("progress"));
      Map<String, Object> next = map(state.get("progress"));
      for (String key : new String[] {
        "transferredBytes",
        "fileBytesPublished",
        "publishedFiles",
        "backupBytesCopied",
      }) {
        require(number(next.get(key), 0, 1140850688) >= number(previous.get(key), 0, 1140850688));
      }
    }
    job.remote = state;
    job.remoteError = null;
  }

  private static ArchiveControl shortControl() {
    return new ArchiveControl(System::nanoTime, TimeUnit.SECONDS.toNanos(5));
  }

  private void recover(Job job) {
    synchronized (job) {
      ArchiveControl control = shortControl();
      try {
        refresh(job, control);
      } catch (Exception cause) {
        synchronized (this) {
          job.remoteError = error("result-unknown");
        }
      } finally {
        control.cancel();
      }
    }
  }

  private void cancelRemote(Job job) {
    synchronized (job) {
      ArchiveControl control = shortControl();
      boolean shouldCancel;
      synchronized (this) {
        shouldCancel =
          !job.wasCancelSent && (job.remote == null || job.remote.get("status").equals("running"));
      }
      try {
        if (shouldCancel) {
          try {
            accept(
              job,
              job.preparation.connection.http.json(
                "DELETE",
                job.path(),
                job.preparation.connection.session,
                null,
                202,
                control
              )
            );
            synchronized (this) {
              job.wasCancelSent = true;
            }
          } catch (Exception lost) {
            /* 这里只查询实际结果；电脑没有回应时不记为已发，用户再点取消时重发。 */
          }
        }
        refresh(job, control);
        while (isRemoteRunning(job)) {
          control.check();
          Thread.sleep(100);
          refresh(job, control);
        }
      } catch (Exception cause) {
        synchronized (this) {
          job.remoteError = error("result-unknown");
        }
      } finally {
        control.cancel();
      }
    }
  }

  /** 返回任务停下时的阶段；要在清理和结束改写阶段之前调用。 */
  private static Object stoppedAt(Job job) {
    Object stage = job.state.get("stage");
    return stage.equals("cleaning") || stage.equals("done") ? null : stage;
  }

  private synchronized void terminal(Job job, String requested, String code, String device) {
    // 结果待确认不算失败，两端的校验都要求这两种状态分开。
    String status =
      requested.equals("failed") && "result-unknown".equals(code) ? "unknown" : requested;
    job.state.put("failureStage", status.equals("sent") ? null : stoppedAt(job));
    job.state.put("status", status);
    job.state.put("stage", "done");
    job.state.put("error", code == null ? null : error(code, device));
    if (status.equals("cancelled")) {
      job.state.put("cancelRequested", true);
    }
    job.state.put("updatedAt", System.currentTimeMillis());
  }

  private boolean cleanup(Job job) {
    try {
      if (!local.retryCleanup()) {
        throw fail("cleanup-failed");
      }
      if (job.staged != null) {
        job.staged.close();
        job.staged = null;
      }
      archives.retryCleanup();
      job.state.put("cleanupError", null);
      if (job.state.get("result") != null) {
        map(job.state.get("result")).put("cleanupError", null);
      }
      return true;
    } catch (Exception cause) {
      job.state.put("cleanupError", error("cleanup-failed"));
      if (job.state.get("result") != null) {
        mapUnchecked(job.state.get("result")).put("cleanupError", error("cleanup-failed"));
      }
      return false;
    }
  }

  private Job job(String id) throws Exception {
    available();
    id(id);
    purge();
    Job job = jobs.get(id);
    if (job == null) {
      throw fail("not-found");
    }
    return job;
  }

  private Map<String, Object> transfer(Job job) throws Exception {
    return map(
      copy(
        object(
          "schemaVersion",
          1,
          "jobId",
          job.plan.id,
          "local",
          job.state,
          "remote",
          job.remote,
          "remoteError",
          job.remoteError
        )
      )
    );
  }

  Map<String, Object> query(String id, boolean shouldRefresh) throws Exception {
    Job job;
    synchronized (this) {
      job = job(id);
    }
    if (shouldRefresh && !job.isRunning && job.wasRemoteAttempted) {
      recover(job);
    }
    synchronized (this) {
      return transfer(job);
    }
  }

  synchronized Object current() throws Exception {
    available();
    purge();
    Job last = active;
    if (last == null) {
      for (Job job : jobs.values()) {
        last = job;
      }
    }
    return last == null ? null : last.plan.id;
  }

  /** 返回这个游戏（移动端 projectId）最近一次任务的 ID；没有时返回 null。 */
  synchronized Object latest(String projectId) throws Exception {
    available();
    id(projectId);
    purge();
    Job last = null;
    // jobs 有容量上限，遍历是有界的。
    for (Job job : jobs.values()) {
      if (projectId.equals(job.preparation.binding.get("projectId"))) {
        last = job;
      }
    }
    return last == null ? null : last.plan.id;
  }

  Map<String, Object> cancel(String id, boolean isTimeout) throws Exception {
    Job job;
    synchronized (this) {
      job = job(id);
      if (isTimeout) {
        job.hasTimedOut = true;
      }
      job.state.put("cancelRequested", !isTimeout);
    }
    job.control.cancel();
    if (!job.isRunning && job.wasRemoteAttempted) {
      worker.execute(() -> cancelRemote(job));
    }
    synchronized (this) {
      return transfer(job);
    }
  }

  synchronized void retryCleanup() throws Exception {
    if (active == null) {
      return;
    }
    if (active.isRunning) {
      throw fail("busy");
    }
    if (!cleanup(active)) {
      throw fail("cleanup-failed");
    }
    release(active);
  }

  private void release(Job job) {
    TargetOperation.release(job);
    job.hasLease = false;
    if (active == job) {
      active = null;
    }
  }

  /** 释放结束的任务或准备；还在进行的准备先取消，线程收尾后自行退出。 */
  void release(String id) throws Exception {
    Preparation running;
    synchronized (this) {
      available();
      id(id);
      Job job = jobs.get(id);
      Preparation preparation = preparations.get(id);
      if (job != null && (job.isRunning || job.hasLease)) {
        throw fail("busy");
      }
      if (job == null && preparation == null) {
        throw fail("not-found");
      }
      jobs.remove(id);
      preparations.remove(id);
      running = preparation == preparing ? preparation : null;
      if (running != null) {
        running.wasCancelRequested = true;
      }
    }
    if (running != null) {
      running.control.cancel();
    }
  }

  synchronized boolean busy() {
    return active != null;
  }

  synchronized String activeId() {
    return active == null ? null : active.plan.id;
  }

  /** 返回通知用的阶段和进度快照；没有活动任务时返回 null。 */
  synchronized Map<String, Object> notice() {
    if (active == null) {
      return null;
    }
    String stage = (String) active.state.get("stage");
    Map<String, Object> progress = mapUnchecked(active.state.get("progress"));
    if (active.preparation.upload() && active.isRunning && active.isUploadComplete) {
      stage =
        active.remote != null && active.remote.get("status").equals("running")
          ? (String) active.remote.get("stage")
          : "sent";
      if (active.remote != null) {
        progress = mapUnchecked(active.remote.get("progress"));
      }
    }
    return object(
      "transferId",
      active.plan.id,
      "upload",
      active.preparation.upload(),
      "running",
      active.isRunning,
      "stage",
      stage,
      "progress",
      new LinkedHashMap<>(progress)
    );
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> mapUnchecked(Object value) {
    return (Map<String, Object>) value;
  }

  /** 关闭引擎：取消进行中的准备和任务，等线程退出后清理并关闭本机写入器。 */
  @Override
  public void close() throws Exception {
    synchronized (this) {
      isClosed = true;
      if (preparing != null) {
        preparing.control.cancel();
      }
      if (active != null) {
        active.control.cancel();
      }
      if (heartbeatControl != null) {
        heartbeatControl.cancel();
      }
    }
    transport.controlInterceptor(null);
    watcher.shutdownNow();
    heartbeats.shutdownNow();
    reports.shutdownNow();
    preparer.shutdown();
    worker.shutdown();
    writers.shutdown();
    if (
      !preparer.awaitTermination(30, TimeUnit.SECONDS) ||
      !worker.awaitTermination(30, TimeUnit.SECONDS) ||
      !writers.awaitTermination(30, TimeUnit.SECONDS) ||
      !heartbeats.awaitTermination(10, TimeUnit.SECONDS)
    ) {
      throw fail("timeout");
    }
    synchronized (this) {
      if (active != null && !cleanup(active)) {
        throw fail("cleanup-failed");
      }
      if (active != null) {
        release(active);
      }
      preparations.clear();
      jobs.clear();
    }
    local.close();
  }
}
