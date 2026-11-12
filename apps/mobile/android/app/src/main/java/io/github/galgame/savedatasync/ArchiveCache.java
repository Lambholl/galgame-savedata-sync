package io.github.galgame.savedatasync;

import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * 私有目录下 transfer-archives-v1 里的任务缓存，根目录带所有者标记。
 * 进程中同时只有一个任务，句柄和未完成的清理都占名额；进程重启后不恢复之前的任务。
 */
final class ArchiveCache {

  interface Io {
    default long usable(Path path) {
      return path.toFile().getUsableSpace();
    }

    default void beforeWrite(Path path, int count) throws IOException {}

    default void beforeDelete(Path path) throws IOException {}
  }

  private static Job active;
  final Path root;
  private final String owner;
  private final Object rootKey;
  private final Io io;

  ArchiveCache(Path privateDirectory) throws IOException {
    this(privateDirectory, new Io() {});
  }

  ArchiveCache(Path privateDirectory, Io io) throws IOException {
    synchronized (ArchiveCache.class) {
      if (active != null) {
        throw new ArchiveFailure(
          "busy",
          "An archive task or cache awaiting cleanup already exists."
        );
      }
      Path parent = privateDirectory.toAbsolutePath().normalize();
      verifyChain(parent);
      if (!Files.isDirectory(parent, LinkOption.NOFOLLOW_LINKS)) {
        throw new IOException("Private root missing");
      }
      root = parent.resolve("transfer-archives-v1");
      this.io = io;
      if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) {
        Files.createDirectory(root);
        Files.write(
          root.resolve("owner"),
          ("savedata-archive-v1:" + UUID.randomUUID()).getBytes(StandardCharsets.US_ASCII),
          StandardOpenOption.CREATE_NEW
        );
      }
      rootKey = directoryKey(root);
      owner = marker(root.resolve("owner"));
      if (!owner.matches("savedata-archive-v1:[a-f0-9-]{36}")) {
        throw cleanup(null);
      }
      List<Job> orphans = new ArrayList<>();
      try (DirectoryStream<Path> paths = Files.newDirectoryStream(root)) {
        for (Path path : paths) {
          String name = path.getFileName().toString();
          if (name.equals("owner")) {
            continue;
          }
          if (!name.matches("job-[a-f0-9-]{36}")) {
            throw cleanup(null);
          }
          Job job = new Job(path, name.substring(4), directoryKey(path), Long.MAX_VALUE);
          job.isOrphan = true;
          job.verify();
          orphans.add(job);
        }
      }
      // 先核实所有目录，避免遇到未知条目时已删除部分未经确认的树。
      for (Job orphan : orphans) {
        active = orphan;
        orphan.dispose();
      }
    }
  }

  /** 检查缓存所在的卷能否放下 required 字节。 */
  void checkSpace(long required) throws IOException {
    verifyRoot();
    if (required < 0) {
      throw new ArchiveFailure("invalid-request", "The space preflight byte count is invalid.");
    }
    if (io.usable(root) < required) {
      throw new ArchiveFailure(
        "insufficient-space",
        "Private storage has insufficient free space."
      );
    }
  }

  Job begin(long maximum) throws IOException {
    synchronized (ArchiveCache.class) {
      if (active != null) {
        throw new ArchiveFailure(
          "busy",
          "An archive task or cache awaiting cleanup already exists."
        );
      }
      verifyRoot();
      String token = UUID.randomUUID().toString();
      Path path = root.resolve("job-" + token);
      Files.createDirectory(path);
      Job job = new Job(path, token, directoryKey(path), maximum);
      active = job;
      try {
        Files.write(
          path.resolve("owner"),
          (owner + ":" + token).getBytes(StandardCharsets.US_ASCII),
          StandardOpenOption.CREATE_NEW
        );
        return job;
      } catch (IOException failure) {
        // 标记尚未建立的目录只允许当前创建者直接删除，不能在重启后猜测归属。
        try {
          Files.delete(path);
          active = null;
        } catch (IOException cleanupError) {
          failure.addSuppressed(cleanupError);
        }
        throw failure;
      }
    }
  }

  /** 重试清理已核实的遗留任务；当前活动的任务保留。 */
  static void retryOrphanCleanup() throws IOException {
    Job job;
    synchronized (ArchiveCache.class) {
      job = active;
    }
    if (job != null && job.isOrphan) {
      job.dispose();
    }
  }

  private static void verifyChain(Path path) throws IOException {
    for (Path current = path; current != null; current = current.getParent()) {
      if (Files.isSymbolicLink(current)) {
        throw cleanup(null);
      }
    }
  }

  private static Object directoryKey(Path path) throws IOException {
    BasicFileAttributes attributes = Files.readAttributes(
      path,
      BasicFileAttributes.class,
      LinkOption.NOFOLLOW_LINKS
    );
    if (!attributes.isDirectory() || attributes.isSymbolicLink()) {
      throw cleanup(null);
    }
    return attributes.fileKey();
  }

  private static void regular(Path path) throws IOException {
    if (
      !Files.readAttributes(
        path,
        BasicFileAttributes.class,
        LinkOption.NOFOLLOW_LINKS
      ).isRegularFile()
    ) {
      throw cleanup(null);
    }
  }

  private static String marker(Path path) throws IOException {
    regular(path);
    if (Files.size(path) > 256) {
      throw cleanup(null);
    }
    return new String(Files.readAllBytes(path), StandardCharsets.US_ASCII);
  }

  private void verifyRoot() throws IOException {
    verifyChain(root);
    if (
      !Objects.equals(rootKey, directoryKey(root)) || !owner.equals(marker(root.resolve("owner")))
    ) {
      throw cleanup(null);
    }
  }

  static ArchiveFailure cleanup(Throwable cause) {
    return new ArchiveFailure(
      "cleanup-failed",
      "Private cache ownership cannot be confirmed or cleanup failed.",
      false,
      cause
    );
  }

  /** 一个缓存任务。关闭全部读流后才能 dispose，dispose 可以重复调用。 */
  final class Job {

    private final Path path;
    private final String token;
    private final Object key;
    private final long maximum;
    private final Set<InputStream> readers = new HashSet<>();
    private long bytes;
    private boolean isDisposed;
    private boolean isMarkerRemoved;
    private boolean isOrphan;

    Job(Path path, String token, Object key, long maximum) {
      this.path = path;
      this.token = token;
      this.key = key;
      this.maximum = maximum;
    }

    private void alive() throws IOException {
      if (isDisposed || active != this) {
        throw new ArchiveFailure(
          "task-conflict",
          "The archive handle is closed or does not belong to the current task."
        );
      }
      verifyRoot();
      if (!Objects.equals(key, directoryKey(path))) {
        throw cleanup(null);
      }
      if (!isMarkerRemoved && !(owner + ":" + token).equals(marker(path.resolve("owner")))) {
        throw cleanup(null);
      }
    }

    private Path file(String name) throws ArchiveFailure {
      if (!name.equals("archive.gz") && !name.matches("f00[0-9]{4}")) {
        throw new ArchiveFailure("invalid-request", "The cache file reference is invalid.");
      }
      return path.resolve(name);
    }

    private void verify() throws IOException {
      verifyRoot();
      if (
        !Objects.equals(key, directoryKey(path)) ||
        !(owner + ":" + token).equals(marker(path.resolve("owner")))
      ) {
        throw cleanup(null);
      }
      entries();
    }

    private List<Path> entries() throws IOException {
      List<Path> result = new ArrayList<>();
      try (DirectoryStream<Path> paths = Files.newDirectoryStream(path)) {
        for (Path item : paths) {
          if (item.getFileName().toString().equals("owner")) {
            continue;
          }
          file(item.getFileName().toString());
          regular(item);
          result.add(item);
        }
      }
      return result;
    }

    synchronized void space(long required) throws IOException {
      alive();
      ArchiveModel.limit(required <= maximum - bytes);
      if (io.usable(path) < required) {
        throw new ArchiveFailure(
          "insufficient-space",
          "Private storage has insufficient free space."
        );
      }
    }

    OutputStream create(String name, long limit, ArchiveControl control) throws IOException {
      alive();
      Path target = file(name);
      Files.createFile(target);
      FileOutputStream out = new FileOutputStream(target.toFile());
      return new OutputStream() {
        private long count;
        private boolean isClosed;

        @Override
        public void write(int value) throws IOException {
          write(new byte[] { (byte) value });
        }

        @Override
        public void write(byte[] buffer, int offset, int length) throws IOException {
          if (isClosed) {
            throw new IOException("Closed cache stream");
          }
          control.check();
          ArchiveModel.limit(length <= ArchiveModel.BUFFER && count <= limit - length);
          // 打包时多个线程同时写各自的缓存文件，任务总量要在锁内先记账再写。
          synchronized (Job.this) {
            space(length);
            bytes += length;
          }
          io.beforeWrite(target, length);
          out.write(buffer, offset, length);
          count += length;
        }

        @Override
        public void close() throws IOException {
          if (isClosed) {
            return;
          }
          isClosed = true;
          // 缓存文件只在本进程的这次任务里用，不单独落盘：进程或系统中断后任务本来就要重来。
          out.close();
        }
      };
    }

    synchronized InputStream open(String name, ArchiveControl control) throws IOException {
      alive();
      Path target = file(name);
      regular(target);
      InputStream raw = Files.newInputStream(target, LinkOption.NOFOLLOW_LINKS);
      InputStream tracked = new FilterInputStream(raw) {
        private boolean isClosed;

        @Override
        public int read() throws IOException {
          control.check();
          return in.read();
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
          control.check();
          return in.read(buffer, offset, Math.min(length, ArchiveModel.BUFFER));
        }

        @Override
        public void close() throws IOException {
          synchronized (Job.this) {
            if (isClosed) {
              return;
            }
            isClosed = true;
            try {
              super.close();
            } finally {
              readers.remove(this);
              control.untrack(this);
            }
          }
        }
      };
      readers.add(tracked);
      return control.track(tracked);
    }

    synchronized void dispose() throws IOException {
      synchronized (ArchiveCache.class) {
        if (isDisposed) {
          return;
        }
        try {
          alive();
          if (!readers.isEmpty()) {
            throw cleanup(null);
          }
          for (Path item : entries()) {
            io.beforeDelete(item);
            Files.delete(item);
          }
          if (!isMarkerRemoved) {
            io.beforeDelete(path.resolve("owner"));
            Files.delete(path.resolve("owner"));
            isMarkerRemoved = true;
          }
          io.beforeDelete(path);
          Files.delete(path);
          isDisposed = true;
          if (active == this) {
            active = null;
          }
        } catch (IOException failure) {
          if (
            failure instanceof ArchiveFailure &&
            ((ArchiveFailure) failure).code.equals("cleanup-failed")
          ) {
            throw failure;
          }
          throw cleanup(failure);
        }
      }
    }
  }
}
