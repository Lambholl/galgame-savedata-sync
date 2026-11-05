package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.PublicationModel.Document;
import static io.github.galgame.savedatasync.PublicationModel.Entry;
import static io.github.galgame.savedatasync.PublicationModel.MAX_DIRECTORY_ENTRIES;
import static io.github.galgame.savedatasync.PublicationModel.Request;
import static io.github.galgame.savedatasync.PublicationModel.Result;
import static io.github.galgame.savedatasync.PublicationModel.nameKey;

import java.io.Closeable;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 同步发布单个新文件，只能在 I/O 工作线程使用；批次校验、HTTP 和界面由调用方编排。
 * SAF 创建不是排他操作：不用覆盖或重命名，创建返回后必须先确认新文档的身份和父目录。
 * 发布名额独立于归档名额；流关闭且残留清理完成后才释放。
 */
final class NewFilePublisher {

  interface Source {
    InputStream open() throws Exception;
  }

  interface Directory {}

  interface Owned extends Closeable {
    OutputStream openOutput(long size, ArchiveControl control) throws Exception;

    InputStream openRead(ArchiveControl control) throws Exception;

    void verify(ArchiveControl control) throws Exception;

    Entry entry(ArchiveControl control) throws Exception;

    void delete() throws Exception;
  }

  interface Backend {
    Directory locate(String rootId, String parentId, ArchiveControl control) throws Exception;

    List<Document> children(Directory directory, ArchiveControl control) throws Exception;

    String create(Directory directory, String name) throws Exception;

    Owned claim(Directory directory, Document document) throws Exception;

    /** 提供者能报告容量时返回可用字节；未知为 null。 */
    default Long availableBytes(Directory directory, ArchiveControl control) throws Exception {
      return null;
    }
  }

  private static final java.util.concurrent.atomic.AtomicReference<NewFilePublisher> PROCESS_OWNER =
    new java.util.concurrent.atomic.AtomicReference<>();
  private final Backend backend;
  private final Set<String> grants = new HashSet<>();
  private Job active;
  private boolean isStopped;
  private long authorizationVersion;

  private static final class Job {

    final Request request;
    final ArchiveControl control;
    Owned owned;
    Entry residual;
    boolean isRunning = true;
    boolean hasSucceeded;
    final List<Closeable> resources = new ArrayList<>();

    Job(Request request, ArchiveControl control) {
      this.request = request;
      this.control = control;
    }
  }

  NewFilePublisher(Backend backend) {
    this.backend = backend;
  }

  /** 选择目录及接收前调用，核实持久系统写权限并恢复本进程的发布授权。 */
  void grant(String rootId) throws Exception {
    final long version;
    synchronized (this) {
      if (isStopped || !SafValues.isId(rootId)) {
        throw new ArchiveFailure(
          "invalid-request",
          "The publisher is unavailable or the root reference is invalid."
        );
      }
      version = authorizationVersion;
    }
    backend.locate(rootId, null, new ArchiveControl());
    synchronized (this) {
      if (isStopped || version != authorizationVersion) {
        throw new ArchiveFailure(
          "authorization-expired",
          "Authorization was revoked or stopping was requested during authorization."
        );
      }
      grants.add(rootId);
    }
  }

  synchronized void revoke(String rootId) {
    grants.remove(rootId);
    authorizationVersion++;
    if (active != null && active.request.rootId.equals(rootId)) {
      active.control.cancel();
    }
  }

  synchronized void cancel() {
    if (active != null) {
      active.control.cancel();
    }
  }

  /** 接受批次前逐项调用的只读检查；不创建目录或文件，也不授予写权限。 */
  void preflight(Request request, ArchiveControl control) throws Exception {
    preflight(request, request.sizeBytes, control);
  }

  /** 接受批次前的只读检查，requiredBytes 是这批原文的总量；每个目标都按整批检查，因为同卷下可能有不同父目录。 */
  void preflight(Request request, long requiredBytes, ArchiveControl control) throws Exception {
    request.validate();
    if (requiredBytes < request.sizeBytes || requiredBytes > new ArchiveModel.Limits().total) {
      throw new ArchiveFailure(
        "invalid-request",
        "The target space preflight byte count is invalid."
      );
    }
    synchronized (this) {
      if (isStopped || !grants.contains(request.rootId)) {
        throw new ArchiveFailure(
          "permission-denied",
          "Writing to this target directory was not explicitly authorized."
        );
      }
    }
    control.check();
    Directory directory = backend.locate(request.rootId, request.parentId, control);
    Long available = backend.availableBytes(directory, control);
    if (available != null && available < requiredBytes) {
      throw new ArchiveFailure(
        "insufficient-space",
        "Target storage has insufficient space to receive this file batch."
      );
    }
    requireName(backend.children(directory, control), request.name, null);
    control.check();
  }

  Result publish(
    Request request,
    Source source,
    ArchiveModel.Progress progress,
    ArchiveControl control
  ) throws ArchiveFailure {
    request.validate();
    Job job = new Job(request, control);
    synchronized (this) {
      if (isStopped || !grants.contains(request.rootId)) {
        throw new ArchiveFailure(
          "permission-denied",
          "Writing to this target directory was not explicitly authorized."
        );
      }
      if (!PROCESS_OWNER.compareAndSet(null, this)) {
        throw new ArchiveFailure("busy", "Another publication or leftover cleanup is incomplete.");
      }
      active = job;
    }
    String status = "failed";
    String error = null;
    Entry success = null;
    boolean wasCreateAttempted = false;
    boolean wasCreateResolved = false;
    try {
      control.check();
      Directory directory = backend.locate(request.rootId, request.parentId, control);
      List<Document> before = backend.children(directory, control);
      final Set<String> ids = ids(before);
      requireName(before, request.name, null);
      control.check();
      wasCreateAttempted = true;
      String id = backend.create(directory, request.name);
      // createDocument 没有取消参数；取消后也要等它返回并核实归属，不能按文件名猜测清理。
      ArchiveControl inspection = new ArchiveControl();
      List<Document> after = backend.children(directory, inspection);
      ids(after);
      Document created = null;
      for (Document d : after) {
        if (d.id.equals(id)) {
          created = d;
        }
      }
      if (id == null || ids.contains(id) || created == null) {
        throw new ArchiveFailure(
          "result-unknown",
          "The provider did not return a verifiable new entry."
        );
      }
      job.owned = backend.claim(directory, created);
      job.residual = job.owned.entry(inspection);
      wasCreateResolved = true;
      if (created.isDirectory || created.isVirtual) {
        throw new ArchiveFailure(
          "unsupported-operation",
          "The new entry is not a regular raw file."
        );
      }
      if (!created.name.equals(request.name)) {
        throw new ArchiveFailure("name-conflict", "The provider changed the new file name.");
      }
      requireName(after, request.name, id);
      control.check();
      job.owned.verify(control);
      copy(job, source, job.owned, request, progress, control);
      control.check();
      job.owned.verify(control);
      final Entry readBaseline = job.owned.entry(control);
      checkContents(job, job.owned, request, progress, control);
      control.check();
      job.owned.verify(control);
      requireName(backend.children(directory, control), request.name, id);
      success = job.owned.entry(control);
      if (
        !request.name.equals(success.name) ||
        (success.size != null && success.size != request.sizeBytes) ||
        !readBaseline.entryId.equals(success.entryId) ||
        !java.util.Objects.equals(readBaseline.size, success.size) ||
        !java.util.Objects.equals(readBaseline.modified, success.modified)
      ) {
        throw new ArchiveFailure(
          "result-unknown",
          "Metadata after writing does not match the request."
        );
      }
      control.check();
      // 这里是确认的发布点；之后的取消和资源关闭错误都不能删除已成功的文件。
      status = "succeeded";
      job.hasSucceeded = true;
      job.residual = null;
    } catch (Exception cause) {
      ArchiveFailure failure = failure(cause);
      boolean isUncertain =
        "result-unknown".equals(failure.code) || (wasCreateAttempted && !wasCreateResolved);
      if (!isUncertain) {
        try {
          control.check();
        } catch (ArchiveFailure interrupted) {
          failure = interrupted;
        }
      }
      status = isUncertain ? "unknown" : failure.isCancelled ? "cancelled" : "failed";
      error = isUncertain ? "result-unknown" : failure.isCancelled ? null : failure.code;
    }
    String cleanup =
      job.owned == null
        ? wasCreateAttempted && !wasCreateResolved
          ? "unknown"
          : "not-needed"
        : "complete";
    String cleanupError = "unknown".equals(cleanup) ? "result-unknown" : null;
    try {
      closeResources(job);
    } catch (Exception cause) {
      cleanup = "incomplete";
      cleanupError = "cleanup-failed";
    }
    if (job.owned != null && job.resources.isEmpty()) {
      try {
        if (!"succeeded".equals(status)) {
          job.owned.delete();
        }
        job.owned.close();
        job.owned = null;
        job.residual = null;
      } catch (Exception cause) {
        cleanup = "incomplete";
        cleanupError = "cleanup-failed";
      }
    }
    synchronized (this) {
      job.isRunning = false;
      if (job.owned == null && job.resources.isEmpty()) {
        release(job);
      }
    }
    return new Result(request, status, error, success, job.residual, cleanup, cleanupError);
  }

  /** 重试已知句柄的清理，不重做创建和写入；成功的文件只关闭句柄。 */
  synchronized boolean retryCleanup() {
    Job job = active;
    if (job == null) {
      return true;
    }
    if (job.isRunning) {
      return false;
    }
    try {
      closeResources(job);
      if (job.owned != null) {
        if (!job.hasSucceeded) {
          job.owned.delete();
        }
        job.owned.close();
        job.owned = null;
        job.residual = null;
      }
    } catch (Exception cause) {
      return false;
    }
    release(job);
    return true;
  }

  /** 停止发布器：生命周期先取消，工作线程 join 后再次调用以确认释放；阻塞中的平台调用不会被抢占。 */
  synchronized boolean stop() {
    isStopped = true;
    authorizationVersion++;
    grants.clear();
    cancel();
    return retryCleanup();
  }

  private void release(Job job) {
    synchronized (this) {
      if (active == job) {
        active = null;
        PROCESS_OWNER.compareAndSet(this, null);
      }
    }
  }

  private static Set<String> ids(List<Document> documents) throws ArchiveFailure {
    if (documents.size() > MAX_DIRECTORY_ENTRIES) {
      throw new ArchiveFailure(
        "resource-limit",
        "The current target directory level has too many entries."
      );
    }
    Set<String> result = new HashSet<>();
    for (Document d : documents) {
      if (
        d == null ||
        d.id == null ||
        d.id.isEmpty() ||
        !ArchiveModel.text(d.name) ||
        !result.add(d.id)
      ) {
        throw new ArchiveFailure(
          "result-unknown",
          "The provider returned inconsistent directory entries."
        );
      }
    }
    return result;
  }

  private static void requireName(List<Document> documents, String name, String ownId)
    throws ArchiveFailure {
    ids(documents);
    for (Document d : documents) {
      if (!d.id.equals(ownId) && nameKey(d.name).equals(nameKey(name))) {
        throw new ArchiveFailure(
          "name-conflict",
          "The target already contains an entry with the same or an equivalent name."
        );
      }
    }
  }

  private static void copy(
    Job job,
    Source source,
    Owned owned,
    Request request,
    ArchiveModel.Progress progress,
    ArchiveControl control
  ) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    InputStream input = track(job, source.open());
    try {
      OutputStream output = track(job, owned.openOutput(request.sizeBytes, control));
      try {
        transfer(input, output, request, digest, progress, "writing", control);
        output.flush();
      } finally {
        close(job, output);
      }
    } finally {
      close(job, input);
    }
  }

  private static void checkContents(
    Job job,
    Owned owned,
    Request request,
    ArchiveModel.Progress progress,
    ArchiveControl control
  ) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    InputStream input = track(job, owned.openRead(control));
    try {
      transfer(input, null, request, digest, progress, "verifying", control);
    } finally {
      close(job, input);
    }
  }

  private static <T extends Closeable> T track(Job job, T resource) throws Exception {
    job.resources.add(resource);
    return job.control.track(resource);
  }

  private static void close(Job job, Closeable resource) throws Exception {
    resource.close();
    job.control.untrack(resource);
    job.resources.remove(resource);
  }

  private static void closeResources(Job job) throws Exception {
    Exception failure = null;
    for (Closeable resource : new ArrayList<>(job.resources)) {
      try {
        close(job, resource);
      } catch (Exception cause) {
        failure = cause;
      }
    }
    if (failure != null) {
      throw failure;
    }
  }

  private static void transfer(
    InputStream input,
    OutputStream output,
    Request request,
    MessageDigest digest,
    ArchiveModel.Progress progress,
    String stage,
    ArchiveControl control
  ) throws Exception {
    byte[] buffer = new byte[65536];
    long count = 0;
    while (true) {
      control.check();
      int read = input.read(
        buffer,
        0,
        (int) Math.min(buffer.length, request.sizeBytes - count + 1)
      );
      if (read < 0) {
        break;
      }
      if (read == 0) {
        throw new ArchiveFailure("io-failure", "The stream made no progress.");
      }
      if (count + read > request.sizeBytes) {
        throw new ArchiveFailure(
          "checksum-mismatch",
          "The actual file length exceeds the request."
        );
      }
      if (output != null) {
        output.write(buffer, 0, read);
      }
      digest.update(buffer, 0, read);
      count += read;
      if (progress != null) {
        progress.update(stage, count, request.sizeBytes);
      }
    }
    control.check();
    if (count != request.sizeBytes || !hex(digest.digest()).equals(request.sha256)) {
      throw new ArchiveFailure(
        "checksum-mismatch",
        "The actual file length or SHA-256 does not match."
      );
    }
  }

  static String hex(byte[] bytes) {
    StringBuilder result = new StringBuilder();
    for (byte b : bytes) {
      result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
    }
    return result.toString();
  }

  static ArchiveFailure failure(Exception cause) {
    if (cause instanceof SafFailure) {
      return new ArchiveFailure(
        ((SafFailure) cause).code,
        "SAF publication access failed.",
        false,
        cause
      );
    }
    if (cause instanceof SecurityException) {
      return new ArchiveFailure(
        "authorization-expired",
        "Directory write authorization is unavailable.",
        false,
        cause
      );
    }
    return ArchiveFailure.from(cause);
  }
}
