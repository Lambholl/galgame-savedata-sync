package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.bytes;
import static io.github.galgame.savedatasync.TransferJson.copy;
import static io.github.galgame.savedatasync.TransferJson.list;
import static io.github.galgame.savedatasync.TransferJson.map;
import static io.github.galgame.savedatasync.TransferJson.object;
import static io.github.galgame.savedatasync.TransferSchema.error;
import static io.github.galgame.savedatasync.TransferSchema.id;
import static io.github.galgame.savedatasync.TransferSchema.nullable;
import static io.github.galgame.savedatasync.TransferSchema.number;
import static io.github.galgame.savedatasync.TransferSchema.one;
import static io.github.galgame.savedatasync.TransferSchema.outcome;
import static io.github.galgame.savedatasync.TransferSchema.parent;
import static io.github.galgame.savedatasync.TransferSchema.require;
import static io.github.galgame.savedatasync.TransferSchema.string;
import static io.github.galgame.savedatasync.TransferSchema.target;

import java.io.Closeable;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 执行已确认的计划，只由 I/O 工作线程调用；文件内容和句柄不跨桥。
 * 全部输入和目标复核、备份完成后逐项写入，第一个失败后停止；清理没完成时继续占进程名额。
 */
final class SyncWriter implements AutoCloseable {

  interface Material {
    Map<String, Object> snapshot() throws Exception;

    ArchiveModel.Source file(String entryId) throws Exception;
  }

  interface Replacement extends Closeable {
    InputStream read(ArchiveControl control) throws Exception;

    OutputStream output(ArchiveControl control) throws Exception;

    void finish(long size, ArchiveControl control) throws Exception;

    void verify(ArchiveControl control) throws Exception;

    /** 判断私有目录是否与目标同卷；未知时为 null。识别同卷后，目标候选文件和备份峰值相加。 */
    Boolean sharesVolume(Path privateDirectory) throws Exception;
  }

  interface Backend {
    SyncScanner.Source source();

    NewFilePublisher publisher();

    void authorizeProject(String projectId, String rootId, ArchiveControl control) throws Exception;

    default void authorize(SyncPlanModel.Plan plan, ArchiveControl control) throws Exception {
      authorizeProject(plan.project, plan.target.root, control);
    }

    Long available(String rootId, String parentId, ArchiveControl control) throws Exception;

    String createDirectory(String rootId, String parentId, String name, ArchiveControl control)
      throws Exception;

    /**
     * 删除快照里的一个条目；文件夹只删空的。身份或属性已变时抛 source-changed 且不删除；
     * 已发出删除但结果没能确认时抛 result-unknown。
     */
    void delete(
      String rootId,
      String parentId,
      Map<String, Object> expected,
      ArchiveControl control
    ) throws Exception;

    Replacement replacement(
      String rootId,
      String parentId,
      Map<String, Object> expected,
      ArchiveControl control
    ) throws Exception;

    /** 打开可选的只读卷识别句柄；null 表示提供者不能识别卷，调用者按未知处理。 */
    default Replacement volumeFile(
      String rootId,
      String parentId,
      Map<String, Object> expected,
      ArchiveControl control
    ) throws Exception {
      return replacement(rootId, parentId, expected, control);
    }

    default Boolean sharesPrivateVolume(Path left, Path right) throws Exception {
      return null;
    }

    /** 开始写目标前留下写入标记；抛出时不写目标。 */
    default void writeStarted(SyncPlanModel.Plan plan, Object backupId) throws Exception {}

    /** 写入走到结束后删除标记，不得抛出。 */
    default void writeEnded(SyncPlanModel.Plan plan) {}
  }

  interface Observer {
    default void stage(String stage) throws Exception {}

    default void outcome(Map<String, Object> result) throws Exception {}
  }

  /** 编排器传入的执行上下文：借用确认时取得的名额和时间，实际目录每次重新核实。 */
  static final class Execution {

    final Object token;
    final long acceptedAt;
    final Observer observer;

    Execution(Object token, long acceptedAt, Observer observer) {
      this.token = token;
      this.acceptedAt = acceptedAt;
      this.observer = observer;
    }
  }

  private static final class Job {

    final SyncPlanModel.Plan plan;
    final ArchiveControl control;
    final Object token;
    final boolean ownToken;
    final Observer observer;
    final Set<Closeable> resources = new HashSet<>();
    final Map<String, String> directories = new LinkedHashMap<>();
    volatile boolean hasTimedOut;
    boolean isRunning = true;
    Object cleanupError;

    Job(SyncPlanModel.Plan plan, ArchiveControl control, Execution execution) {
      this.plan = plan;
      this.control = control;
      ownToken = execution == null;
      token = ownToken ? new Object() : execution.token;
      observer = execution == null ? null : execution.observer;
    }
  }

  private final Backend backend;
  private final BackupStore backups;
  private final SyncScanner scanner;
  private final Set<String> used = new HashSet<>();
  private final Set<Restore> restores = new HashSet<>();
  private final ScheduledExecutorService watcher = Executors.newSingleThreadScheduledExecutor();
  private volatile Job active;
  private volatile boolean isClosed;
  private volatile ArchiveControl preparing;
  private volatile boolean hasPreparationTimedOut;
  private int restoring;

  SyncWriter(Backend backend, BackupStore backups) {
    this.backend = Objects.requireNonNull(backend);
    this.backups = Objects.requireNonNull(backups);
    scanner = new SyncScanner(backend.source());
    watcher.scheduleAtFixedRate(
      () -> {
        Job job = active;
        if (job == null || !job.isRunning) {
          ArchiveControl preview = preparing;
          if (preview == null) {
            return;
          }
          try {
            preview.check();
          } catch (ArchiveFailure stopped) {
            if (stopped.code.equals("timeout")) {
              hasPreparationTimedOut = true;
            }
            preview.cancel();
          }
          return;
        }
        try {
          job.control.check();
        } catch (ArchiveFailure stopped) {
          if (stopped.code.equals("timeout")) {
            job.hasTimedOut = true;
          }
          job.control.cancel();
        }
      },
      25,
      25,
      TimeUnit.MILLISECONDS
    );
  }

  private void check(Job job) throws Exception {
    if (job.hasTimedOut) {
      throw new ArchiveFailure("timeout", "The current write operation timed out.");
    }
    job.control.check();
    if (!TargetOperation.owns(job.token)) {
      throw new ArchiveFailure("task-conflict", "This write operation slot was released.");
    }
    backend.authorize(job.plan, job.control);
    job.control.check();
  }

  private static Map<String, Object> error(String code, String message) {
    return object("code", code, "message", message, "canRetry", false);
  }

  private static Map<String, Object> outcome(
    Map<String, Object> operation,
    String status,
    Object error,
    Map<String, Object> source
  ) {
    boolean isFile = status.equals("succeeded") && SyncPlanModel.isFileWrite(operation);
    return object(
      "path",
      operation.get("path"),
      "action",
      operation.get("action"),
      "status",
      status,
      "sizeBytes",
      isFile ? source.get("sizeBytes") : null,
      "sha256",
      isFile ? source.get("sha256") : null,
      "error",
      error
    );
  }

  private static Map<String, Object> cleanupError() {
    return error(
      "cleanup-failed",
      "File or restore material was not fully released. Retry cleanup."
    );
  }

  private <T extends Closeable> T track(Job job, T value) throws Exception {
    job.resources.add(value);
    return job.control.track(value);
  }

  private static void digest(
    InputStream input,
    Map<String, Object> expected,
    ArchiveControl control,
    java.util.function.BooleanSupplier timedOut
  ) throws Exception {
    MessageDigest hash = MessageDigest.getInstance("SHA-256");
    long size = 0;
    long limit = number(expected.get("sizeBytes"), 0, 9007199254740991L);
    byte[] buffer = new byte[65536];
    for (int count; (count = input.read(buffer)) != -1; ) {
      if (timedOut.getAsBoolean()) {
        throw new ArchiveFailure("timeout", "The current write operation timed out.");
      }
      control.check();
      size += count;
      if (size > limit) {
        throw new ArchiveFailure(
          "checksum-mismatch",
          "Actual content exceeds the confirmed length."
        );
      }
      hash.update(buffer, 0, count);
    }
    control.check();
    if (size != limit || !ArchiveFormat.hex(hash.digest()).equals(expected.get("sha256"))) {
      throw new ArchiveFailure(
        "checksum-mismatch",
        "Actual content differs from the confirmed fingerprint."
      );
    }
  }

  private ArchiveModel.Observation observe(
    SyncPlanModel.Plan plan,
    ArchiveModel.Source source,
    Map<String, Object> entry,
    ArchiveControl control
  ) throws Exception {
    source.validateRoot(plan.source.root);
    ArchiveModel.Observation value = source.observe(control);
    value.validate();
    List<String> path = BackupModel.path(entry.get("path"));
    if (
      !value.entryId.equals(entry.get("entryId")) ||
      !value.name.equals(path.get(path.size() - 1)) ||
      (value.size != null &&
        value.size.longValue() != number(entry.get("sizeBytes"), 0, BackupModel.MAX_FILE)) ||
      !Objects.equals(
        value.modified,
        nullable(entry.get("modifiedAt"), -BackupModel.MAX_DATE, BackupModel.MAX_DATE)
      )
    ) {
      throw new ArchiveFailure(
        "source-changed",
        "Native material differs from the confirmed reference."
      );
    }
    return value;
  }

  private void preflight(Job job, Material material) throws Exception {
    check(job);
    Map<String, Object> current = scanner.snapshotNow(job.plan.target.root, job.control);
    if (!SyncPlanModel.same(current.get("entries"), job.plan.target.value.get("entries"))) {
      throw new ArchiveFailure(
        "source-changed",
        "The target content differs from confirmation. Scan again."
      );
    }
    for (Map<String, Object> entry : job.plan.target.paths.values()) {
      if (entry.get("kind").equals("directory")) {
        job.directories.put(SyncPlanModel.key(entry.get("path")), string(entry.get("entryId")));
      }
    }
    boolean hasNewFile = false;
    for (Map<String, Object> operation : job.plan.writes) {
      if (SyncPlanModel.isFileWrite(operation)) {
        check(job);
        Map<String, Object> entry = job.plan.source.entry(operation.get("sourceEntryId"));
        ArchiveModel.Source source = material.file(string(entry.get("entryId")));
        ArchiveModel.Observation before = observe(job.plan, source, entry, job.control);
        InputStream input = track(job, source.open(job.control));
        try {
          digest(input, entry, job.control, () -> job.hasTimedOut);
        } finally {
          close(job, input);
        }
        if (!before.same(source.observe(job.control))) {
          throw new ArchiveFailure("source-changed", "Input material changed while reading.");
        }
        if (operation.get("action").equals("create-file")) {
          hasNewFile = true;
        }
      }
    }
    if (hasNewFile) {
      backend.publisher().grant(job.plan.target.root);
    }
    space(job, null, 0);
    check(job);
  }

  private long space(Job job, Path cacheRoot, long cacheBytes) throws Exception {
    long growthBytes = targetGrowth(job.plan);
    long oldBytes = job.plan.backupFiles.isEmpty()
      ? 0
      : number(job.plan.value.get("backupFileBytes"), 0, BackupModel.MAX_TOTAL) +
        bytes(job.plan.value).length +
        8192L;
    Boolean isSameVolume = null;
    Boolean isSameCache = null;
    for (Map<String, Object> entry : job.plan.target.paths.values()) {
      if (entry.get("kind").equals("file")) {
        List<String> path = BackupModel.path(entry.get("path"));
        Replacement replacement = backend.volumeFile(
          job.plan.target.root,
          parent(job, path),
          entry,
          job.control
        );
        if (replacement == null) {
          break;
        }
        track(job, replacement);
        try {
          isSameVolume = replacement.sharesVolume(backups.root());
          if (cacheRoot != null) {
            isSameCache = replacement.sharesVolume(cacheRoot);
          }
        } finally {
          close(job, replacement);
        }
        break;
      }
    }
    boolean isSamePrivate =
      cacheRoot != null &&
      Boolean.TRUE.equals(backend.sharesPrivateVolume(cacheRoot, backups.root()));
    Long available = backend.available(job.plan.target.root, null, job.control);
    long targetPeak =
      growthBytes +
      (Boolean.TRUE.equals(isSameVolume) ? oldBytes : 0) +
      (Boolean.TRUE.equals(isSameCache) ? cacheBytes : 0);
    if (available != null && available < targetPeak) {
      throw new ArchiveFailure(
        "insufficient-space",
        "Target storage has insufficient space for this write and backup."
      );
    }
    if (oldBytes > 0) {
      backups.capacity(
        oldBytes +
          (Boolean.TRUE.equals(isSameVolume) ? growthBytes : 0) +
          (isSamePrivate ? cacheBytes : 0)
      );
    }
    return (isSamePrivate ? oldBytes : 0) + (Boolean.TRUE.equals(isSameCache) ? growthBytes : 0);
  }

  /** 内容 GET 之前检查已知容量和同卷峰值；检查句柄关闭失败时也保留给 retryCleanup。 */
  long checkReceiveSpace(
    SyncPlanModel.Plan plan,
    Path cacheRoot,
    long cacheBytes,
    ArchiveControl control,
    Execution execution
  ) throws Exception {
    require(execution != null && TargetOperation.owns(execution.token) && cacheBytes >= 0);
    Job job = new Job(plan, control, execution);
    synchronized (this) {
      if (isClosed || active != null || preparing != null) {
        throw new ArchiveFailure("busy", "Target resources have not been released.");
      }
      active = job;
    }
    try {
      check(job);
      for (Map<String, Object> entry : plan.target.paths.values()) {
        if (entry.get("kind").equals("directory")) {
          job.directories.put(SyncPlanModel.key(entry.get("path")), string(entry.get("entryId")));
        }
      }
      long extra = space(job, cacheRoot, cacheBytes);
      check(job);
      return extra;
    } finally {
      synchronized (this) {
        job.isRunning = false;
        if (clean(job)) {
          active = null;
        } else {
          throw new ArchiveFailure(
            "cleanup-failed",
            "The capacity check handle has not been released. Retry cleanup."
          );
        }
      }
    }
  }

  private long targetGrowth(SyncPlanModel.Plan plan) throws Exception {
    long total = 0;
    for (Map<String, Object> operation : plan.writes) {
      if (SyncPlanModel.isFileWrite(operation)) {
        long size = number(
          plan.source.entry(operation.get("sourceEntryId")).get("sizeBytes"),
          0,
          BackupModel.MAX_FILE
        );
        long previous = operation.get("action").equals("replace-file")
          ? number(
              plan.target.entry(operation.get("targetEntryId")).get("sizeBytes"),
              0,
              9007199254740991L
            )
          : 0;
        total += Math.max(0, size - previous);
      }
    }
    return total;
  }

  private String parent(Job job, List<String> path) throws Exception {
    if (path.size() == 1) {
      return null;
    }
    String value = job.directories.get(SyncPlanModel.key(path.subList(0, path.size() - 1)));
    if (value == null) {
      throw new ArchiveFailure(
        "source-changed",
        "The target parent directory reference does not exist."
      );
    }
    return value;
  }

  private Map<String, Object> write(
    Job job,
    Map<String, Object> operation,
    Material material,
    int fileIndex
  ) throws Exception {
    check(job);
    List<String> path = BackupModel.path(operation.get("path"));
    String parent = parent(job, path);
    String name = path.get(path.size() - 1);
    if (operation.get("action").equals("create-directory")) {
      String id = backend.createDirectory(job.plan.target.root, parent, name, job.control);
      job.directories.put(SyncPlanModel.key(path), id);
      return outcome(operation, "succeeded", null, null);
    }
    if (SyncPlanModel.isDelete(operation)) {
      Map<String, Object> old = job.plan.target.entry(operation.get("targetEntryId"));
      if (operation.get("action").equals("delete-file")) {
        // 删除前核对完整内容；与确认时不同就不删。
        Replacement target = track(
          job,
          backend.replacement(job.plan.target.root, parent, old, job.control)
        );
        try {
          InputStream original = track(job, target.read(job.control));
          try {
            digest(original, old, job.control, () -> job.hasTimedOut);
          } finally {
            close(job, original);
          }
          target.verify(job.control);
          check(job);
        } finally {
          close(job, target);
        }
      }
      backend.delete(job.plan.target.root, parent, old, job.control);
      job.directories.remove(SyncPlanModel.key(path));
      return outcome(operation, "succeeded", null, null);
    }
    Map<String, Object> entry = job.plan.source.entry(operation.get("sourceEntryId"));
    ArchiveModel.Source source = material.file(string(entry.get("entryId")));
    ArchiveModel.Observation baseline = observe(job.plan, source, entry, job.control);
    if (operation.get("action").equals("create-file")) {
      PublicationModel.Request request = new PublicationModel.Request(
        ArchiveModel.id(fileIndex),
        job.plan.target.root,
        parent,
        name,
        number(entry.get("sizeBytes"), 0, BackupModel.MAX_FILE),
        string(entry.get("sha256"))
      );
      PublicationModel.Result result = backend
        .publisher()
        .publish(request, () -> source.open(job.control), null, job.control);
      if (result.cleanupError != null) {
        job.cleanupError = cleanupError();
      }
      if (job.hasTimedOut && result.status.equals("cancelled")) {
        return outcome(
          operation,
          "failed",
          error("timeout", "The current write operation timed out."),
          null
        );
      }
      Object error =
        result.errorCode == null
          ? null
          : error(
              result.errorCode,
              result.status.equals("unknown")
                ? "The new file result could not be fully verified. Read the target again."
                : "New file creation failed."
            );
      return outcome(operation, result.status, error, entry);
    }
    Map<String, Object> old = job.plan.target.entry(operation.get("targetEntryId"));
    Replacement target = track(
      job,
      backend.replacement(job.plan.target.root, parent, old, job.control)
    );
    boolean hasWritten = false;
    try {
      InputStream original = track(job, target.read(job.control));
      try {
        digest(original, old, job.control, () -> job.hasTimedOut);
      } finally {
        close(job, original);
      }
      target.verify(job.control);
      check(job);
      InputStream input = track(job, source.open(job.control));
      OutputStream output = null;
      try {
        output = track(job, target.output(job.control));
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[65536];
        long size = 0;
        long expected = number(entry.get("sizeBytes"), 0, BackupModel.MAX_FILE);
        for (int count; (count = input.read(buffer)) != -1; ) {
          check(job);
          if (count == 0) {
            continue;
          }
          size += count;
          if (size > expected) {
            throw new ArchiveFailure(
              "checksum-mismatch",
              "Uncompressed content exceeds the confirmed length."
            );
          }
          hasWritten = true;
          output.write(buffer, 0, count);
          hash.update(buffer, 0, count);
        }
        check(job);
        if (size != expected || !ArchiveFormat.hex(hash.digest()).equals(entry.get("sha256"))) {
          throw new ArchiveFailure(
            "checksum-mismatch",
            "Uncompressed content differs from confirmation."
          );
        }
        if (!baseline.same(source.observe(job.control))) {
          throw new ArchiveFailure("source-changed", "Uncompressed content changed while writing.");
        }
        hasWritten = true;
        target.finish(size, job.control);
      } finally {
        try {
          close(job, input);
        } finally {
          if (output != null) {
            close(job, output);
          }
        }
      }
      // 已修改的目标即使收到晚到的取消，也用独立的有界回读报告实际结果。
      ArchiveControl inspection = new ArchiveControl();
      target.verify(inspection);
      InputStream readback = trackInspection(job, target.read(inspection));
      try {
        digest(readback, entry, inspection, () -> false);
      } finally {
        close(job, readback);
      }
      // 结果已核实；目标句柄交给外围清理，关闭失败不能改写文件成功。
      target.verify(inspection);
      return outcome(operation, "succeeded", null, entry);
    } catch (Exception cause) {
      if (hasWritten) {
        return outcome(
          operation,
          "unknown",
          error(
            "result-unknown",
            "Writing to the target file started but the result could not be fully verified. " +
              "Read the target again."
          ),
          null
        );
      }
      throw cause;
    }
  }

  private <T extends Closeable> T trackInspection(Job job, T value) {
    job.resources.add(value);
    return value;
  }

  /** 执行计划：非法、过期、已用或 busy 的确认抛异常；任务接受后返回完整的实际结果，绝不自动重做。 */
  Map<String, Object> apply(Object raw, Material material, ArchiveControl control)
    throws Exception {
    return apply(raw, material, control, null);
  }

  Map<String, Object> apply(
    Object raw,
    Material material,
    ArchiveControl control,
    Execution execution
  ) throws Exception {
    SyncPlanModel.Plan plan = new SyncPlanModel.Plan(raw);
    require(plan.target.device.equals(backend.source().deviceId()));
    one(plan.value.get("direction"), "windows-to-android", "local-restore");
    if (material == null) {
      require(number(plan.value.get("transferFileCount"), 0, 1024) == 0);
    } else {
      require(SyncPlanModel.same(plan.source.value, material.snapshot()));
    }
    long observed = number(
      plan.target.value.get("observedAt"),
      -BackupModel.MAX_DATE,
      BackupModel.MAX_DATE
    );
    long now = System.currentTimeMillis();
    long acceptedAt = execution == null ? now : execution.acceptedAt;
    if (
      acceptedAt > now ||
      now - acceptedAt > 1800000 ||
      observed > acceptedAt ||
      acceptedAt - observed > 600000
    ) {
      throw new ArchiveFailure("not-found", "The local confirmation snapshot expired. Scan again.");
    }
    Job job = new Job(plan, control, execution);
    synchronized (this) {
      if (isClosed || active != null || preparing != null) {
        throw new ArchiveFailure(
          "busy",
          "Writing has not finished or resources are still awaiting cleanup."
        );
      }
      if (used.contains(plan.id)) {
        throw new ArchiveFailure(
          "task-conflict",
          "This confirmation was already executed. Scan again."
        );
      }
      if (used.size() >= 4096) {
        throw new ArchiveFailure(
          "resource-limit",
          "The confirmation ID capacity for this process is full."
        );
      }
      if (job.ownToken ? !TargetOperation.acquire(job.token) : !TargetOperation.owns(job.token)) {
        throw new ArchiveFailure(
          "busy",
          "A transfer or restore task already exists, or this operation slot was released."
        );
      }
      used.add(plan.id);
      active = job;
    }
    List<Object> outcomes = new ArrayList<>();
    for (Map<String, Object> operation : plan.writes) {
      outcomes.add(outcome(operation, "not-attempted", null, null));
    }
    Object error = null;
    Object cleanup = null;
    Object backupId = null;
    Object backupFileCount = null;
    int index = 0;
    int fileIndex = 0;
    try {
      if (job.observer != null) {
        job.observer.stage("verifying");
      }
      preflight(job, material);
      if (job.observer != null) {
        job.observer.stage("backing-up");
      }
      Map<String, Object> backup = backups.create(
        plan.project,
        plan.target.root,
        plan.reason,
        plan.shouldBackup,
        plan.backupFiles,
        control
      );
      cleanup = backup.get("cleanupError");
      if (!plan.backupFiles.isEmpty() && backup.get("manifest") == null) {
        throw new ArchiveFailure(
          "io-failure",
          "A complete protective backup has not been committed."
        );
      }
      if (backup.get("manifest") != null) {
        backupId = map(backup.get("manifest")).get("backupId");
        backupFileCount = (long) list(map(backup.get("manifest")).get("files")).size();
      }
      // SAF 与私有目录可能使用不同的逻辑设备 ID；备份落盘后再查实际余量，覆盖共享物理卷。
      Long remaining = backend.available(plan.target.root, null, control);
      if (remaining != null && remaining < targetGrowth(plan)) {
        throw new ArchiveFailure(
          "insufficient-space",
          "Free target space after backup is insufficient " +
            "for the file size increase in this operation."
        );
      }
      if (!plan.writes.isEmpty()) {
        backend.writeStarted(plan, backupId);
      }
      if (job.observer != null) {
        job.observer.stage("writing");
      }
      for (int i = 0; i < plan.writes.size(); i++) {
        index = i;
        Map<String, Object> operation = plan.writes.get(i);
        Map<String, Object> result = write(job, operation, material, fileIndex);
        outcomes.set(i, result);
        if (SyncPlanModel.isFileWrite(operation)) {
          fileIndex++;
        }
        if (job.observer != null) {
          try {
            job.observer.outcome(result);
          } catch (Exception ignored) {
            /* 观察者失败不能改写已核实的实际结果。 */
          }
        }
        if (!result.get("status").equals("succeeded")) {
          error = result.get("error");
          break;
        }
        if (!clean(job)) {
          cleanup = cleanupError();
          error = i + 1 < plan.writes.size() ? cleanup : null;
          break;
        }
        index = i + 1;
      }
    } catch (Exception cause) {
      ArchiveFailure failure = ArchiveFailure.from(cause);
      if (!failure.code.equals("result-unknown") && !failure.code.equals("timeout")) {
        try {
          control.check();
        } catch (ArchiveFailure stopped) {
          failure = stopped;
        }
      }
      if (job.hasTimedOut) {
        failure = new ArchiveFailure(
          "timeout",
          "The current write operation timed out.",
          false,
          cause
        );
      }
      if (!failure.isCancelled) {
        error = error(failure.code, failure.getMessage());
      }
      if (failure.cleanupFailure != null) {
        cleanup = cleanupError();
      }
      if (
        index < plan.writes.size() && map(outcomes.get(index)).get("status").equals("not-attempted")
      ) {
        String status = failure.code.equals("result-unknown")
          ? "unknown"
          : failure.isCancelled
            ? "cancelled"
            : "failed";
        outcomes.set(
          index,
          outcome(plan.writes.get(index), status, failure.isCancelled ? null : error, null)
        );
      }
    } finally {
      backend.writeEnded(plan);
      boolean isClean = clean(job);
      if (!isClean) {
        cleanup = cleanupError();
      }
      if (cleanup == null && job.cleanupError != null) {
        cleanup = job.cleanupError;
      }
      synchronized (this) {
        job.isRunning = false;
        if (isClean) {
          active = null;
          if (job.ownToken) {
            TargetOperation.release(job.token);
          }
        }
        notifyAll();
      }
    }
    return object(
      "schemaVersion",
      1,
      "planId",
      plan.id,
      "backupId",
      backupId,
      "backupFileCount",
      backupFileCount,
      "outcomes",
      outcomes,
      "error",
      error,
      "cleanupError",
      cleanup
    );
  }

  private boolean clean(Job job) {
    boolean isClean = true;
    for (Closeable resource : new ArrayList<>(job.resources)) {
      try {
        close(job, resource);
      } catch (Exception failure) {
        isClean = false;
      }
    }
    return backend.publisher().retryCleanup() && isClean;
  }

  /** 重试资源释放，不重新创建或写入文件。 */
  synchronized boolean retryCleanup() {
    Job job = active;
    if (job != null && (job.isRunning || !clean(job))) {
      return false;
    }
    for (Restore restore : new ArrayList<>(restores)) {
      if (restore.isConsumed && !restore.isRunning) {
        try {
          restore.close();
        } catch (Exception failure) {
          return false;
        }
      }
    }
    if (job != null) {
      active = null;
      if (job.ownToken) {
        TargetOperation.release(job.token);
      }
    }
    return true;
  }

  /** 本机恢复预览，保持对输入的引用；公开数据供 TS 生成计划，确认时必须提交同一份源和目标。 */
  final class Restore implements Material, AutoCloseable {

    final String planId = java.util.UUID.randomUUID().toString();
    final String projectId;
    final String rootId;
    final long created = System.nanoTime();
    final BackupStore.Handle handle;
    final Map<String, Object> source;
    final Map<String, Object> target;
    boolean isConsumed;
    boolean isRunning;

    Restore(String projectId, String rootId, BackupStore.Handle handle, Map<String, Object> target)
      throws Exception {
      this.projectId = projectId;
      this.rootId = rootId;
      this.handle = handle;
      source = handle.snapshot();
      this.target = target;
    }

    Map<String, Object> preview() throws Exception {
      return map(
        copy(object("planId", planId, "projectId", projectId, "source", source, "target", target))
      );
    }

    @Override
    public Map<String, Object> snapshot() throws Exception {
      return map(copy(source));
    }

    @Override
    public ArchiveModel.Source file(String entryId) throws Exception {
      return handle.source(entryId);
    }

    Map<String, Object> apply(Object raw, ArchiveControl control) throws Exception {
      SyncPlanModel.Plan plan = new SyncPlanModel.Plan(raw);
      synchronized (SyncWriter.this) {
        if (
          isClosed ||
          isConsumed ||
          !restores.contains(this) ||
          System.nanoTime() - created > TimeUnit.MINUTES.toNanos(10)
        ) {
          throw new ArchiveFailure(
            "not-found",
            "The restore preview was used, closed, or expired."
          );
        }
        require(
          plan.reason.equals("restore") &&
            plan.id.equals(planId) &&
            plan.project.equals(projectId) &&
            plan.target.root.equals(rootId) &&
            SyncPlanModel.same(plan.source.value, source) &&
            SyncPlanModel.same(plan.target.value, target)
        );
        isConsumed = true;
        isRunning = true;
        restoring++;
      }
      Map<String, Object> result = null;
      try {
        result = SyncWriter.this.apply(plan.value, this, control);
        return result;
      } finally {
        try {
          Map<String, Object> released = handle.release();
          if (result != null && result.get("cleanupError") == null) {
            result.put("cleanupError", released.get("cleanupError"));
          }
          synchronized (SyncWriter.this) {
            restores.remove(this);
          }
        } catch (Exception failure) {
          if (result != null) {
            result.put("cleanupError", cleanupError());
          }
        } finally {
          synchronized (SyncWriter.this) {
            isRunning = false;
            restoring--;
            SyncWriter.this.notifyAll();
          }
        }
      }
    }

    @Override
    public void close() throws Exception {
      synchronized (SyncWriter.this) {
        if (isRunning) {
          throw new ArchiveFailure("busy", "The restore task has not finished.");
        }
        isConsumed = true;
      }
      handle.close();
      synchronized (SyncWriter.this) {
        isConsumed = true;
        restores.remove(this);
      }
    }
  }

  Restore prepareRestore(String projectId, String rootId, String backupId, ArchiveControl control)
    throws Exception {
    id(projectId);
    id(rootId);
    id(backupId);
    synchronized (this) {
      if (isClosed || active != null || preparing != null || restores.size() >= 32) {
        throw new ArchiveFailure(
          "busy",
          "An operation is running or the restore preview limit has been reached."
        );
      }
      preparing = control;
      hasPreparationTimedOut = false;
    }
    BackupStore.Handle handle = null;
    try {
      backend.authorizeProject(projectId, rootId, control);
      handle = backups.acquire(projectId, rootId, backupId, control);
      Restore result = new Restore(projectId, rootId, handle, scanner.snapshotNow(rootId, control));
      control.check();
      synchronized (this) {
        if (isClosed) {
          throw new ArchiveFailure("busy", "The writer is closed.");
        }
        restores.add(result);
      }
      return result;
    } catch (Exception failure) {
      if (handle != null) {
        handle.close();
      }
      if (hasPreparationTimedOut) {
        throw new ArchiveFailure(
          "timeout",
          "Restore preview preparation timed out.",
          false,
          failure
        );
      }
      throw failure;
    } finally {
      synchronized (this) {
        preparing = null;
        notifyAll();
      }
    }
  }

  private void close(Job job, Closeable value) throws Exception {
    value.close();
    job.control.untrack(value);
    job.resources.remove(value);
  }

  /** 关闭写入器：取消工作并等待释放。只由 SyncTransferEngine 和 SyncWriteRuntime 的 close 调用。 */
  @Override
  public void close() throws Exception {
    isClosed = true;
    Job job = active;
    if (job != null) {
      job.control.cancel();
    }
    ArchiveControl preview = preparing;
    if (preview != null) {
      preview.cancel();
    }
    synchronized (this) {
      while ((active != null && active.isRunning) || preparing != null || restoring > 0) {
        wait(1000);
      }
      if (!retryCleanup()) {
        throw new ArchiveFailure("cleanup-failed", "The target file has not been released.");
      }
    }
    for (Restore restore : new ArrayList<>(restores)) {
      restore.close();
    }
    scanner.close();
    watcher.shutdownNow();
    backend.publisher().stop();
  }
}
