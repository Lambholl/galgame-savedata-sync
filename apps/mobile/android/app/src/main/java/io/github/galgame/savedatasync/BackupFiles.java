package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.bytes;
import static io.github.galgame.savedatasync.TransferJson.parse;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Objects;

/** 备份文件的身份检查、严格 JSON 和落盘操作；原文都通过 64 KiB 的流处理。 */
final class BackupFiles {

  interface Io {
    default Object identity(Path path, BasicFileAttributes value) throws Exception {
      if (value.fileKey() == null) {
        throw failure("unsupported-operation");
      }
      return value.fileKey();
    }

    default Long available(Path path) throws Exception {
      return path.toFile().getUsableSpace();
    }

    default long links(Path path) throws Exception {
      return (
        (Number) Files.getAttribute(path, "unix:nlink", LinkOption.NOFOLLOW_LINKS)
      ).longValue();
    }

    default void beforeWrite(Path path, int bytes) throws Exception {}

    default void sync(FileChannel channel) throws Exception {
      channel.force(true);
    }

    default void delete(Path path) throws Exception {
      Files.delete(path);
    }
  }

  private final Io io;

  BackupFiles(Io io) {
    this.io = io;
  }

  private static final class Attributes implements BasicFileAttributes {

    private final BasicFileAttributes value;
    private final Object key;

    Attributes(BasicFileAttributes value, Object key) {
      this.value = value;
      this.key = key;
    }

    public java.nio.file.attribute.FileTime lastModifiedTime() {
      return value.lastModifiedTime();
    }

    public java.nio.file.attribute.FileTime lastAccessTime() {
      return value.lastAccessTime();
    }

    public java.nio.file.attribute.FileTime creationTime() {
      return value.creationTime();
    }

    public boolean isRegularFile() {
      return value.isRegularFile();
    }

    public boolean isDirectory() {
      return value.isDirectory();
    }

    public boolean isSymbolicLink() {
      return value.isSymbolicLink();
    }

    public boolean isOther() {
      return value.isOther();
    }

    public long size() {
      return value.size();
    }

    public Object fileKey() {
      return key;
    }
  }

  BasicFileAttributes inspect(Path path) throws Exception {
    if (!path.isAbsolute() || !path.normalize().equals(path)) {
      throw failure("path-outside-root");
    }
    for (Path current = path; current != null; current = current.getParent()) {
      if (Files.isSymbolicLink(current)) {
        throw failure("path-outside-root");
      }
    }
    BasicFileAttributes value;
    try {
      value = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    } catch (NoSuchFileException removed) {
      throw failure("not-found");
    }
    Object identity = io.identity(path, value);
    if (identity == null || value.isSymbolicLink()) {
      throw failure("unsupported-operation");
    }
    return new Attributes(value, identity);
  }

  Object directory(Path path) throws Exception {
    BasicFileAttributes value = inspect(path);
    if (!value.isDirectory()) {
      throw failure("path-outside-root");
    }
    return value.fileKey();
  }

  BasicFileAttributes regular(Path path, long maximum) throws Exception {
    BasicFileAttributes value = inspect(path);
    if (!value.isRegularFile() || value.size() > maximum || io.links(path) != 1) {
      throw failure("path-outside-root");
    }
    return value;
  }

  void same(Path path, BasicFileAttributes before, long maximum) throws Exception {
    BasicFileAttributes after = regular(path, maximum);
    if (
      !Objects.equals(before.fileKey(), after.fileKey()) ||
      before.size() != after.size() ||
      !before.lastModifiedTime().equals(after.lastModifiedTime())
    ) {
      throw failure("source-changed");
    }
  }

  InputStream reader(Path path, long maximum) throws Exception {
    BasicFileAttributes before = regular(path, maximum);
    InputStream input = Files.newInputStream(
      path,
      StandardOpenOption.READ,
      LinkOption.NOFOLLOW_LINKS
    );
    try {
      same(path, before, maximum);
      return input;
    } catch (Exception cause) {
      input.close();
      throw cause;
    }
  }

  Object readJson(Path path) throws Exception {
    BasicFileAttributes before = regular(path, TransferJson.MAX_BYTES);
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    byte[] buffer = new byte[65536];
    try (InputStream input = reader(path, TransferJson.MAX_BYTES)) {
      for (int count; (count = input.read(buffer)) != -1; ) {
        if (bytes.size() + count > TransferJson.MAX_BYTES) {
          throw failure("resource-limit");
        }
        bytes.write(buffer, 0, count);
      }
    }
    same(path, before, TransferJson.MAX_BYTES);
    return parse(bytes.toByteArray());
  }

  void writeJson(Path path, Object value) throws Exception {
    byte[] data = bytes(value);
    try (FileChannel output = writer(path)) {
      write(output, path, data, data.length);
      io.sync(output);
    }
  }

  FileChannel writer(Path path) throws Exception {
    directory(path.getParent());
    return FileChannel.open(
      path,
      StandardOpenOption.CREATE_NEW,
      StandardOpenOption.WRITE,
      LinkOption.NOFOLLOW_LINKS
    );
  }

  void write(FileChannel output, Path path, byte[] buffer, int count) throws Exception {
    io.beforeWrite(path, count);
    ByteBuffer bytes = ByteBuffer.wrap(buffer, 0, count);
    while (bytes.hasRemaining()) {
      if (output.write(bytes) == 0) {
        throw failure("io-failure");
      }
    }
  }

  void sync(FileChannel output) throws Exception {
    io.sync(output);
  }

  void move(Path source, Path target, boolean shouldReplace) throws Exception {
    regular(source, TransferJson.MAX_BYTES);
    directory(target.getParent());
    if (!shouldReplace && Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
      throw failure("source-changed");
    }
    if (shouldReplace) {
      Files.move(
        source,
        target,
        StandardCopyOption.ATOMIC_MOVE,
        StandardCopyOption.REPLACE_EXISTING
      );
    } else {
      Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
    }
  }

  void delete(Path path, long maximum) throws Exception {
    regular(path, maximum);
    io.delete(path);
  }

  void deleteDirectory(Path path) throws Exception {
    directory(path);
    io.delete(path);
  }

  Long space(Path root, long required) throws Exception {
    if (required < 0) {
      throw failure("invalid-request");
    }
    Long available = io.available(root);
    if (available != null && available < required) {
      throw failure("insufficient-space");
    }
    return available;
  }

  static ArchiveFailure failure(String code) {
    String message;
    switch (code) {
      case "source-changed":
        message = "The backup or a file in the target folder changed. Scan again.";
        break;
      case "checksum-mismatch":
        message = "Backup content verification failed.";
        break;
      case "insufficient-space":
        message = "Space is insufficient for a backup before writing.";
        break;
      case "cleanup-failed":
        message = "Backup rotation or leftover cleanup failed.";
        break;
      case "busy":
        message = "The backup is in use or the store is closed.";
        break;
      case "not-found":
        message = "The backup or file reference does not exist.";
        break;
      case "permission-denied":
        message = "Backup ownership or directory permission is invalid.";
        break;
      case "unsupported-operation":
        message = "Storage does not support the required backup operations.";
        break;
      case "resource-limit":
        message = "The backup exceeds entry, path, or capacity limits.";
        break;
      case "path-outside-root":
        message = "A backup file identity, type, or link is invalid.";
        break;
      default:
        message = "Backup data or local I/O failed.";
    }
    return new ArchiveFailure(code, message);
  }
}
