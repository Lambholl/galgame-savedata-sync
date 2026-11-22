package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.copy;
import static io.github.galgame.savedatasync.TransferJson.list;
import static io.github.galgame.savedatasync.TransferJson.map;
import static io.github.galgame.savedatasync.TransferJson.object;
import static io.github.galgame.savedatasync.TransferSchema.id;
import static io.github.galgame.savedatasync.TransferSchema.nullable;
import static io.github.galgame.savedatasync.TransferSchema.number;
import static io.github.galgame.savedatasync.TransferSchema.string;

import android.content.Context;
import android.os.CancellationSignal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** 进程内共享的本机恢复预览和任务，Activity 重建后可按 ID 查询。 */
final class SyncWriteRuntime implements AutoCloseable {

  private final Map<String, String> projects = new LinkedHashMap<>();
  private final Map<String, Job> jobs = new LinkedHashMap<>();
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private final java.util.concurrent.ScheduledExecutorService expiry =
    Executors.newSingleThreadScheduledExecutor();
  private final DirectoryStore store;
  final SyncWriter writer;
  private Job active;
  private boolean isClosed;

  private static final class Job {

    final String id = UUID.randomUUID().toString();
    final String project;
    final String root;
    final String backup;
    ArchiveControl control = new ArchiveControl();
    SyncWriter.Restore restore;
    String status = "preparing";
    String stage = "preparing";
    String failureStage;
    String lastStage = "preparing";
    long updatedAt = System.currentTimeMillis();
    long backupBytesCopied;
    long totalBackupBytes;
    int publishedFiles;
    int totalFiles;
    long fileBytesPublished;
    Long totalFileBytes;
    Object preview;
    Object result;
    Object error;
    long touched = System.nanoTime();
    boolean isRunning = true;

    Job(String project, String root, String backup) {
      this.project = project;
      this.root = root;
      this.backup = backup;
    }

    Map<String, Object> state() throws Exception {
      return map(
        copy(
          object(
            "restoreId",
            id,
            "projectId",
            project,
            "rootId",
            root,
            "backupId",
            backup,
            "status",
            status,
            "stage",
            stage,
            "failureStage",
            failureStage,
            "updatedAt",
            updatedAt,
            "progress",
            object(
              "backupBytesCopied",
              backupBytesCopied,
              "totalBackupBytes",
              totalBackupBytes,
              "publishedFiles",
              publishedFiles,
              "totalFiles",
              totalFiles,
              "fileBytesPublished",
              fileBytesPublished,
              "totalFileBytes",
              totalFileBytes
            ),
            "result",
            result,
            "error",
            error
          )
        )
      );
    }
  }

  SyncWriteRuntime(Context context, DirectoryStore store, BackupStore backups) {
    this.store = store;
    writer = new SyncWriter(
      new DirectorySyncBackend(context, store, (project, root) -> {
        synchronized (SyncWriteRuntime.this) {
          if (!root.equals(projects.get(project))) {
            throw new ArchiveFailure(
              "permission-denied",
              "The target directory does not match this local project binding."
            );
          }
        }
      }),
      backups
    );
    expiry.scheduleAtFixedRate(
      () ->
        worker.execute(() -> {
          synchronized (SyncWriteRuntime.this) {
            purge();
          }
        }),
      1,
      1,
      TimeUnit.MINUTES
    );
  }

  /**
   * 绑定本机项目和已授权的根目录。
   *
   * @throws Exception 有任务在进行（busy），根目录没有授权，或绑定数量超过上限。
   */
  synchronized void bindProject(String project, String root) throws Exception {
    available();
    id(project);
    id(root);
    if (active != null || TargetOperation.hasWork()) {
      throw new ArchiveFailure(
        "busy",
        "Project bindings cannot be changed while a task is active."
      );
    }
    store.publicationDirectory(root, null, new CancellationSignal(), false);
    if (!projects.containsKey(project) && projects.size() >= 128) {
      throw new ArchiveFailure(
        "resource-limit",
        "The number of local project bindings exceeds the limit."
      );
    }
    projects.put(project, root);
  }

  private synchronized Job find(String restoreId) throws Exception {
    available();
    id(restoreId);
    purge();
    Job job = jobs.get(restoreId);
    if (job == null) {
      throw new ArchiveFailure("not-found", "The restore task does not exist or expired.");
    }
    return job;
  }

  private void purge() {
    long now = System.nanoTime();
    for (Job job : new ArrayList<>(jobs.values())) {
      if (!job.isRunning && now - job.touched >= TimeUnit.MINUTES.toNanos(10)) {
        // 未释放资源的结果必须继续可发现，供页面显式重试清理。
        if (job.result instanceof Map && ((Map<?, ?>) job.result).get("cleanupError") != null) {
          continue;
        }
        if (job.restore != null) {
          try {
            job.restore.close();
          } catch (Exception cleanup) {
            continue;
          }
        }
        jobs.remove(job.id);
      }
    }
  }

  synchronized Map<String, Object> prepare(String project, String root, String backup)
    throws Exception {
    available();
    id(project);
    id(root);
    id(backup);
    purge();
    if (!root.equals(projects.get(project))) {
      throw new ArchiveFailure(
        "permission-denied",
        "Verify the saved local project and directory binding first."
      );
    }
    if (active != null || jobs.size() >= 32) {
      throw new ArchiveFailure(
        "busy",
        "A restore task already exists or the result limit has been reached."
      );
    }
    Job job = new Job(project, root, backup);
    jobs.put(job.id, job);
    active = job;
    worker.execute(() -> {
      try {
        SyncWriter.Restore restore = writer.prepareRestore(project, root, backup, job.control);
        synchronized (this) {
          job.restore = restore;
          job.control.check();
          job.preview = restore.preview();
          job.status = "ready";
          job.stage = "ready";
          job.updatedAt = System.currentTimeMillis();
          settled(job);
        }
      } catch (Exception failure) {
        failed(job, failure);
      }
    });
    return job.state();
  }

  synchronized Map<String, Object> query(String restoreId) throws Exception {
    return find(restoreId).state();
  }

  /** 返回当前进程中最近的恢复 ID；全部过期后返回 null。 */
  synchronized String current() throws Exception {
    available();
    purge();
    if (active != null) {
      return active.id;
    }
    String latest = null;
    for (Job job : jobs.values()) {
      latest = job.id;
    }
    return latest;
  }

  synchronized Map<String, Object> preview(String restoreId) throws Exception {
    Job job = find(restoreId);
    if (job.preview == null) {
      throw new ArchiveFailure("task-conflict", "The restore preview is not ready yet.");
    }
    Map<String, Object> result = map(copy(job.preview));
    result.put("restoreId", job.id);
    return result;
  }

  synchronized Map<String, Object> execute(String restoreId, Object raw) throws Exception {
    Job job = find(restoreId);
    if (!job.status.equals("ready") || job.restore == null || active != null) {
      throw new ArchiveFailure(
        "task-conflict",
        "The restore preview was used or is not ready yet."
      );
    }
    SyncPlanModel.Plan plan = new SyncPlanModel.Plan(raw);
    if (
      !plan.id.equals(job.restore.planId) ||
      !plan.project.equals(job.project) ||
      !plan.reason.equals("restore") ||
      !SyncPlanModel.same(plan.source.value, job.restore.source) ||
      !SyncPlanModel.same(plan.target.value, job.restore.target)
    ) {
      throw new ArchiveFailure(
        "invalid-request",
        "The confirmed plan differs from this restore preview."
      );
    }
    final long totalFiles = number(plan.value.get("transferFileCount"), 0, 1024);
    final Long totalFileBytes = nullable(
      plan.value.get("totalFileBytes"),
      0,
      BackupModel.MAX_TOTAL
    );
    final Long backupBytes = nullable(plan.value.get("backupFileBytes"), 0, BackupModel.MAX_TOTAL);
    job.control = new ArchiveControl();
    job.status = "running";
    job.stage = "verifying";
    job.failureStage = null;
    job.lastStage = "preparing";
    job.backupBytesCopied = 0;
    job.totalBackupBytes = backupBytes == null ? 0 : backupBytes;
    job.publishedFiles = 0;
    job.totalFiles = (int) totalFiles;
    job.fileBytesPublished = 0;
    job.totalFileBytes = totalFileBytes;
    job.updatedAt = System.currentTimeMillis();
    job.isRunning = true;
    active = job;
    SyncWriter.Observer observer = new SyncWriter.Observer() {
      @Override
      public void stage(String stage) {
        synchronized (SyncWriteRuntime.this) {
          if (stage.equals("checking")) {
            job.stage = "verifying";
            job.lastStage = "preparing";
          } else {
            job.stage = stage;
            if (stage.equals("backing-up") || stage.equals("writing")) {
              job.lastStage = stage;
            }
          }
          job.updatedAt = System.currentTimeMillis();
        }
      }

      @Override
      public void backup(long bytesCopied) {
        synchronized (SyncWriteRuntime.this) {
          job.backupBytesCopied = Math.min(Math.max(0, bytesCopied), job.totalBackupBytes);
          job.updatedAt = System.currentTimeMillis();
        }
      }

      @Override
      public void outcome(Map<String, Object> item) throws Exception {
        if (!"succeeded".equals(item.get("status")) || !SyncPlanModel.isFileWrite(item)) {
          return;
        }
        Long bytes = nullable(item.get("sizeBytes"), 0, BackupModel.MAX_FILE);
        synchronized (SyncWriteRuntime.this) {
          job.publishedFiles = Math.min(job.publishedFiles + 1, job.totalFiles);
          if (bytes != null) {
            long limit = job.totalFileBytes == null ? BackupModel.MAX_TOTAL : job.totalFileBytes;
            job.fileBytesPublished = Math.min(job.fileBytesPublished + bytes, limit);
          }
          job.updatedAt = System.currentTimeMillis();
        }
      }
    };
    worker.execute(() -> {
      try {
        Map<String, Object> result = job.restore.apply(plan.value, job.control, observer);
        synchronized (this) {
          job.result = result;
          job.restore = null;
          Object resultError = result.get("error");
          boolean isUnknown =
            resultError instanceof Map && "result-unknown".equals(map(resultError).get("code"));
          boolean isComplete = resultError == null;
          boolean isCancelled = false;
          int published = 0;
          long publishedBytes = 0;
          for (Object item : list(result.get("outcomes"))) {
            Map<String, Object> entry = map(item);
            String status = string(entry.get("status"));
            isComplete &= status.equals("succeeded");
            isCancelled |= status.equals("cancelled");
            if (status.equals("succeeded") && SyncPlanModel.isFileWrite(entry)) {
              published++;
              Long bytes = nullable(entry.get("sizeBytes"), 0, BackupModel.MAX_FILE);
              if (bytes != null) {
                publishedBytes += bytes;
              }
            }
          }
          String nextStatus = isUnknown
            ? "unknown"
            : isComplete
              ? "succeeded"
              : isCancelled
                ? "cancelled"
                : "failed";
          job.status = nextStatus;
          job.stage = "done";
          job.failureStage =
            nextStatus.equals("failed") || nextStatus.equals("unknown") ? job.lastStage : null;
          job.error = resultError;
          job.publishedFiles = published;
          job.fileBytesPublished = publishedBytes;
          if (isComplete || result.get("backupId") != null) {
            job.backupBytesCopied = job.totalBackupBytes;
          }
          job.updatedAt = System.currentTimeMillis();
          settled(job);
        }
      } catch (Exception failure) {
        failed(job, failure);
      }
    });
    return job.state();
  }

  private synchronized void failed(Job job, Exception cause) {
    ArchiveFailure failure = ArchiveFailure.from(cause);
    if (job.restore != null) {
      try {
        job.restore.close();
        job.restore = null;
      } catch (Exception cleanup) {
        if (failure.isCancelled) {
          failure = new ArchiveFailure(
            "cleanup-failed",
            "Restore material was not fully released after cancellation.",
            false,
            cleanup
          );
        }
      }
    }
    job.status = failure.isCancelled ? "cancelled" : "failed";
    job.stage = "done";
    job.failureStage = failure.isCancelled ? null : job.lastStage;
    job.error = failure.isCancelled
      ? null
      : object("code", failure.code, "message", failure.getMessage(), "canRetry", false);
    job.updatedAt = System.currentTimeMillis();
    settled(job);
  }

  /** 状态和活动名额在同一锁内提交，读到 ready 或结束状态后就可以执行或释放。 */
  private void settled(Job job) {
    job.isRunning = false;
    job.touched = System.nanoTime();
    if (active == job) {
      active = null;
    }
  }

  Map<String, Object> cancel(String restoreId) throws Exception {
    Job job;
    synchronized (this) {
      job = find(restoreId);
    }
    job.control.cancel();
    synchronized (this) {
      if (job.status.equals("ready")) {
        job.restore.close();
        job.restore = null;
        job.preview = null;
        job.status = "cancelled";
        job.stage = "done";
        job.failureStage = null;
        job.updatedAt = System.currentTimeMillis();
        job.touched = System.nanoTime();
      }
      return job.state();
    }
  }

  synchronized void release(String restoreId) throws Exception {
    Job job = find(restoreId);
    if (job.isRunning) {
      throw new ArchiveFailure("busy", "The restore is still running.");
    }
    if (job.restore != null) {
      job.restore.close();
      job.restore = null;
    }
    if (!writer.retryCleanup()) {
      throw new ArchiveFailure("cleanup-failed", "Target resources have not been fully released.");
    }
    jobs.remove(job.id);
  }

  synchronized boolean retryCleanup() {
    if (active != null || !writer.retryCleanup()) {
      return false;
    }
    for (Job job : jobs.values()) {
      if (job.restore != null && !job.status.equals("ready")) {
        try {
          job.restore.close();
          job.restore = null;
        } catch (Exception cleanup) {
          return false;
        }
      }
      if (job.result != null) {
        try {
          map(job.result).put("cleanupError", null);
        } catch (Exception invalid) {
          return false;
        }
      }
    }
    return true;
  }

  private void available() throws ArchiveFailure {
    if (isClosed) {
      throw new ArchiveFailure("unsupported-operation", "The restore task owner is closed.");
    }
  }

  /** 关闭恢复运行时：取消活动任务，等工作线程退出后关闭写入器。 */
  @Override
  public void close() throws Exception {
    Job job;
    synchronized (this) {
      isClosed = true;
      job = active;
    }
    expiry.shutdownNow();
    if (job != null) {
      job.control.cancel();
    }
    worker.shutdown();
    if (!worker.awaitTermination(30, TimeUnit.SECONDS)) {
      throw new ArchiveFailure("timeout", "The restore task has not been released.");
    }
    writer.close();
    synchronized (this) {
      jobs.clear();
      projects.clear();
    }
  }
}
