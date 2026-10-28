package io.github.galgame.savedatasync;

import java.io.FilterInputStream;
import java.io.FileOutputStream;
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
 * 固定私有根中的带标记任务缓存；只允许应用内部传入 Context.getCacheDir 的子目录。
 * 进程中一次仅一个任务，句柄和未闭合清理都占名额；不恢复结果或继续旧任务。
 * 测试钩子只能由受信任原生测试注入，不能来自桥/清单。无恶意并发命名空间隔离承诺。
 */
final class ArchiveCache {
    interface Io {
        default long usable(Path path) { return path.toFile().getUsableSpace(); }
        default void beforeWrite(Path path, int count) throws IOException {}
        default void beforeDelete(Path path) throws IOException {}
    }
    private static Job active;
    final Path root;
    private final String owner;
    private final Object rootKey;
    private final Io io;

    ArchiveCache(Path privateDirectory) throws IOException { this(privateDirectory, new Io() {}); }
    ArchiveCache(Path privateDirectory, Io io) throws IOException {
        synchronized (ArchiveCache.class) {
            if (active != null) throw new ArchiveFailure("busy", "已有归档任务或待清理缓存");
            Path parent = privateDirectory.toAbsolutePath().normalize();
            verifyChain(parent);
            if (!Files.isDirectory(parent, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Private root missing");
            root = parent.resolve("transfer-archives-v1");
            this.io = io;
            if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) {
                Files.createDirectory(root);
                Files.write(root.resolve("owner"), ("savedata-archive-v1:" + UUID.randomUUID()).getBytes(StandardCharsets.US_ASCII),
                    StandardOpenOption.CREATE_NEW);
            }
            rootKey = directoryKey(root);
            owner = marker(root.resolve("owner"));
            if (!owner.matches("savedata-archive-v1:[a-f0-9-]{36}")) throw cleanup(null);
            List<Job> orphans = new ArrayList<>();
            try (DirectoryStream<Path> paths = Files.newDirectoryStream(root)) {
                for (Path path : paths) {
                    String name = path.getFileName().toString();
                    if (name.equals("owner")) continue;
                    if (!name.matches("job-[a-f0-9-]{36}")) throw cleanup(null);
                    Job job = new Job(path, name.substring(4), directoryKey(path), Long.MAX_VALUE);
                    job.orphan = true;
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

    /** 接收内容前检查本批缓存峰值，不创建任务目录或预留空间。 */
    void checkSpace(long required) throws IOException {
        verifyRoot();
        if (required < 0) throw new ArchiveFailure("invalid-request", "空间预检字节数无效");
        if (io.usable(root) < required) throw new ArchiveFailure("insufficient-space", "私有存储可用空间不足");
    }

    Job begin(long maximum) throws IOException {
        synchronized (ArchiveCache.class) {
            if (active != null) throw new ArchiveFailure("busy", "已有归档任务或待清理缓存");
            verifyRoot();
            String token = UUID.randomUUID().toString();
            Path path = root.resolve("job-" + token);
            Files.createDirectory(path);
            Job job = new Job(path, token, directoryKey(path), maximum);
            active = job;
            try {
                Files.write(path.resolve("owner"), (owner + ":" + token).getBytes(StandardCharsets.US_ASCII), StandardOpenOption.CREATE_NEW);
                return job;
            } catch (IOException failure) {
                // 标记尚未建立的目录只允许当前创建者直接删除，不能在重启后猜测归属。
                try { Files.delete(path); active = null; }
                catch (IOException cleanupError) { failure.addSuppressed(cleanupError); }
                throw failure;
            }
        }
    }

    /** 启动恢复清理失败时仅重试已核实的孤儿；不关闭当前活动调用者的任务。 */
    static void retryOrphanCleanup() throws IOException {
        Job job;
        synchronized (ArchiveCache.class) { job = active; }
        if (job != null && job.orphan) job.dispose();
    }

    private static void verifyChain(Path path) throws IOException {
        for (Path current = path; current != null; current = current.getParent()) {
            if (Files.isSymbolicLink(current)) throw cleanup(null);
        }
    }
    private static Object directoryKey(Path path) throws IOException {
        BasicFileAttributes attributes = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!attributes.isDirectory() || attributes.isSymbolicLink()) throw cleanup(null);
        return attributes.fileKey();
    }
    private static void regular(Path path) throws IOException {
        if (!Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS).isRegularFile()) throw cleanup(null);
    }
    private static String marker(Path path) throws IOException {
        regular(path);
        if (Files.size(path) > 256) throw cleanup(null);
        return new String(Files.readAllBytes(path), StandardCharsets.US_ASCII);
    }
    private void verifyRoot() throws IOException {
        verifyChain(root);
        if (!Objects.equals(rootKey, directoryKey(root)) || !owner.equals(marker(root.resolve("owner")))) throw cleanup(null);
    }
    static ArchiveFailure cleanup(Throwable cause) {
        return new ArchiveFailure("cleanup-failed", "私有缓存归属无法确认或清理失败", false, cause);
    }

    /** 句柄只允许通过归档 API 访问；调用者必须关闭读流再 dispose，可重复/重试清理。 */
    final class Job {
        private final Path path;
        private final String token;
        private final Object key;
        private final long maximum;
        private final Set<InputStream> readers = new HashSet<>();
        private long bytes;
        private boolean disposed, markerRemoved;
        private boolean orphan;

        Job(Path path, String token, Object key, long maximum) {
            this.path = path; this.token = token; this.key = key; this.maximum = maximum;
        }
        private void alive() throws IOException {
            if (disposed || active != this) throw new ArchiveFailure("task-conflict", "归档句柄已关闭或不属于当前任务");
            verifyRoot();
            if (!Objects.equals(key, directoryKey(path))) throw cleanup(null);
            if (!markerRemoved && !(owner + ":" + token).equals(marker(path.resolve("owner")))) throw cleanup(null);
        }
        private Path file(String name) throws ArchiveFailure {
            if (!name.equals("archive.gz") && !name.matches("f00[0-9]{4}")) {
                throw new ArchiveFailure("invalid-request", "缓存文件引用无效");
            }
            return path.resolve(name);
        }
        private void verify() throws IOException {
            verifyRoot();
            if (!Objects.equals(key, directoryKey(path)) || !(owner + ":" + token).equals(marker(path.resolve("owner")))) throw cleanup(null);
            entries();
        }
        private List<Path> entries() throws IOException {
            List<Path> result = new ArrayList<>();
            try (DirectoryStream<Path> paths = Files.newDirectoryStream(path)) {
                for (Path item : paths) {
                    if (item.getFileName().toString().equals("owner")) continue;
                    file(item.getFileName().toString());
                    regular(item);
                    result.add(item);
                }
            }
            return result;
        }
        void space(long required) throws IOException {
            alive();
            ArchiveModel.limit(required <= maximum - bytes);
            if (io.usable(path) < required) throw new ArchiveFailure("insufficient-space", "私有存储可用空间不足");
        }
        OutputStream create(String name, long limit, ArchiveControl control) throws IOException {
            alive();
            Path target = file(name);
            Files.createFile(target);
            FileOutputStream out = new FileOutputStream(target.toFile());
            return new OutputStream() {
                private long count;
                private boolean closed;
                @Override public void write(int value) throws IOException { write(new byte[] { (byte) value }); }
                @Override public void write(byte[] buffer, int offset, int length) throws IOException {
                    if (closed) throw new IOException("Closed cache stream");
                    control.check();
                    ArchiveModel.limit(length <= ArchiveModel.BUFFER && count <= limit - length);
                    space(length);
                    io.beforeWrite(target, length);
                    out.write(buffer, offset, length);
                    count += length; bytes += length;
                }
                @Override public void close() throws IOException {
                    if (closed) return;
                    closed = true;
                    try { out.getFD().sync(); } finally { out.close(); }
                }
            };
        }
        synchronized InputStream open(String name, ArchiveControl control) throws IOException {
            alive();
            Path target = file(name);
            regular(target);
            InputStream raw = Files.newInputStream(target, LinkOption.NOFOLLOW_LINKS);
            InputStream tracked = new FilterInputStream(raw) {
                private boolean closed;
                @Override public int read() throws IOException { control.check(); return in.read(); }
                @Override public int read(byte[] buffer, int offset, int length) throws IOException {
                    control.check(); return in.read(buffer, offset, Math.min(length, ArchiveModel.BUFFER));
                }
                @Override public void close() throws IOException {
                    synchronized (Job.this) {
                        if (closed) return;
                        closed = true;
                        try { super.close(); } finally { readers.remove(this); control.untrack(this); }
                    }
                }
            };
            readers.add(tracked);
            return control.track(tracked);
        }
        synchronized void dispose() throws IOException {
            synchronized (ArchiveCache.class) {
                if (disposed) return;
                try {
                    alive();
                    if (!readers.isEmpty()) throw cleanup(null);
                    for (Path item : entries()) { io.beforeDelete(item); Files.delete(item); }
                    if (!markerRemoved) {
                        io.beforeDelete(path.resolve("owner")); Files.delete(path.resolve("owner")); markerRemoved = true;
                    }
                    io.beforeDelete(path); Files.delete(path);
                    disposed = true;
                    if (active == this) active = null;
                } catch (IOException failure) {
                    if (failure instanceof ArchiveFailure && ((ArchiveFailure) failure).code.equals("cleanup-failed")) throw failure;
                    throw cleanup(failure);
                }
            }
        }
    }
}
