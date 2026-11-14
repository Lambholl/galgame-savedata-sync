package io.github.galgame.savedatasync;

import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 生成和接收 tar.gz 归档。prepare 和 receive 要在同一个后台 I/O 线程调用，cancel 可以在其他线程调用。
 *
 * <p>返回的句柄占用进程任务名额，关闭所有读流并 dispose 后释放；操作失败时会清理，
 * 清理失败时通过 cleanupFailure 报告并继续占名额，要调用 retryCleanup。
 */
final class ArchiveAdapter {

  private static final int READ_THREADS = 8;
  private final ArchiveCache cache;
  private final ArchiveModel.Limits limits;
  private volatile ArchiveControl current;
  private ArchiveCache.Job owned;

  ArchiveAdapter(ArchiveCache cache) {
    this(cache, new ArchiveModel.Limits());
  }

  ArchiveAdapter(ArchiveCache cache, ArchiveModel.Limits limits) {
    this.cache = cache;
    this.limits = limits;
  }

  /** 检查接收压缩体和解包原文所需的空间。 */
  void checkReceiveSpace(ArchiveModel.Manifest manifest) throws Exception {
    checkReceiveSpace(manifest, 0);
  }

  /** 检查接收所需的空间；extraPrivateBytes 是同一个卷上另外需要的字节数。 */
  void checkReceiveSpace(ArchiveModel.Manifest manifest, long extraPrivateBytes) throws Exception {
    manifest.validate(limits);
    if (
      extraPrivateBytes < 0 ||
      extraPrivateBytes > Long.MAX_VALUE - manifest.archive.sizeBytes - manifest.totalFileBytes
    ) {
      throw new ArchiveFailure("invalid-request", "The space preflight byte count is invalid.");
    }
    cache.checkSpace(manifest.archive.sizeBytes + manifest.totalFileBytes + extraPrivateBytes);
  }

  java.nio.file.Path privateRoot() throws Exception {
    cache.checkSpace(0);
    return cache.root;
  }

  /** 检查私有缓存能否放下 bytes 字节的解包内容；extraPrivateBytes 是同一个卷上另外需要的字节数。 */
  void checkStagingSpace(long bytes, long extraPrivateBytes) throws Exception {
    if (bytes < 0 || extraPrivateBytes < 0 || extraPrivateBytes > Long.MAX_VALUE - bytes) {
      throw new ArchiveFailure("invalid-request", "The space preflight byte count is invalid.");
    }
    ArchiveModel.limit(bytes <= limits.total);
    cache.checkSpace(bytes + extraPrivateBytes);
  }

  /** 要发送的一个文件：来源和确认时的条目 ID、大小与修改日期。 */
  static final class Outgoing {

    final ArchiveModel.Source source;
    final String entryId;
    final long size;
    final Long modified;

    Outgoing(ArchiveModel.Source source, String entryId, long size, Long modified) {
      this.source = source;
      this.entryId = entryId;
      this.size = size;
      this.modified = modified;
    }
  }

  private static final class Opened {

    final ArchiveModel.Observation before;
    final InputStream input;

    Opened(ArchiveModel.Observation before, InputStream input) {
      this.before = before;
      this.input = input;
    }
  }

  /**
   * 按顺序读取 files，边读边打包成 tar.gz 写进 output。output 由调用方关闭。
   *
   * <p>最多提前打开 READ_THREADS 个文件。progress 在调用线程收到 transferring 阶段累计已打包的文件内容字节数。
   *
   * @throws ArchiveFailure 文件的大小或修改日期与确认时不同、读取期间被改动时为 source-changed；写入 output 失败时为
   *     network-failure。
   */
  void sendFiles(
    List<Outgoing> files,
    OutputStream output,
    ArchiveControl control,
    ArchiveModel.Progress progress
  ) throws ArchiveFailure {
    ArchiveModel.require(files != null && !files.isEmpty() && output != null && control != null);
    ArchiveModel.limit(files.size() <= limits.files);
    Sink sink = new Sink(output);
    // 经 SAF 打开一个文件要几十毫秒，主要在等提供者；提前打开后面的文件，几百个小文件的发送能快几倍。
    ExecutorService openers = Executors.newFixedThreadPool(Math.min(READ_THREADS, files.size()));
    List<Future<Opened>> pending = new ArrayList<>();
    try {
      byte[] buffer = new byte[ArchiveModel.BUFFER];
      long sent = 0;
      try (ArchiveFormat.GzipWriter gzip = new ArchiveFormat.GzipWriter(sink)) {
        for (int i = 0; i < files.size(); i++) {
          while (pending.size() < files.size() && pending.size() < i + READ_THREADS) {
            Outgoing next = files.get(pending.size());
            pending.add(openers.submit(() -> open(next, control)));
          }
          Outgoing file = files.get(i);
          Opened opened = await(pending.get(i), control);
          pending.set(i, null);
          long size = 0;
          try (InputStream input = opened.input) {
            gzip.write(ArchiveFormat.header(ArchiveModel.id(i), file.size));
            int n;
            while ((n = read(input, buffer, control)) != -1) {
              if (size > file.size - n) {
                throw changed();
              }
              gzip.write(buffer, 0, n);
              size += n;
              sent += n;
              emit(progress, "transferring", sent, null, control);
            }
          } finally {
            control.untrack(opened.input);
          }
          if (size != file.size || !opened.before.same(file.source.observe(control))) {
            throw changed();
          }
          gzip.write(new byte[(int) (ArchiveModel.padded(size) - size)]);
        }
        gzip.write(new byte[1024]);
      }
    } catch (Exception cause) {
      ArchiveFailure failure = ArchiveFailure.from(cause);
      try {
        control.check();
      } catch (ArchiveFailure cancellation) {
        cancellation.addSuppressed(failure);
        throw cancellation;
      }
      if (sink.hasFailed) {
        throw new ArchiveFailure(
          "network-failure",
          "The connection was interrupted while sending.",
          false,
          cause
        );
      }
      throw failure;
    } finally {
      // 先等提前打开的任务结束并关闭它们的流，再关线程池；shutdownNow 丢弃的任务永远等不到结果。
      for (Future<Opened> task : pending) {
        closeOpened(task, control);
      }
      openers.shutdown();
    }
  }

  private Opened open(Outgoing file, ArchiveControl control) throws Exception {
    control.check();
    ArchiveModel.Observation before = file.source.observe(control);
    ArchiveModel.require(before != null);
    before.validate();
    if (
      !file.entryId.equals(before.entryId) ||
      before.size == null ||
      before.size != file.size ||
      !java.util.Objects.equals(before.modified, file.modified)
    ) {
      throw changed();
    }
    ArchiveModel.limit(file.size <= limits.file);
    return new Opened(before, control.track(file.source.open(control)));
  }

  private static Opened await(Future<Opened> task, ArchiveControl control) throws Exception {
    for (;;) {
      control.check();
      try {
        return task.get(100, TimeUnit.MILLISECONDS);
      } catch (TimeoutException waiting) {
        // 等待期间也要响应取消。
      } catch (java.util.concurrent.ExecutionException failed) {
        Throwable cause = failed.getCause();
        throw cause instanceof Exception ? (Exception) cause : failed;
      }
    }
  }

  /** 等提前打开的任务结束，关闭还没用到的流。 */
  private static void closeOpened(Future<Opened> task, ArchiveControl control) {
    if (task == null) {
      return;
    }
    Opened opened;
    try {
      opened = task.get();
    } catch (Exception failed) {
      return;
    }
    try {
      opened.input.close();
    } catch (IOException ignored) {
      /* 只读的流，关闭失败不影响结果。 */
    } finally {
      control.untrack(opened.input);
    }
  }

  /**
   * 接管并关闭 source，按 sizes 的顺序把 tar.gz 解包到私有缓存；成员名依次是 f000001、f000002……。
   *
   * <p>progress 收到 transferring 阶段累计已解包的文件内容字节数。全部成功才返回句柄。
   *
   * @throws ArchiveFailure 成员的名称、大小或顺序不对，或 gzip 的 CRC、长度不对时为 invalid-archive。
   */
  Staged receiveFiles(
    List<Long> sizes,
    InputStream source,
    ArchiveControl control,
    ArchiveModel.Progress progress
  ) throws ArchiveFailure {
    ArchiveModel.require(source != null && control != null);
    ArchiveCache.Job job = null;
    try (InputStream input = source) {
      ArchiveModel.require(sizes != null && !sizes.isEmpty());
      ArchiveModel.limit(sizes.size() <= limits.files);
      long total = 0;
      long tarSize = 1024;
      for (long size : sizes) {
        ArchiveModel.require(size >= 0);
        ArchiveModel.limit(size <= limits.file && total <= limits.total - size);
        total += size;
        tarSize += 512 + ArchiveModel.padded(size);
      }
      ArchiveModel.limit(tarSize <= limits.tar);
      job = begin(control);
      control.track(input);
      job.space(total);
      byte[] buffer = new byte[ArchiveModel.BUFFER];
      List<String> ids = new ArrayList<>();
      try (ArchiveFormat.GzipReader tar = new ArchiveFormat.GzipReader(input, tarSize, control)) {
        long completed = 0;
        for (int i = 0; i < sizes.size(); i++) {
          String id = ArchiveModel.id(i);
          long size = sizes.get(i);
          byte[] header = new byte[512];
          ArchiveFormat.exact(tar, header, 512, control);
          if (!Arrays.equals(header, ArchiveFormat.header(id, size))) {
            throw ArchiveFormat.invalid("A tar header, order, type, or length is invalid.");
          }
          long remaining = size;
          try (OutputStream out = job.create(id, limits.file, control)) {
            while (remaining > 0) {
              int n = (int) Math.min(buffer.length, remaining);
              ArchiveFormat.exact(tar, buffer, n, control);
              out.write(buffer, 0, n);
              remaining -= n;
              completed += n;
              emit(progress, "transferring", completed, total, control);
            }
          }
          ids.add(id);
          int padding = (int) (ArchiveModel.padded(size) - size);
          ArchiveFormat.exact(tar, buffer, padding, control);
          ArchiveFormat.zeros(buffer, padding);
        }
        ArchiveFormat.exact(tar, buffer, 1024, control);
        ArchiveFormat.zeros(buffer, 1024);
        if (tar.read() != -1) {
          throw ArchiveFormat.invalid("Extra records follow the end of the tar archive.");
        }
      }
      control.check();
      return new Staged(job, ids, control);
    } catch (Exception cause) {
      if (job == null) {
        throw ArchiveFailure.from(cause);
      }
      throw failed(job, control, cause);
    } finally {
      control.untrack(source);
    }
  }

  private static ArchiveFailure changed() {
    return new ArchiveFailure("source-changed", "The source file differs from confirmation.");
  }

  /** 读取一次源文件，生成私有快照和归档；长度未知的文件按实际读到的字节计数。 */
  Artifact prepare(
    String transferId,
    String deviceId,
    String rootId,
    List<ArchiveModel.Source> sources,
    ArchiveControl control,
    ArchiveModel.Progress progress
  ) throws ArchiveFailure {
    ArchiveModel.require(
      DocumentValues.isId(transferId) &&
        DocumentValues.isId(deviceId) &&
        DocumentValues.isId(rootId) &&
        sources != null &&
        !sources.isEmpty() &&
        control != null
    );
    ArchiveModel.limit(sources.size() <= limits.files);
    ArchiveCache.Job job = begin(control);
    try {
      for (ArchiveModel.Source source : sources) {
        ArchiveModel.require(source != null);
        source.validateRoot(rootId);
      }
      emit(progress, "preparing", 0, null, control);
      AtomicLong copied = new AtomicLong();
      List<ArchiveModel.PreparedFile> files = readSources(job, sources, copied, control, progress);
      Set<String> entries = new HashSet<>();
      long tarSize = 1024;
      for (ArchiveModel.PreparedFile file : files) {
        ArchiveModel.require(entries.add(file.sourceEntryId));
        tarSize += 512 + ArchiveModel.padded(file.sizeBytes);
        ArchiveModel.limit(tarSize <= limits.tar);
      }
      // 预检包含压缩体可能与原文重叠的实际容量；之后每次写入仍执行硬计数和空间检查。
      emit(progress, "archiving", 0, tarSize, control);
      HashedOutput packed = new HashedOutput(job.create("archive.gz", limits.archive, control));
      try (
        OutputStream output = packed;
        ArchiveFormat.GzipWriter gzip = new ArchiveFormat.GzipWriter(output)
      ) {
        byte[] buffer = new byte[ArchiveModel.BUFFER];
        long written = 0;
        for (ArchiveModel.PreparedFile file : files) {
          gzip.write(ArchiveFormat.header(file.fileId, file.sizeBytes));
          written += 512;
          MessageDigest hash = ArchiveFormat.sha256();
          long size = 0;
          try (InputStream input = job.open(file.fileId, control)) {
            int n;
            while ((n = read(input, buffer, control)) != -1) {
              if (size > file.sizeBytes - n) {
                throw mismatch();
              }
              gzip.write(buffer, 0, n);
              hash.update(buffer, 0, n);
              size += n;
              written += n;
              emit(progress, "archiving", written, tarSize, control);
            }
          }
          if (size != file.sizeBytes || !ArchiveFormat.hex(hash.digest()).equals(file.sha256)) {
            throw mismatch();
          }
          int padding = (int) (ArchiveModel.padded(size) - size);
          gzip.write(new byte[padding]);
          written += padding;
        }
        gzip.write(new byte[1024]);
        written += 1024;
        emit(progress, "archiving", written, tarSize, control);
      }
      ArchiveModel.Manifest manifest = new ArchiveModel.Manifest(
        transferId,
        deviceId,
        rootId,
        files,
        copied.get(),
        new ArchiveModel.Descriptor(packed.count, tarSize, packed.digest())
      );
      manifest.validate(limits);
      control.check();
      return new Artifact(job, manifest, control);
    } catch (Exception cause) {
      throw failed(job, control, cause);
    }
  }

  /** 接管并关闭输入；先保存并校验完整压缩体，再逐项解包校验，全部成功才返回句柄。 */
  Artifact receive(
    ArchiveModel.Manifest manifest,
    InputStream source,
    ArchiveControl control,
    ArchiveModel.Progress progress
  ) throws ArchiveFailure {
    ArchiveModel.require(source != null && control != null);
    ArchiveCache.Job job = null;
    try (InputStream input = source) {
      ArchiveModel.require(manifest != null);
      manifest.validate(limits);
      job = begin(control);
      control.track(input);
      job.space(manifest.archive.sizeBytes + manifest.totalFileBytes);
      MessageDigest hash = ArchiveFormat.sha256();
      long size = 0;
      byte[] buffer = new byte[ArchiveModel.BUFFER];
      emit(progress, "receiving", 0, manifest.archive.sizeBytes, control);
      try (OutputStream out = job.create("archive.gz", limits.archive, control)) {
        int n;
        while ((n = read(input, buffer, control)) != -1) {
          ArchiveModel.limit(size <= limits.archive - n);
          if (size > manifest.archive.sizeBytes - n) {
            throw mismatch();
          }
          out.write(buffer, 0, n);
          hash.update(buffer, 0, n);
          size += n;
          emit(progress, "receiving", size, manifest.archive.sizeBytes, control);
        }
      }
      if (
        size != manifest.archive.sizeBytes ||
        !ArchiveFormat.hex(hash.digest()).equals(manifest.archive.sha256)
      ) {
        throw mismatch();
      }
      control.untrack(input);
      emit(progress, "verifying", 0, manifest.totalFileBytes, control);
      try (
        InputStream compressed = job.open("archive.gz", control);
        ArchiveFormat.GzipReader tar = new ArchiveFormat.GzipReader(compressed, limits.tar, control)
      ) {
        long completed = 0;
        for (ArchiveModel.PreparedFile file : manifest.files) {
          byte[] header = new byte[512];
          ArchiveFormat.exact(tar, header, 512, control);
          if (!Arrays.equals(header, ArchiveFormat.header(file.fileId, file.sizeBytes))) {
            throw ArchiveFormat.invalid(
              "A tar header, order, type, length, or field does not match the manifest."
            );
          }
          MessageDigest contentHash = ArchiveFormat.sha256();
          long remaining = file.sizeBytes;
          try (OutputStream out = job.create(file.fileId, limits.file, control)) {
            while (remaining > 0) {
              int n = (int) Math.min(buffer.length, remaining);
              ArchiveFormat.exact(tar, buffer, n, control);
              out.write(buffer, 0, n);
              contentHash.update(buffer, 0, n);
              remaining -= n;
              completed += n;
              ArchiveModel.limit(completed <= limits.total);
              emit(progress, "verifying", completed, manifest.totalFileBytes, control);
            }
          }
          if (!ArchiveFormat.hex(contentHash.digest()).equals(file.sha256)) {
            throw mismatch();
          }
          int padding = (int) (ArchiveModel.padded(file.sizeBytes) - file.sizeBytes);
          ArchiveFormat.exact(tar, buffer, padding, control);
          ArchiveFormat.zeros(buffer, padding);
        }
        ArchiveFormat.exact(tar, buffer, 1024, control);
        ArchiveFormat.zeros(buffer, 1024);
        if (tar.read() != -1) {
          throw ArchiveFormat.invalid("Extra records follow the end of the tar archive.");
        }
        emit(progress, "verifying", completed, manifest.totalFileBytes, control);
      }
      control.check();
      return new Artifact(job, manifest, control);
    } catch (Exception cause) {
      if (job == null) {
        throw ArchiveFailure.from(cause);
      }
      throw failed(job, control, cause);
    } finally {
      control.untrack(source);
    }
  }

  private synchronized ArchiveCache.Job begin(ArchiveControl control) throws ArchiveFailure {
    try {
      control.check();
      ArchiveCache.Job job = cache.begin(limits.cache);
      owned = job;
      current = control;
      return job;
    } catch (Exception cause) {
      throw ArchiveFailure.from(cause);
    }
  }

  private ArchiveFailure failed(ArchiveCache.Job job, ArchiveControl control, Exception cause) {
    ArchiveFailure failure = ArchiveFailure.from(cause);
    try {
      control.check();
    } catch (ArchiveFailure cancellation) {
      cancellation.addSuppressed(failure);
      failure = cancellation;
    }
    try {
      dispose(job);
    } catch (IOException cleanup) {
      failure.cleanupFailure = ArchiveCache.cleanup(cleanup);
    }
    return failure;
  }

  private synchronized void dispose(ArchiveCache.Job job) throws IOException {
    job.dispose();
    if (owned == job) {
      owned = null;
      current = null;
    }
  }

  /** 关闭当前归档的读流并取消 SAF 查询；缓存在工作线程结束后清理。 */
  void cancel() {
    ArchiveControl control = current;
    if (control != null) {
      control.cancel();
    }
  }

  /** 重试本实例拥有的任务的清理；调用前必须等工作线程结束并关闭句柄读流。 */
  synchronized void retryCleanup() throws IOException {
    if (owned != null) {
      dispose(owned);
    }
  }

  /**
   * 把每个源文件读进缓存，最多同时读 READ_THREADS 个；按 sources 的顺序返回结果。
   *
   * <p>进度只在调用线程报告。任一文件失败后不再开始新的文件，等已开始的结束后抛出第一个失败。
   */
  private List<ArchiveModel.PreparedFile> readSources(
    ArchiveCache.Job job,
    List<ArchiveModel.Source> sources,
    AtomicLong copied,
    ArchiveControl control,
    ArchiveModel.Progress progress
  ) throws Exception {
    // 经 SAF 打开一个文件要几十毫秒，主要在等提供者；同时读几个，几百个文件的打包能快几倍。
    ArchiveModel.PreparedFile[] files = new ArchiveModel.PreparedFile[sources.size()];
    AtomicReference<Exception> failure = new AtomicReference<>();
    ExecutorService readers = Executors.newFixedThreadPool(Math.min(READ_THREADS, sources.size()));
    try {
      List<Future<Object>> tasks = new ArrayList<>();
      for (int i = 0; i < sources.size(); i++) {
        int index = i;
        tasks.add(
          readers.submit(() -> {
            if (failure.get() == null) {
              try {
                files[index] = readSource(
                  job,
                  sources.get(index),
                  ArchiveModel.id(index),
                  copied,
                  control
                );
              } catch (Exception cause) {
                failure.compareAndSet(null, cause);
              }
            }
            return null;
          })
        );
      }
      long reported = 0;
      for (Future<Object> task : tasks) {
        for (boolean isDone = false; !isDone; ) {
          try {
            task.get(100, TimeUnit.MILLISECONDS);
            isDone = true;
          } catch (TimeoutException waiting) {
            // 大文件读取期间也要更新进度。
          }
          long current = copied.get();
          if (current != reported && failure.get() == null) {
            try {
              emit(progress, "preparing", current, null, control);
            } catch (Exception cause) {
              failure.compareAndSet(null, cause);
            }
            reported = current;
          }
        }
      }
    } finally {
      readers.shutdownNow();
    }
    if (failure.get() != null) {
      throw failure.get();
    }
    return Arrays.asList(files);
  }

  /** 把一个源文件读进缓存文件 id，同时计算 SHA-256；可以在多个线程同时调用。 */
  private ArchiveModel.PreparedFile readSource(
    ArchiveCache.Job job,
    ArchiveModel.Source source,
    String id,
    AtomicLong copied,
    ArchiveControl control
  ) throws Exception {
    control.check();
    ArchiveModel.Observation before = source.observe(control);
    ArchiveModel.require(before != null);
    before.validate();
    if (before.size != null) {
      ArchiveModel.limit(before.size <= limits.file && before.size <= limits.total - copied.get());
      job.space(before.size);
    }
    MessageDigest hash = ArchiveFormat.sha256();
    long size = 0;
    InputStream input = control.track(source.open(control));
    try (InputStream stream = input; OutputStream out = job.create(id, limits.file, control)) {
      byte[] buffer = new byte[ArchiveModel.BUFFER];
      int n;
      while ((n = read(stream, buffer, control)) != -1) {
        ArchiveModel.limit(size <= limits.file - n && copied.addAndGet(n) <= limits.total);
        out.write(buffer, 0, n);
        hash.update(buffer, 0, n);
        size += n;
      }
    } finally {
      control.untrack(input);
    }
    ArchiveModel.Observation after = source.observe(control);
    if (!before.same(after) || (before.size != null && before.size != size)) {
      throw new ArchiveFailure(
        "source-changed",
        "The source file changed during archive preparation."
      );
    }
    return new ArchiveModel.PreparedFile(id, before, size, ArchiveFormat.hex(hash.digest()));
  }

  private static int read(InputStream stream, byte[] buffer, ArchiveControl control)
    throws IOException {
    control.check();
    int n = stream.read(buffer);
    control.check();
    if (n == 0) {
      throw new ArchiveFailure("io-failure", "The input stream made no read progress.");
    }
    return n;
  }

  private static void emit(
    ArchiveModel.Progress progress,
    String stage,
    long count,
    Long total,
    ArchiveControl control
  ) throws Exception {
    control.check();
    if (progress != null) {
      progress.update(stage, count, total);
    }
    control.check();
  }

  private static ArchiveFailure mismatch() {
    return new ArchiveFailure(
      "checksum-mismatch",
      "The archive or uncompressed content length/hash does not match."
    );
  }

  /** 归档句柄：清单不可变，读流由调用方关闭，dispose 失败后可以再次调用。 */
  final class Artifact implements AutoCloseable {

    final ArchiveModel.Manifest manifest;
    private final ArchiveCache.Job job;
    private final ArchiveControl control;

    Artifact(ArchiveCache.Job job, ArchiveModel.Manifest manifest, ArchiveControl control) {
      this.job = job;
      this.manifest = manifest;
      this.control = control;
    }

    InputStream openArchive() throws IOException {
      return job.open("archive.gz", control);
    }

    InputStream openFile(String fileId) throws IOException {
      for (ArchiveModel.PreparedFile file : manifest.files) {
        if (file.fileId.equals(fileId)) {
          return job.open(fileId, control);
        }
      }
      throw new ArchiveFailure(
        "invalid-request",
        "The file reference does not belong to this archive manifest."
      );
    }

    @Override
    public void close() throws IOException {
      dispose(job);
    }
  }

  /** 解包到私有缓存的文件。读流由调用方关闭，close 失败后可以再次调用。 */
  final class Staged implements AutoCloseable {

    private final ArchiveCache.Job job;
    private final List<String> ids;
    private final ArchiveControl control;

    Staged(ArchiveCache.Job job, List<String> ids, ArchiveControl control) {
      this.job = job;
      this.ids = ids;
      this.control = control;
    }

    InputStream openFile(String fileId) throws IOException {
      if (!ids.contains(fileId)) {
        throw new ArchiveFailure("invalid-request", "The file does not belong to this content.");
      }
      return job.open(fileId, control);
    }

    @Override
    public void close() throws IOException {
      dispose(job);
    }
  }

  /** 转发写入并记下写入是否失败。close 只刷新缓冲，下层的流保持打开。 */
  private static final class Sink extends FilterOutputStream {

    volatile boolean hasFailed;

    Sink(OutputStream output) {
      super(output);
    }

    @Override
    public void write(int value) throws IOException {
      write(new byte[] { (byte) value }, 0, 1);
    }

    @Override
    public void write(byte[] bytes, int offset, int length) throws IOException {
      try {
        out.write(bytes, offset, length);
      } catch (IOException | RuntimeException cause) {
        hasFailed = true;
        throw cause;
      }
    }

    @Override
    public void flush() throws IOException {
      try {
        out.flush();
      } catch (IOException | RuntimeException cause) {
        hasFailed = true;
        throw cause;
      }
    }

    @Override
    public void close() throws IOException {
      flush();
    }
  }

  private static final class HashedOutput extends FilterOutputStream {

    private final MessageDigest hash = ArchiveFormat.sha256();
    private long count;

    HashedOutput(OutputStream output) {
      super(output);
    }

    @Override
    public void write(int value) throws IOException {
      write(new byte[] { (byte) value });
    }

    @Override
    public void write(byte[] bytes, int offset, int length) throws IOException {
      out.write(bytes, offset, length);
      hash.update(bytes, offset, length);
      count += length;
    }

    String digest() {
      return ArchiveFormat.hex(hash.digest());
    }
  }
}
