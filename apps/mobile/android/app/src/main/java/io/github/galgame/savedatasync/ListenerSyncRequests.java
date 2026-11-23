package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.copy;
import static io.github.galgame.savedatasync.TransferJson.map;
import static io.github.galgame.savedatasync.TransferJson.object;
import static io.github.galgame.savedatasync.TransferSchema.id;
import static io.github.galgame.savedatasync.TransferSchema.number;
import static io.github.galgame.savedatasync.TransferSchema.one;
import static io.github.galgame.savedatasync.TransferSchema.require;
import static io.github.galgame.savedatasync.TransferSchema.shape;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * 本机作为监听方时，经控制通道请拨号方开始的复制请求；同一时间只保留一个请求，只存在内存中。
 *
 * <p>拨号方扫描后回报计划，本机确认后由拨号方执行并在本机登记任务。状态由本对象的锁保护；持锁时不等控制通道的应答。
 */
final class ListenerSyncRequests {

  /** 本机的状态。 */
  interface Host {
    String deviceId();

    /** 是否已有复制任务或待清理的资源；有时拒绝新的发起和确认。 */
    boolean isBusy();

    /** 拨号方是否已在本机登记了这个任务。 */
    boolean hasJob(String jobId);
  }

  private static final class Entry {

    final String requestId = UUID.randomUUID().toString();
    final String projectId;
    final String peerId;
    final String direction;
    final String remoteProjectId;
    final String localRootId;
    final String remoteRootId;
    /** 请求状态：waiting、preparing、ready、starting、running、succeeded、failed 或 cancelled。 */
    String status = "waiting";
    Map<String, Object> error;
    /** 拨号方回报的计划，确认后换成确认的计划；ready 之前为 null。 */
    Map<String, Object> plan;
    /** 确认的计划；确认之前为 null。 */
    SyncPlanModel.Plan confirmed;
    long updatedAt = System.currentTimeMillis();
    /** 已确认，但拨号方还没在本机登记任务。 */
    boolean isAwaitingJob;
    /** 拨号方最新的任务摘要。 */
    Map<String, Object> digest;

    Entry(
      String projectId,
      String peerId,
      String direction,
      String remoteProjectId,
      String localRootId,
      String remoteRootId
    ) {
      this.projectId = projectId;
      this.peerId = peerId;
      this.direction = direction;
      this.remoteProjectId = remoteProjectId;
      this.localRootId = localRootId;
      this.remoteRootId = remoteRootId;
    }

    boolean isUpload() {
      return direction.equals("dialer-to-listener");
    }

    boolean isActive() {
      return (
        status.equals("waiting") ||
        status.equals("preparing") ||
        status.equals("ready") ||
        status.equals("starting")
      );
    }

    String planId() {
      return plan == null ? null : (String) plan.get("planId");
    }

    void update(String value, Map<String, Object> problem) {
      status = value;
      error = problem;
      updatedAt = System.currentTimeMillis();
    }
  }

  private final ListenerLibrary library;
  private final ListenerControl control;
  private final Host host;
  private Entry current;

  ListenerSyncRequests(ListenerLibrary library, ListenerControl control, Host host) {
    this.library = library;
    this.control = control;
    this.host = host;
  }

  private static Map<String, Object> problem(String code, String message, boolean canRetry) {
    return object("code", code, "message", message, "canRetry", canRetry);
  }

  /**
   * 请连着本机的设备扫描，立即返回准备状态，格式同共享 SyncPreparationState；preparationId 是请求 ID。没确认的旧请求被取代。
   *
   * @throws ArchiveFailure 已有任务时为 busy，设备没连着本机时为 network-failure，项目没选目录或没有关联这台设备时为
   *     invalid-request，关联或目录变了时为 session-mismatch。
   */
  Map<String, Object> start(String projectId, String peerId, String direction) throws Exception {
    one(direction, "dialer-to-listener", "listener-to-dialer");
    if (host.isBusy()) {
      throw new ArchiveFailure(
        "busy",
        "A transfer is still running. Wait for it to finish before starting another."
      );
    }
    if (!control.isOpen(peerId)) {
      throw new ArchiveFailure(
        "network-failure",
        "The device is not connected. Connect it to this device again."
      );
    }
    String[] link = library.link(projectId, peerId);
    if (link == null) {
      throw new ArchiveFailure(
        "invalid-request",
        "Select directories on both devices and link the game first."
      );
    }
    library.verifyProject(projectId, peerId, link[0], link[1], link[2]);
    Entry entry = new Entry(projectId, peerId, direction, link[0], link[1], link[2]);
    Entry previous;
    synchronized (this) {
      if (current != null && current.status.equals("starting")) {
        throw new ArchiveFailure(
          "busy",
          "The previous plan is confirmed. Waiting for the other device to start transferring."
        );
      }
      previous = current != null && current.isActive() ? current : null;
      if (previous != null) {
        previous.update("cancelled", null);
      }
      current = entry;
    }
    if (previous != null) {
      control.request(previous.peerId, "sync.cancel", object("requestId", previous.requestId));
    }
    control
      .request(
        peerId,
        "sync.prepare",
        object("requestId", entry.requestId, "projectId", link[0], "direction", direction)
      )
      .whenComplete((value, error) -> {
        if (error == null) {
          return;
        }
        ArchiveFailure failure = ArchiveFailure.from(
          error instanceof Exception ? (Exception) error : new Exception(error)
        );
        synchronized (this) {
          if (current == entry && entry.isActive()) {
            entry.update("failed", problem(failure.code, failure.getMessage(), false));
          }
        }
      });
    return state(entry.requestId);
  }

  private Entry entry(String requestId) throws ArchiveFailure {
    if (current == null || !current.requestId.equals(requestId)) {
      throw new ArchiveFailure("not-found", "The initiation request ended. Scan again.");
    }
    return current;
  }

  /** 是否是当前请求的请求 ID 或计划 ID。 */
  synchronized boolean has(String id) {
    return current != null && (current.requestId.equals(id) || id.equals(current.planId()));
  }

  /** 返回请求的准备状态，格式同共享 SyncPreparationState；请求不是当前请求时抛出 not-found。 */
  synchronized Map<String, Object> state(String requestId) throws Exception {
    Entry entry = entry(requestId);
    String status;
    switch (entry.status) {
      case "waiting":
      case "preparing":
        status = "preparing";
        break;
      case "failed":
      case "cancelled":
        // 确认后才失败或取消的请求，准备本身已经完成。
        status = entry.confirmed == null ? entry.status : "ready";
        break;
      default:
        status = "ready";
    }
    return map(
      copy(
        object(
          "schemaVersion",
          1,
          "preparationId",
          entry.requestId,
          "direction",
          entry.direction,
          "status",
          status,
          "error",
          status.equals("failed") ? entry.error : null
        )
      )
    );
  }

  /**
   * 返回拨号方回报的计划的预览，格式同共享 SyncPreparationPreview，本机一侧是监听方，preparationId 是计划 ID。
   *
   * @param id 请求 ID 或计划 ID。
   * @throws ArchiveFailure 不是当前请求时为 not-found，计划还没回报时为 task-conflict。
   */
  synchronized Map<String, Object> preview(String id) throws Exception {
    if (!has(id)) {
      throw new ArchiveFailure("not-found", "The initiation request ended. Scan again.");
    }
    Entry entry = current;
    if (entry.plan == null) {
      throw new ArchiveFailure("task-conflict", "The other device has not returned a plan yet.");
    }
    return map(
      copy(
        object(
          "schemaVersion",
          1,
          "preparationId",
          entry.planId(),
          "direction",
          entry.direction,
          "localSide",
          "listener",
          "binding",
          object(
            "projectId",
            entry.projectId,
            "remoteProjectId",
            entry.remoteProjectId,
            "localDeviceId",
            host.deviceId(),
            "remoteDeviceId",
            entry.peerId,
            "localRootId",
            entry.localRootId,
            "remoteRootId",
            entry.remoteRootId
          ),
          "source",
          entry.plan.get("source"),
          "target",
          entry.plan.get("target"),
          "shouldBackup",
          entry.plan.get("shouldBackup"),
          "shouldDeleteExtras",
          entry.plan.get("shouldDeleteExtras")
        )
      )
    );
  }

  /**
   * 取消还没确认的请求，并通知拨号方释放扫描；返回取消后的准备状态。
   *
   * @throws ArchiveFailure 不是当前请求时为 not-found，已经确认时为 task-conflict。
   */
  Map<String, Object> cancel(String requestId) throws Exception {
    Entry entry;
    boolean shouldNotify;
    synchronized (this) {
      entry = entry(requestId);
      if (entry.confirmed != null) {
        throw new ArchiveFailure(
          "task-conflict",
          "The transfer has already started. Cancel it from the task details."
        );
      }
      shouldNotify = entry.isActive();
      if (shouldNotify) {
        entry.update("cancelled", null);
      }
    }
    if (shouldNotify) {
      control.request(entry.peerId, "sync.cancel", object("requestId", requestId));
    }
    return state(requestId);
  }

  /**
   * 释放请求：没确认的请求先取消；已确认的请求只在任务登记后或已结束时释放。
   *
   * @throws ArchiveFailure 不是当前请求时为 not-found，任务还在等登记时为 busy。
   */
  void release(String id) throws Exception {
    boolean shouldCancel;
    String requestId;
    synchronized (this) {
      if (!has(id)) {
        throw new ArchiveFailure("not-found", "The initiation request ended. Scan again.");
      }
      requestId = current.requestId;
      if (current.confirmed != null && current.isAwaitingJob && current.isActive()) {
        throw new ArchiveFailure("busy", "The other device is starting this transfer.");
      }
      shouldCancel = current.confirmed == null && current.isActive();
    }
    if (shouldCancel) {
      cancel(requestId);
    }
    synchronized (this) {
      if (current != null && current.requestId.equals(requestId)) {
        current = null;
      }
    }
  }

  /** 应用拨号方的回报；不属于当前请求或当前状态的回报，以及格式不对的回报，直接忽略或记为失败。 */
  void report(String peerId, Object raw) {
    synchronized (this) {
      Entry entry = current;
      Map<String, Object> body;
      try {
        body = map(raw);
        if (
          entry == null ||
          !entry.peerId.equals(peerId) ||
          !entry.requestId.equals(body.get("requestId"))
        ) {
          return;
        }
      } catch (ArchiveFailure invalid) {
        return;
      }
      String status = entry.status;
      boolean isWaiting = status.equals("waiting") || status.equals("preparing");
      Object reported = body.get("status");
      try {
        if ("preparing".equals(reported) && status.equals("waiting")) {
          shape(body, "requestId", "status");
          entry.update("preparing", null);
        } else if ("ready".equals(reported) && isWaiting) {
          shape(body, "requestId", "status", "plan");
          Map<String, Object> plan = map(copy(body.get("plan")));
          if (!matchesPlan(entry, plan)) {
            entry.update(
              "failed",
              problem(
                "invalid-request",
                "The plan returned by the other device does not match the project. Scan again.",
                false
              )
            );
            return;
          }
          entry.plan = plan;
          entry.update("ready", null);
        } else if ("failed".equals(reported) && entry.isActive()) {
          shape(body, "requestId", "status", "error");
          entry.update("failed", TransferSchema.error(body.get("error")));
        }
      } catch (Exception invalid) {
        if (entry.isActive()) {
          entry.update(
            "failed",
            problem(
              "invalid-request",
              "The other device returned an invalid report. Scan again.",
              false
            )
          );
        }
      }
    }
  }

  /** 方向、目标一侧的项目及两端快照的设备和目录都要与登记时一致；计划可以不可执行，界面据此说明原因。 */
  private boolean matchesPlan(Entry entry, Map<String, Object> plan) throws Exception {
    id(plan.get("planId"));
    number(plan.get("schemaVersion"), 1, 1);
    require(
      plan.get("shouldBackup") instanceof Boolean &&
        plan.get("shouldDeleteExtras") instanceof Boolean
    );
    SyncPlanModel.Snapshot source = new SyncPlanModel.Snapshot(plan.get("source"));
    SyncPlanModel.Snapshot target = new SyncPlanModel.Snapshot(plan.get("target"));
    SyncPlanModel.Snapshot local = entry.isUpload() ? target : source;
    SyncPlanModel.Snapshot remote = entry.isUpload() ? source : target;
    // 计划的项目 ID 取目标一侧：拨号方发送时是本机的项目。
    return (
      "copy".equals(plan.get("operation")) &&
      entry.direction.equals(plan.get("direction")) &&
      (entry.isUpload() ? entry.projectId : entry.remoteProjectId).equals(plan.get("projectId")) &&
      local.device.equals(host.deviceId()) &&
      local.root.equals(entry.localRootId) &&
      remote.device.equals(entry.peerId) &&
      remote.root.equals(entry.remoteRootId)
    );
  }

  /**
   * 确认拨号方回报的计划，在调用线程上等拨号方应答，最多 {@link ListenerControl#REQUEST_TIMEOUT_MS}；拨号方应答后视为已开始。
   *
   * @param rawPlan 由这次预览按是否备份、是否删除多余文件生成的计划，两份快照必须与回报的一致。
   * @return 任务 ID，即计划 ID；拨号方还没登记任务时用 {@link #pending} 读占位状态。
   * @throws ArchiveFailure 不是当前请求、或拨号方已不能用这份计划时为 not-found；计划不对时为 invalid-request；
   *     已有任务时为 busy；拨号方拒绝时为它的错误。
   */
  String confirm(String requestId, Object rawPlan) throws Exception {
    Entry entry;
    SyncPlanModel.Plan plan;
    synchronized (this) {
      entry = entry(requestId);
      if (!entry.status.equals("ready")) {
        throw new ArchiveFailure("not-found", "This plan cannot be executed. Scan again.");
      }
      try {
        plan = new SyncPlanModel.Plan(rawPlan);
        require(
          plan.id.equals(entry.planId()) &&
            plan.reason.equals("copy") &&
            plan.value.get("direction").equals(entry.direction) &&
            plan.project.equals(entry.plan.get("projectId")) &&
            SyncPlanModel.same(plan.source.value, entry.plan.get("source")) &&
            SyncPlanModel.same(plan.target.value, entry.plan.get("target"))
        );
      } catch (Exception invalid) {
        throw new ArchiveFailure("invalid-request", "This plan does not match the comparison.");
      }
    }
    if (host.isBusy()) {
      throw new ArchiveFailure(
        "busy",
        "A transfer is still running. Wait for it to finish before confirming."
      );
    }
    library.verifyProject(
      entry.projectId,
      entry.peerId,
      entry.remoteProjectId,
      entry.localRootId,
      entry.remoteRootId
    );
    synchronized (this) {
      if (current != entry || !entry.status.equals("ready")) {
        throw new ArchiveFailure("not-found", "This plan cannot be executed. Scan again.");
      }
      entry.plan = plan.value;
      entry.confirmed = plan;
      entry.isAwaitingJob = true;
      entry.update("starting", null);
    }
    Object reply;
    try {
      reply = control
        .request(
          entry.peerId,
          "sync.confirm",
          object(
            "requestId",
            requestId,
            "shouldBackup",
            plan.shouldBackup,
            "shouldDeleteExtras",
            plan.shouldDeleteExtras
          )
        )
        .get(ListenerControl.REQUEST_TIMEOUT_MS + 2000, TimeUnit.MILLISECONDS);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      throw ArchiveFailure.from(interrupted);
    } catch (ExecutionException | TimeoutException failed) {
      Throwable cause = failed instanceof ExecutionException ? failed.getCause() : failed;
      ArchiveFailure failure =
        cause instanceof ArchiveFailure
          ? (ArchiveFailure) cause
          : new ArchiveFailure("timeout", "The other device did not answer.", false, failed);
      // 拨号方拒绝时已释放这次扫描，计划不能再用；超时或断开时任务可能已开始，以摘要为准。
      boolean isRejected =
        !failure.code.equals("timeout") && !failure.code.equals("network-failure");
      synchronized (this) {
        if (current == entry && entry.status.equals("starting")) {
          if (isRejected) {
            entry.isAwaitingJob = false;
          }
          entry.update("failed", problem(failure.code, failure.getMessage(), false));
        }
      }
      if (
        isRejected && (failure.code.equals("invalid-request") || failure.code.equals("not-found"))
      ) {
        throw new ArchiveFailure("not-found", "This plan cannot be executed. Scan again.");
      }
      throw failure;
    }
    synchronized (this) {
      boolean isMatched;
      try {
        isMatched = plan.id.equals(id(shape(reply, "jobId").get("jobId")));
      } catch (ArchiveFailure invalid) {
        isMatched = false;
      }
      if (current == entry && entry.status.equals("starting")) {
        if (isMatched) {
          entry.update("running", null);
        } else {
          entry.update(
            "failed",
            problem(
              "invalid-request",
              "The task started by the other device does not match this plan. " +
                "Check the task details.",
              false
            )
          );
        }
      }
    }
    return plan.id;
  }

  /** 应用拨号方的任务摘要：已确认的请求状态跟随它，因断开或超时记成失败的请求回到进行中。 */
  synchronized void observe(String peerId, Object raw) {
    Entry entry = current;
    if (
      entry == null ||
      !entry.peerId.equals(peerId) ||
      entry.confirmed == null ||
      !(
        entry.status.equals("starting") ||
        entry.status.equals("running") ||
        entry.status.equals("failed")
      )
    ) {
      return;
    }
    Map<String, Object> digest;
    try {
      digest = map(copy(raw));
      if (!entry.confirmed.id.equals(digest.get("jobId"))) {
        return;
      }
      one(digest.get("status"), "running", "sent", "succeeded", "failed", "cancelled", "unknown");
    } catch (Exception invalid) {
      return;
    }
    entry.digest = digest;
    Object status = digest.get("status");
    Object error = digest.get("error");
    if (status.equals("running")) {
      entry.update("running", null);
    } else if (status.equals("cancelled")) {
      entry.update("cancelled", null);
    } else if (error instanceof Map) {
      entry.update("failed", mapUnchecked(error));
    } else {
      entry.update("succeeded", null);
    }
  }

  /** 处理控制通道断开：没确认的请求记为失败，已开始的请求记为结果待确认。 */
  synchronized void closed(String peerId) {
    Entry entry = current;
    if (entry == null || !entry.peerId.equals(peerId)) {
      return;
    }
    if (entry.isActive()) {
      entry.update(
        "failed",
        problem(
          "network-failure",
          "The other device disconnected or the app closed. Reconnect and retry.",
          true
        )
      );
    } else if (entry.status.equals("running")) {
      entry.update(
        "failed",
        problem(
          "result-unknown",
          "The connection to the other device was lost. The transfer result is unconfirmed.",
          false
        )
      );
    }
  }

  /** 判断 jobId 是否是本机已确认、等对方登记的任务。 */
  synchronized boolean isAwaiting(String jobId) {
    return (
      current != null &&
      current.isAwaitingJob &&
      current.confirmed != null &&
      current.confirmed.id.equals(jobId)
    );
  }

  /**
   * 已确认但拨号方还没在本机登记的任务的状态，格式同共享 SyncTransferState；拨号方登记后、或不是这个任务时返回 null。
   * 本机角色是占位的：等待中是准备阶段，结束后沿用拨号方报告的结论。
   */
  synchronized Map<String, Object> pending(String jobId) throws Exception {
    Entry entry = current;
    if (
      entry == null ||
      !entry.isAwaitingJob ||
      entry.confirmed == null ||
      !entry.confirmed.id.equals(jobId)
    ) {
      return null;
    }
    if (host.hasJob(jobId)) {
      entry.isAwaitingJob = false;
      return null;
    }
    SyncPlanModel.Plan plan = entry.confirmed;
    boolean isReceiver = entry.isUpload();
    Map<String, Object> local = object(
      "schemaVersion",
      SyncJobModel.JOB_SCHEMA_VERSION,
      "jobId",
      jobId,
      "direction",
      entry.direction,
      "role",
      isReceiver ? "receiver" : "sender",
      "status",
      "running",
      "stage",
      "preparing",
      "updatedAt",
      entry.updatedAt,
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
        plan.value.get("totalFileBytes"),
        "totalFiles",
        plan.value.get("transferFileCount"),
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
    String status = entry.status;
    if (status.equals("failed") || status.equals("cancelled")) {
      boolean wasCancelled = status.equals("cancelled");
      Map<String, Object> reason = wasCancelled ? null : entry.error;
      Object failureStage = entry.digest == null ? null : entry.digest.get("failureStage");
      local.put(
        "status",
        wasCancelled
          ? "cancelled"
          : reason != null && "result-unknown".equals(reason.get("code"))
            ? "unknown"
            : "failed"
      );
      local.put("stage", "done");
      local.put("isCancelRequested", wasCancelled);
      local.put("failureStage", failureStage);
      local.put("error", reason);
      local.put(
        "result",
        isReceiver ? ListenerSyncJobs.emptyResult(plan, reason, wasCancelled) : null
      );
    }
    Map<String, Object> digest = entry.digest;
    // 接收端的终态必须带逐项结果；拨号方还没开始就结束，没有结果可读，结论看本机角色。
    Map<String, Object> remote = null;
    if (
      digest != null &&
      (digest.get("role").equals("sender") || digest.get("status").equals("running"))
    ) {
      remote = map(copy(digest));
      remote.put("result", null);
    }
    return map(
      copy(
        object(
          "schemaVersion",
          1,
          "jobId",
          jobId,
          "local",
          local,
          "remote",
          remote,
          "remoteError",
          null
        )
      )
    );
  }

  /** 已确认的请求的本机项目 ID；不是当前请求的任务时为 null。 */
  synchronized String projectId(String jobId) {
    return current != null && current.confirmed != null && current.confirmed.id.equals(jobId)
      ? current.projectId
      : null;
  }

  /**
   * 请拨号方取消正在开始的任务，在调用线程上最多等 {@link ListenerControl#REQUEST_TIMEOUT_MS}。
   *
   * @throws ArchiveFailure 不是当前请求的任务时为 not-found，通知失败时为通知的错误。
   */
  void cancelPending(String jobId) throws Exception {
    String peerId;
    synchronized (this) {
      if (current == null || current.confirmed == null || !current.confirmed.id.equals(jobId)) {
        throw new ArchiveFailure("not-found", "This sync task ended or expired.");
      }
      peerId = current.peerId;
    }
    try {
      control
        .request(peerId, "sync.job.cancel", object("jobId", jobId))
        .get(ListenerControl.REQUEST_TIMEOUT_MS + 2000, TimeUnit.MILLISECONDS);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      throw ArchiveFailure.from(interrupted);
    } catch (ExecutionException failed) {
      Throwable cause = failed.getCause();
      throw cause instanceof ArchiveFailure ? (ArchiveFailure) cause : ArchiveFailure.from(failed);
    } catch (TimeoutException failed) {
      throw new ArchiveFailure("timeout", "The other device did not answer.", false, failed);
    }
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> mapUnchecked(Object value) {
    return (Map<String, Object>) value;
  }
}
