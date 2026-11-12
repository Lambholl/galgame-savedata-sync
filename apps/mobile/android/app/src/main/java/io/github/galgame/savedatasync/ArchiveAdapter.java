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
      SafValues.isId(transferId) &&
        SafValues.isId(deviceId) &&
        SafValues.isId(rootId) &&
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
