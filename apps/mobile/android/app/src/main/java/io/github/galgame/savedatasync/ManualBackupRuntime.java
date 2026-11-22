package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.copy;
import static io.github.galgame.savedatasync.TransferJson.list;
import static io.github.galgame.savedatasync.TransferJson.map;
import static io.github.galgame.savedatasync.TransferJson.object;
import static io.github.galgame.savedatasync.TransferSchema.id;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * 进程内共享的本机手动备份运行时，由单个工作线程执行扫描和备份提交。
 * 开始时占用 TargetOperation 名额，结束后按 RETENTION_MILLIS 保留终态供查询。
 */
final class ManualBackupRuntime implements AutoCloseable {

  private static final long TIMEOUT_MILLIS = 1800000L;
  private static final long RETENTION_MILLIS = 600000L;
  private static final int MAX_RETAINED = 32;

  private final SyncScanner scanner;
  private final BackupStore backups;
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private final Map<String, Job> jobs = new LinkedHashMap<>();
  private Job active;
  private boolean isClosed;

  private static final class Job {

    final String id = UUID.randomUUID().toString();
    final Object token = new Object();
    final String projectId;
    final String rootId;
    final ArchiveControl control = new ArchiveControl(
      System::nanoTime,
      TimeUnit.MILLISECONDS.toNanos(TIMEOUT_MILLIS)
    );
    String status = "running";
    String stage = "scanning";
    long updatedAt = System.currentTimeMillis();
    boolean isCancelRequested;
    long bytesCopied;
    long totalBytes;
    String backupId;
    Integer fileCount;
    Object error;
    Object cleanupError;
    long settledAt;

    Job(String projectId, String rootId) {
      this.projectId = projectId;
      this.rootId = rootId;
    }

    Map<String, Object> snapshot() throws Exception {
      return map(
        copy(
          object(
            "schemaVersion",
            1,
            "taskId",
            id,
            "projectId",
            projectId,
            "rootId",
            rootId,
            "status",
            status,
            "stage",
            stage,
            "updatedAt",
            updatedAt,
            "isCancelRequested",
            isCancelRequested,
            "bytesCopied",
            bytesCopied,
            "totalBytes",
            totalBytes,
            "backupId",
            backupId,
            "fileCount",
            fileCount,
            "error",
            error,
            "cleanupError",
            cleanupError
          )
        )
      );
    }
  }

  ManualBackupRuntime(SyncScanner scanner, BackupStore backups) {
    this.scanner = scanner;
    this.backups = backups;
  }

  /**
   * 立即启动一次本机手动备份；标识无效时抛出 invalid-request，名额被占用或运行时已关闭时抛出 busy。
   *
   * @return 初始运行状态，后续进度通过 state 查询。
   */
  synchronized Map<String, Object> start(String projectId, String rootId) throws Exception {
    id(projectId);
    id(rootId);
    if (isClosed) {
      throw BackupFiles.failure("busy");
    }
    purge();
    Job job = new Job(projectId, rootId);
    if (!TargetOperation.acquire(job.token)) {
      throw new ArchiveFailure(
        "busy",
        "Wait for the current transfer, restore, or backup to finish."
      );
    }
    if (jobs.size() >= MAX_RETAINED) {
      evictOldest();
    }
    jobs.put(job.id, job);
    active = job;
    try {
      worker.execute(() -> run(job));
    } catch (java.util.concurrent.RejectedExecutionException cause) {
      jobs.remove(job.id);
      active = null;
      TargetOperation.release(job.token);
      throw BackupFiles.failure("busy");
    }
    return job.snapshot();
  }

  /** 返回当前正在运行的手动备份状态；没有运行中的任务时返回 null。 */
  synchronized Map<String, Object> current() throws Exception {
    purge();
    return active == null ? null : active.snapshot();
  }

  /** 按 taskId 返回手动备份状态；taskId 无效时抛出 invalid-request，任务不存在或已过期时抛出 not-found。 */
  synchronized Map<String, Object> state(String taskId) throws Exception {
    purge();
    return find(taskId).snapshot();
  }

  /** 请求取消指定的手动备份；已结束的任务原样返回终态，taskId 无效时抛出 invalid-request，不存在时抛出 not-found。 */
  Map<String, Object> cancel(String taskId) throws Exception {
    Job job;
    boolean shouldCancel;
    synchronized (this) {
      purge();
      job = find(taskId);
      shouldCancel = "running".equals(job.status);
      if (shouldCancel) {
        job.isCancelRequested = true;
        job.updatedAt = System.currentTimeMillis();
      }
    }
    if (shouldCancel) {
      job.control.cancel();
    }
    synchronized (this) {
      return job.snapshot();
    }
  }

  /** 停止接纳新任务，取消正在运行的手动备份并等待工作线程结束。 */
  @Override
  public void close() {
    Job current;
    synchronized (this) {
      isClosed = true;
      current = active;
      if (current != null) {
        current.isCancelRequested = true;
        current.updatedAt = System.currentTimeMillis();
      }
    }
    if (current != null) {
      current.control.cancel();
    }
    worker.shutdown();
    try {
      worker.awaitTermination(30, TimeUnit.SECONDS);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
    }
  }

  private Job find(String taskId) throws Exception {
    id(taskId);
    Job job = jobs.get(taskId);
    if (job == null) {
      throw BackupFiles.failure("not-found");
    }
    return job;
  }

  private void purge() {
    long now = System.nanoTime();
    jobs
      .values()
      .removeIf(
        job ->
          job != active &&
          job.settledAt != 0 &&
          now - job.settledAt >= TimeUnit.MILLISECONDS.toNanos(RETENTION_MILLIS)
      );
  }

  private void evictOldest() {
    for (Map.Entry<String, Job> entry : jobs.entrySet()) {
      if (entry.getValue() != active) {
        jobs.remove(entry.getKey());
        return;
      }
    }
  }

  private void run(Job job) {
    try {
      job.control.check();
      Map<String, Object> snapshot = scanner.snapshotNow(job.rootId, job.control);
      job.control.check();
      List<Object> files = new ArrayList<>();
      long total = 0;
      for (Object raw : list(snapshot.get("entries"))) {
        Map<String, Object> entry = map(raw);
        if (!"file".equals(entry.get("kind"))) {
          continue;
        }
        Object sizeValue = entry.get("sizeBytes");
        if (!(sizeValue instanceof Number)) {
          throw new ArchiveFailure(
            "invalid-request",
            "A file to be backed up has an unknown size."
          );
        }
        long size = ((Number) sizeValue).longValue();
        if (size < 0 || size > BackupModel.MAX_FILE) {
          throw new ArchiveFailure(
            "resource-limit",
            "A file to be backed up exceeds the size limit."
          );
        }
        total += size;
        files.add(entry);
      }
      if (files.isEmpty()) {
        synchronized (this) {
          job.status = "empty";
          job.stage = "done";
          job.bytesCopied = 0;
          job.totalBytes = 0;
          job.backupId = null;
          job.fileCount = null;
          job.error = null;
          job.cleanupError = null;
          job.updatedAt = System.currentTimeMillis();
        }
        return;
      }
      if (files.size() > 1024 || total > BackupModel.MAX_TOTAL) {
        throw new ArchiveFailure(
          "resource-limit",
          "The backup exceeds file count or total size limits."
        );
      }
      final long totalBytes = total;
      synchronized (this) {
        job.stage = "backing-up";
        job.bytesCopied = 0;
        job.totalBytes = totalBytes;
        job.updatedAt = System.currentTimeMillis();
      }
      Map<String, Object> commit = backups.create(
        job.projectId,
        job.rootId,
        "manual",
        true,
        files,
        job.control,
        copied -> {
          synchronized (ManualBackupRuntime.this) {
            if ("running".equals(job.status)) {
              job.bytesCopied = Math.min(copied, totalBytes);
              job.updatedAt = System.currentTimeMillis();
            }
          }
        }
      );
      Object manifestValue = commit.get("manifest");
      if (manifestValue == null) {
        synchronized (this) {
          job.status = "empty";
          job.stage = "done";
          job.bytesCopied = 0;
          job.totalBytes = 0;
          job.backupId = null;
          job.fileCount = null;
          job.error = null;
          job.cleanupError = null;
          job.updatedAt = System.currentTimeMillis();
        }
        return;
      }
      Map<String, Object> manifest = map(manifestValue);
      synchronized (this) {
        job.status = "succeeded";
        job.stage = "done";
        job.bytesCopied = totalBytes;
        job.totalBytes = totalBytes;
        job.backupId = id(manifest.get("backupId"));
        job.fileCount = list(manifest.get("files")).size();
        job.error = null;
        job.cleanupError = commit.get("cleanupError");
        job.updatedAt = System.currentTimeMillis();
      }
    } catch (Exception cause) {
      ArchiveFailure failure = ArchiveFailure.from(cause);
      Object cleanup =
        failure.cleanupFailure == null ? null : BackupStore.error(failure.cleanupFailure);
      synchronized (this) {
        job.stage = "done";
        job.backupId = null;
        job.fileCount = null;
        job.cleanupError = cleanup;
        boolean isCancelled =
          failure.isCancelled || (job.isCancelRequested && !"timeout".equals(failure.code));
        if (isCancelled) {
          job.status = "cancelled";
          job.isCancelRequested = true;
          job.error = null;
        } else {
          job.status = "failed";
          job.error = BackupStore.error(failure);
        }
        job.updatedAt = System.currentTimeMillis();
      }
    } finally {
      synchronized (this) {
        job.settledAt = System.nanoTime();
        if (active == job) {
          active = null;
        }
      }
      TargetOperation.release(job.token);
    }
  }
}
