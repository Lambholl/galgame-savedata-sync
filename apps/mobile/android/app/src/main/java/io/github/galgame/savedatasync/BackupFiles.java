package io.github.galgame.savedatasync;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Objects;
import static io.github.galgame.savedatasync.TransferJson.*;

/** 私有文件的身份、严格 JSON 和落盘操作；原文始终通过 64 KiB 原生流处理。 */
final class BackupFiles {
    interface Io {
        default Object identity(Path path, BasicFileAttributes value) throws Exception {
            if (value.fileKey() == null) throw failure("unsupported-operation");
            return value.fileKey();
        }
        default Long available(Path path) throws Exception { return path.toFile().getUsableSpace(); }
        default long links(Path path) throws Exception { return ((Number) Files.getAttribute(path, "unix:nlink", LinkOption.NOFOLLOW_LINKS)).longValue(); }
        default void beforeWrite(Path path, int bytes) throws Exception {}
        default void sync(FileChannel channel) throws Exception { channel.force(true); }
        default void delete(Path path) throws Exception { Files.delete(path); }
    }
    private final Io io;
    BackupFiles(Io io) { this.io = io; }
    private static final class Attributes implements BasicFileAttributes {
        private final BasicFileAttributes value;
        private final Object key;
        Attributes(BasicFileAttributes value, Object key) { this.value = value; this.key = key; }
        public java.nio.file.attribute.FileTime lastModifiedTime() { return value.lastModifiedTime(); }
        public java.nio.file.attribute.FileTime lastAccessTime() { return value.lastAccessTime(); }
        public java.nio.file.attribute.FileTime creationTime() { return value.creationTime(); }
        public boolean isRegularFile() { return value.isRegularFile(); }
        public boolean isDirectory() { return value.isDirectory(); }
        public boolean isSymbolicLink() { return value.isSymbolicLink(); }
        public boolean isOther() { return value.isOther(); }
        public long size() { return value.size(); }
        public Object fileKey() { return key; }
    }

    BasicFileAttributes inspect(Path path) throws Exception {
        if (!path.isAbsolute() || !path.normalize().equals(path)) throw failure("path-outside-root");
        for (Path current = path; current != null; current = current.getParent()) {
            if (Files.isSymbolicLink(current)) throw failure("path-outside-root");
        }
        BasicFileAttributes value = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        Object identity = io.identity(path, value);
        if (identity == null || value.isSymbolicLink()) throw failure("unsupported-operation");
        return new Attributes(value, identity);
    }
    Object directory(Path path) throws Exception {
        BasicFileAttributes value = inspect(path);
        if (!value.isDirectory()) throw failure("path-outside-root");
        return value.fileKey();
    }
    BasicFileAttributes regular(Path path, long maximum) throws Exception {
        BasicFileAttributes value = inspect(path);
        if (!value.isRegularFile() || value.size() > maximum || io.links(path) != 1) throw failure("path-outside-root");
        return value;
    }
    void same(Path path, BasicFileAttributes before, long maximum) throws Exception {
        BasicFileAttributes after = regular(path, maximum);
        if (!Objects.equals(before.fileKey(), after.fileKey()) || before.size() != after.size() ||
            !before.lastModifiedTime().equals(after.lastModifiedTime())) throw failure("source-changed");
    }
    InputStream reader(Path path, long maximum) throws Exception {
        BasicFileAttributes before = regular(path, maximum);
        InputStream input = Files.newInputStream(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS);
        try {
            same(path, before, maximum);
            return input;
        } catch (Exception cause) { input.close(); throw cause; }
    }
    Object readJson(Path path) throws Exception {
        BasicFileAttributes before = regular(path, TransferJson.MAX_BYTES);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[65536];
        try (InputStream input = reader(path, TransferJson.MAX_BYTES)) {
            for (int count; (count = input.read(buffer)) != -1;) {
                if (bytes.size() + count > TransferJson.MAX_BYTES) throw failure("resource-limit");
                bytes.write(buffer, 0, count);
            }
        }
        same(path, before, TransferJson.MAX_BYTES);
        return parse(bytes.toByteArray());
    }
    void writeJson(Path path, Object value) throws Exception {
        byte[] data = bytes(value);
        try (FileChannel output = writer(path)) {
            write(output, path, data, data.length); io.sync(output);
        }
    }
    FileChannel writer(Path path) throws Exception {
        directory(path.getParent());
        return FileChannel.open(path, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
    }
    void write(FileChannel output, Path path, byte[] buffer, int count) throws Exception {
        io.beforeWrite(path, count); ByteBuffer bytes = ByteBuffer.wrap(buffer, 0, count);
        while (bytes.hasRemaining()) if (output.write(bytes) == 0) throw failure("io-failure");
    }
    void sync(FileChannel output) throws Exception { io.sync(output); }
    void move(Path source, Path target, boolean replace) throws Exception {
        regular(source, TransferJson.MAX_BYTES); directory(target.getParent());
        if (!replace && Files.exists(target, LinkOption.NOFOLLOW_LINKS)) throw failure("source-changed");
        if (replace) Files.move(source, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        else Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
    }
    void delete(Path path, long maximum) throws Exception { regular(path, maximum); io.delete(path); }
    void deleteDirectory(Path path) throws Exception { directory(path); io.delete(path); }
    Long space(Path root, long required) throws Exception {
        if (required < 0) throw failure("invalid-request");
        Long available = io.available(root);
        if (available != null && available < required) throw failure("insufficient-space");
        return available;
    }
    static ArchiveFailure failure(String code) {
        String message;
        switch (code) {
            case "source-changed": message = "备份或被覆盖的文件已变化，请重新扫描"; break;
            case "checksum-mismatch": message = "备份内容校验失败"; break;
            case "insufficient-space": message = "覆盖前备份空间不足"; break;
            case "cleanup-failed": message = "备份轮换或残留清理失败"; break;
            case "busy": message = "备份正在使用或存储已关闭"; break;
            case "not-found": message = "备份或文件引用不存在"; break;
            case "permission-denied": message = "备份归属或目录权限无效"; break;
            case "unsupported-operation": message = "存储不支持所需的备份操作"; break;
            case "resource-limit": message = "备份超过条目、路径或容量限制"; break;
            case "path-outside-root": message = "备份文件身份、类型或链接无效"; break;
            default: message = "备份数据或本地读写失败";
        }
        return new ArchiveFailure(code, message);
    }
}
