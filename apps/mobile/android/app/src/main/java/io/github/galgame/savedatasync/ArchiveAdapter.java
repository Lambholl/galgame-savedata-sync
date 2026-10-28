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

/**
 * Java 原生归档入口；在单一后台 I/O 线程调用 prepare/receive，生命周期线程可调用 cancel。
 * 缓存参数只能由应用私有路径构造；输入均为已选择的只读源或已验证结构的原生清单。
 * 返回句柄占用进程任务名额，调用者必须关闭所有读流并 dispose；失败会清理，清理失败
 * 通过 cleanupFailure 独立报告且占用名额，需 retryCleanup。无 HTTP 或目标发布副作用。
 * 固定格式示例和用法见 ArchiveAdapterTest、ArchiveSafTest 及 apps/mobile/README.md。
 */
final class ArchiveAdapter {
    private final ArchiveCache cache;
    private final ArchiveModel.Limits limits;
    private volatile ArchiveControl current;
    private ArchiveCache.Job owned;

    ArchiveAdapter(ArchiveCache cache) { this(cache, new ArchiveModel.Limits()); }
    ArchiveAdapter(ArchiveCache cache, ArchiveModel.Limits limits) { this.cache = cache; this.limits = limits; }

    /** 清单确定后、打开 HTTP 内容流前检查压缩体与解包原文所需空间。 */
    void checkReceiveSpace(ArchiveModel.Manifest manifest) throws Exception {
        checkReceiveSpace(manifest, 0);
    }
    /** 原生调用者合并同卷目标增量与备份峰值；不向页面暴露私有路径。 */
    void checkReceiveSpace(ArchiveModel.Manifest manifest, long extraPrivateBytes) throws Exception {
        manifest.validate(limits);
        if (extraPrivateBytes < 0 || extraPrivateBytes > Long.MAX_VALUE - manifest.archive.sizeBytes - manifest.totalFileBytes) throw new ArchiveFailure("invalid-request", "空间预检字节数无效");
        cache.checkSpace(manifest.archive.sizeBytes + manifest.totalFileBytes + extraPrivateBytes);
    }
    java.nio.file.Path privateRoot() throws Exception { cache.checkSpace(0); return cache.root; }

    /** 读取一次源形成快照；未知长度通过实际流计数，之后仅从私有快照生成和发送归档。 */
    Artifact prepare(String transferId, String deviceId, String rootId, List<ArchiveModel.Source> sources,
                     ArchiveControl control, ArchiveModel.Progress progress) throws ArchiveFailure {
        ArchiveModel.require(SafValues.isId(transferId) && SafValues.isId(deviceId) && SafValues.isId(rootId) &&
            sources != null && !sources.isEmpty() && control != null);
        ArchiveModel.limit(sources.size() <= limits.files);
        ArchiveCache.Job job = begin(control);
        try {
            Set<String> entries = new HashSet<>();
            List<ArchiveModel.PreparedFile> files = new ArrayList<>();
            long total = 0, tarSize = 1024;
            emit(progress, "preparing", 0, null, control);
            for (int index = 0; index < sources.size(); index++) {
                control.check();
                ArchiveModel.Source source = sources.get(index);
                ArchiveModel.require(source != null);
                source.validateRoot(rootId);
                ArchiveModel.Observation before = source.observe(control);
                ArchiveModel.require(before != null);
                before.validate();
                ArchiveModel.require(entries.add(before.entryId));
                if (before.size != null) {
                    ArchiveModel.limit(before.size <= limits.file && before.size <= limits.total - total);
                    job.space(before.size);
                }
                String id = ArchiveModel.id(index);
                MessageDigest hash = ArchiveFormat.sha256();
                long size = 0;
                InputStream input = control.track(source.open(control));
                try (InputStream stream = input; OutputStream out = job.create(id, limits.file, control)) {
                    byte[] buffer = new byte[ArchiveModel.BUFFER];
                    int n;
                    while ((n = read(stream, buffer, control)) != -1) {
                        ArchiveModel.limit(size <= limits.file - n && total <= limits.total - n);
                        out.write(buffer, 0, n); hash.update(buffer, 0, n);
                        size += n; total += n;
                        emit(progress, "preparing", total, null, control);
                    }
                } finally { control.untrack(input); }
                ArchiveModel.Observation after = source.observe(control);
                if (!before.same(after) || (before.size != null && before.size != size)) {
                    throw new ArchiveFailure("source-changed", "源文件在归档准备期间发生变化");
                }
                tarSize += 512 + ArchiveModel.padded(size);
                ArchiveModel.limit(tarSize <= limits.tar);
                files.add(new ArchiveModel.PreparedFile(id, before, size, ArchiveFormat.hex(hash.digest())));
            }
            // 预检包含压缩体可能与原文重叠的实际预算；后续每次写入仍执行硬计数和空间检查。
            emit(progress, "archiving", 0, tarSize, control);
            HashedOutput packed = new HashedOutput(job.create("archive.gz", limits.archive, control));
            try (OutputStream output = packed; ArchiveFormat.GzipWriter gzip = new ArchiveFormat.GzipWriter(output)) {
                byte[] buffer = new byte[ArchiveModel.BUFFER];
                long written = 0;
                for (ArchiveModel.PreparedFile file : files) {
                    gzip.write(ArchiveFormat.header(file.fileId, file.sizeBytes)); written += 512;
                    MessageDigest hash = ArchiveFormat.sha256();
                    long size = 0;
                    try (InputStream input = job.open(file.fileId, control)) {
                        int n;
                        while ((n = read(input, buffer, control)) != -1) {
                            if (size > file.sizeBytes - n) throw mismatch();
                            gzip.write(buffer, 0, n); hash.update(buffer, 0, n); size += n; written += n;
                            emit(progress, "archiving", written, tarSize, control);
                        }
                    }
                    if (size != file.sizeBytes || !ArchiveFormat.hex(hash.digest()).equals(file.sha256)) throw mismatch();
                    int padding = (int) (ArchiveModel.padded(size) - size);
                    gzip.write(new byte[padding]); written += padding;
                }
                gzip.write(new byte[1024]); written += 1024;
                emit(progress, "archiving", written, tarSize, control);
            }
            ArchiveModel.Manifest manifest = new ArchiveModel.Manifest(transferId, deviceId, rootId, files, total,
                new ArchiveModel.Descriptor(packed.count, tarSize, packed.digest()));
            manifest.validate(limits);
            control.check();
            return new Artifact(job, manifest, control);
        } catch (Exception cause) { throw failed(job, control, cause); }
    }

    /** 接管并关闭输入；先保存并校验完整压缩体，再逐项解包校验，全部成功才返回句柄。 */
    Artifact receive(ArchiveModel.Manifest manifest, InputStream source, ArchiveControl control,
                     ArchiveModel.Progress progress) throws ArchiveFailure {
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
                    if (size > manifest.archive.sizeBytes - n) throw mismatch();
                    out.write(buffer, 0, n); hash.update(buffer, 0, n); size += n;
                    emit(progress, "receiving", size, manifest.archive.sizeBytes, control);
                }
            }
            if (size != manifest.archive.sizeBytes || !ArchiveFormat.hex(hash.digest()).equals(manifest.archive.sha256)) throw mismatch();
            control.untrack(input);
            emit(progress, "verifying", 0, manifest.totalFileBytes, control);
            try (InputStream compressed = job.open("archive.gz", control);
                 ArchiveFormat.GzipReader tar = new ArchiveFormat.GzipReader(compressed, limits.tar, control)) {
                long completed = 0;
                for (ArchiveModel.PreparedFile file : manifest.files) {
                    byte[] header = new byte[512];
                    ArchiveFormat.exact(tar, header, 512, control);
                    if (!Arrays.equals(header, ArchiveFormat.header(file.fileId, file.sizeBytes))) {
                        throw ArchiveFormat.invalid("tar 头、顺序、类型、长度或字段不符合清单");
                    }
                    MessageDigest contentHash = ArchiveFormat.sha256();
                    long remaining = file.sizeBytes;
                    try (OutputStream out = job.create(file.fileId, limits.file, control)) {
                        while (remaining > 0) {
                            int n = (int) Math.min(buffer.length, remaining);
                            ArchiveFormat.exact(tar, buffer, n, control);
                            out.write(buffer, 0, n); contentHash.update(buffer, 0, n);
                            remaining -= n; completed += n;
                            ArchiveModel.limit(completed <= limits.total);
                            emit(progress, "verifying", completed, manifest.totalFileBytes, control);
                        }
                    }
                    if (!ArchiveFormat.hex(contentHash.digest()).equals(file.sha256)) throw mismatch();
                    int padding = (int) (ArchiveModel.padded(file.sizeBytes) - file.sizeBytes);
                    ArchiveFormat.exact(tar, buffer, padding, control); ArchiveFormat.zeros(buffer, padding);
                }
                ArchiveFormat.exact(tar, buffer, 1024, control); ArchiveFormat.zeros(buffer, 1024);
                if (tar.read() != -1) throw ArchiveFormat.invalid("tar 结束后存在额外记录");
                emit(progress, "verifying", completed, manifest.totalFileBytes, control);
            }
            control.check();
            return new Artifact(job, manifest, control);
        } catch (Exception cause) {
            if (job == null) throw ArchiveFailure.from(cause);
            throw failed(job, control, cause);
        } finally { control.untrack(source); }
    }

    private synchronized ArchiveCache.Job begin(ArchiveControl control) throws ArchiveFailure {
        try {
            control.check();
            ArchiveCache.Job job = cache.begin(limits.cache);
            owned = job; current = control;
            return job;
        } catch (Exception cause) { throw ArchiveFailure.from(cause); }
    }
    private ArchiveFailure failed(ArchiveCache.Job job, ArchiveControl control, Exception cause) {
        ArchiveFailure failure = ArchiveFailure.from(cause);
        try { control.check(); } catch (ArchiveFailure cancellation) {
            cancellation.addSuppressed(failure); failure = cancellation;
        }
        try { dispose(job); } catch (IOException cleanup) {
            failure.cleanupFailure = ArchiveCache.cleanup(cleanup);
        }
        return failure;
    }
    private synchronized void dispose(ArchiveCache.Job job) throws IOException {
        job.dispose();
        if (owned == job) { owned = null; current = null; }
    }
    /** 停止当前归档的读流/SAF 查询；工作线程完成后负责清理，不从生命周期线程删除缓存。 */
    void cancel() { ArchiveControl control = current; if (control != null) control.cancel(); }
    /** 只有本实例拥有的任务可重试清理；调用前必须等待工作线程结束并关闭句柄读流。 */
    synchronized void retryCleanup() throws IOException { if (owned != null) dispose(owned); }

    private static int read(InputStream stream, byte[] buffer, ArchiveControl control) throws IOException {
        control.check();
        int n = stream.read(buffer);
        control.check();
        if (n == 0) throw new ArchiveFailure("io-failure", "输入流读取无进展");
        return n;
    }
    private static void emit(ArchiveModel.Progress progress, String stage, long count, Long total,
                             ArchiveControl control) throws Exception {
        control.check();
        if (progress != null) progress.update(stage, count, total);
        control.check();
    }
    private static ArchiveFailure mismatch() { return new ArchiveFailure("checksum-mismatch", "归档或原文长度/哈希不匹配"); }

    /** 不暴露路径的原生句柄；清单不可变，读流归调用者，dispose 失败可再次调用。 */
    final class Artifact implements AutoCloseable {
        final ArchiveModel.Manifest manifest;
        private final ArchiveCache.Job job;
        private final ArchiveControl control;
        Artifact(ArchiveCache.Job job, ArchiveModel.Manifest manifest, ArchiveControl control) {
            this.job = job; this.manifest = manifest; this.control = control;
        }
        InputStream openArchive() throws IOException { return job.open("archive.gz", control); }
        InputStream openFile(String fileId) throws IOException {
            for (ArchiveModel.PreparedFile file : manifest.files) if (file.fileId.equals(fileId)) return job.open(fileId, control);
            throw new ArchiveFailure("invalid-request", "文件引用不属于此归档清单");
        }
        @Override public void close() throws IOException { dispose(job); }
    }
    private static final class HashedOutput extends FilterOutputStream {
        private final MessageDigest hash = ArchiveFormat.sha256();
        private long count;
        HashedOutput(OutputStream output) { super(output); }
        @Override public void write(int value) throws IOException { write(new byte[] { (byte) value }); }
        @Override public void write(byte[] bytes, int offset, int length) throws IOException {
            out.write(bytes, offset, length); hash.update(bytes, offset, length); count += length;
        }
        String digest() { return ArchiveFormat.hex(hash.digest()); }
    }
}
