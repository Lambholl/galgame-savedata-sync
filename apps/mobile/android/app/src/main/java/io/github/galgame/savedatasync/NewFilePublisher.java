package io.github.galgame.savedatasync;

import java.io.Closeable;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import static io.github.galgame.savedatasync.PublicationModel.*;

/**
 * 同步原生单文件发布器，只能在 I/O 工作线程使用。批次校验、HTTP 和 UI 由调用方编排。
 * SAF 创建不是排他原语：不采用覆盖或重命名，创建返回后必须先确认新身份与父目录。
 * 独立于归档名额；流关闭且残留清理完成才释放进程发布名额。
 */
final class NewFilePublisher {
    interface Source { InputStream open() throws Exception; }
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
    }
    private static final java.util.concurrent.atomic.AtomicReference<NewFilePublisher> PROCESS_OWNER =
        new java.util.concurrent.atomic.AtomicReference<>();
    private final Backend backend;
    private final Set<String> grants = new HashSet<>();
    private Job active;
    private boolean stopped;
    private long authorizationVersion;
    private static final class Job {
        final Request request;
        final ArchiveControl control;
        Owned owned;
        Entry residual;
        boolean running = true;
        boolean succeeded;
        final List<Closeable> resources = new ArrayList<>();
        Job(Request request, ArchiveControl control) { this.request = request; this.control = control; }
    }

    NewFilePublisher(Backend backend) { this.backend = backend; }

    /** 可信原生用户动作单独调用；读取登记或已有系统 WRITE 不等于本次写入授权。 */
    void grant(String rootId) throws Exception {
        final long version;
        synchronized (this) {
            if (stopped || !SafValues.isId(rootId)) throw new ArchiveFailure("invalid-request", "发布器不可用或根引用无效");
            version = authorizationVersion;
        }
        backend.locate(rootId, null, new ArchiveControl());
        synchronized (this) {
            if (stopped || version != authorizationVersion) throw new ArchiveFailure("authorization-expired", "授权期间已收到撤权或停止请求");
            grants.add(rootId);
        }
    }
    synchronized void revoke(String rootId) {
        grants.remove(rootId);
        authorizationVersion++;
        if (active != null && active.request.rootId.equals(rootId)) active.control.cancel();
    }
    synchronized void cancel() { if (active != null) active.control.cancel(); }

    /** 批次接纳前可逐项调用的只读检查；不创建目录或文件，不授予写权限。 */
    void preflight(Request request, ArchiveControl control) throws Exception {
        request.validate();
        synchronized (this) {
            if (stopped || !grants.contains(request.rootId)) throw new ArchiveFailure("permission-denied", "未显式授权该目标目录写入");
        }
        control.check();
        requireName(backend.children(backend.locate(request.rootId, request.parentId, control), control), request.name, null);
        control.check();
    }

    Result publish(Request request, Source source, ArchiveModel.Progress progress, ArchiveControl control) throws ArchiveFailure {
        request.validate();
        Job job = new Job(request, control);
        synchronized (this) {
            if (stopped || !grants.contains(request.rootId)) throw new ArchiveFailure("permission-denied", "未显式授权该目标目录写入");
            if (!PROCESS_OWNER.compareAndSet(null, this)) throw new ArchiveFailure("busy", "另一发布或残留清理尚未完成");
            active = job;
        }
        String status = "failed", error = null;
        Entry success = null;
        boolean createAttempted = false, createResolved = false;
        try {
            control.check();
            Directory directory = backend.locate(request.rootId, request.parentId, control);
            List<Document> before = backend.children(directory, control);
            Set<String> ids = ids(before);
            requireName(before, request.name, null);
            control.check();
            createAttempted = true;
            String id = backend.create(directory, request.name);
            // createDocument 没有取消参数；取消后也要等待返回并核实归属，不能按文件名猜测清理。
            ArchiveControl inspection = new ArchiveControl();
            List<Document> after = backend.children(directory, inspection);
            ids(after);
            Document created = null;
            for (Document d : after) if (d.id.equals(id)) created = d;
            if (id == null || ids.contains(id) || created == null) {
                throw new ArchiveFailure("result-unknown", "提供者未返回可确认的新条目");
            }
            job.owned = backend.claim(directory, created);
            job.residual = job.owned.entry(inspection);
            createResolved = true;
            if (created.directory || created.virtual) throw new ArchiveFailure("unsupported-operation", "新条目不是普通原始文件");
            if (!created.name.equals(request.name)) throw new ArchiveFailure("name-conflict", "提供者改变了新文件名称");
            requireName(after, request.name, id);
            control.check();
            job.owned.verify(control);
            copy(job, source, job.owned, request, progress, control);
            control.check();
            job.owned.verify(control);
            Entry readBaseline = job.owned.entry(control);
            checkContents(job, job.owned, request, progress, control);
            control.check();
            job.owned.verify(control);
            requireName(backend.children(directory, control), request.name, id);
            success = job.owned.entry(control);
            if (!request.name.equals(success.name) || (success.size != null && success.size != request.sizeBytes) ||
                !readBaseline.entryId.equals(success.entryId) || !java.util.Objects.equals(readBaseline.size, success.size) ||
                !java.util.Objects.equals(readBaseline.modified, success.modified)) {
                throw new ArchiveFailure("result-unknown", "写后元数据与请求不一致");
            }
            control.check();
            // 此处为已确认发布点；之后的取消和资源关闭错误均不能删除成功文件。
            status = "succeeded";
            job.succeeded = true;
            job.residual = null;
        } catch (Exception cause) {
            ArchiveFailure failure = failure(cause);
            boolean uncertain = "result-unknown".equals(failure.code) || (createAttempted && !createResolved);
            if (!uncertain) {
                try { control.check(); } catch (ArchiveFailure interrupted) { failure = interrupted; }
            }
            status = uncertain ? "unknown" : failure.cancelled ? "cancelled" : "failed";
            error = uncertain ? "result-unknown" : failure.cancelled ? null : failure.code;
        }
        String cleanup = job.owned == null ? createAttempted && !createResolved ? "unknown" : "not-needed" : "complete";
        String cleanupError = "unknown".equals(cleanup) ? "result-unknown" : null;
        try { closeResources(job); }
        catch (Exception cause) { cleanup = "incomplete"; cleanupError = "cleanup-failed"; }
        if (job.owned != null && job.resources.isEmpty()) {
            try {
                if (!"succeeded".equals(status)) job.owned.delete();
                job.owned.close();
                job.owned = null; job.residual = null;
            } catch (Exception cause) { cleanup = "incomplete"; cleanupError = "cleanup-failed"; }
        }
        synchronized (this) {
            job.running = false;
            if (job.owned == null && job.resources.isEmpty()) release(job);
        }
        return new Result(request, status, error, success, job.residual, cleanup, cleanupError);
    }

    /** 只重试已知句柄的清理，不重放创建/写入；成功文件只关闭句柄。 */
    synchronized boolean retryCleanup() {
        Job job = active;
        if (job == null) return true;
        if (job.running) return false;
        try {
            closeResources(job);
            if (job.owned != null) {
                if (!job.succeeded) job.owned.delete();
                job.owned.close(); job.owned = null; job.residual = null;
            }
        } catch (Exception cause) { return false; }
        release(job);
        return true;
    }

    /** 生命周期先取消，工作线程 join 后再次调用以确认释放；不会抢占阻塞中的平台调用。 */
    synchronized boolean stop() {
        stopped = true; authorizationVersion++; grants.clear(); cancel();
        return retryCleanup();
    }

    private void release(Job job) {
        synchronized (this) { if (active == job) { active = null; PROCESS_OWNER.compareAndSet(this, null); } }
    }
    private static Set<String> ids(List<Document> documents) throws ArchiveFailure {
        if (documents.size() > MAX_DIRECTORY_ENTRIES) throw new ArchiveFailure("resource-limit", "目标当前层条目过多");
        Set<String> result = new HashSet<>();
        for (Document d : documents) {
            if (d == null || d.id == null || d.id.isEmpty() || !ArchiveModel.text(d.name) || !result.add(d.id)) {
                throw new ArchiveFailure("result-unknown", "提供者返回不一致的目录条目");
            }
        }
        return result;
    }
    private static void requireName(List<Document> documents, String name, String ownId) throws ArchiveFailure {
        ids(documents);
        for (Document d : documents) if (!d.id.equals(ownId) && nameKey(d.name).equals(nameKey(name))) {
            throw new ArchiveFailure("name-conflict", "目标已有同名或等价名称的条目");
        }
    }
    private static void copy(Job job, Source source, Owned owned, Request request, ArchiveModel.Progress progress,
                             ArchiveControl control) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        InputStream input = track(job, source.open());
        try {
            OutputStream output = track(job, owned.openOutput(request.sizeBytes, control));
            try {
                transfer(input, output, request, digest, progress, "writing", control);
                output.flush();
            } finally { close(job, output); }
        } finally { close(job, input); }
    }
    private static void checkContents(Job job, Owned owned, Request request, ArchiveModel.Progress progress,
                                      ArchiveControl control) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        InputStream input = track(job, owned.openRead(control));
        try { transfer(input, null, request, digest, progress, "verifying", control); }
        finally { close(job, input); }
    }
    private static <T extends Closeable> T track(Job job, T resource) throws Exception {
        job.resources.add(resource);
        return job.control.track(resource);
    }
    private static void close(Job job, Closeable resource) throws Exception {
        resource.close(); job.control.untrack(resource); job.resources.remove(resource);
    }
    private static void closeResources(Job job) throws Exception {
        Exception failure = null;
        for (Closeable resource : new ArrayList<>(job.resources)) {
            try { close(job, resource); } catch (Exception cause) { failure = cause; }
        }
        if (failure != null) throw failure;
    }
    private static void transfer(InputStream input, OutputStream output, Request request, MessageDigest digest,
                                 ArchiveModel.Progress progress, String stage, ArchiveControl control) throws Exception {
        byte[] buffer = new byte[65536];
        long count = 0;
        while (true) {
            control.check();
            int read = input.read(buffer, 0, (int) Math.min(buffer.length, request.sizeBytes - count + 1));
            if (read < 0) break;
            if (read == 0) throw new ArchiveFailure("io-failure", "流未取得进展");
            if (count + read > request.sizeBytes) throw new ArchiveFailure("checksum-mismatch", "文件实际长度超出请求");
            if (output != null) output.write(buffer, 0, read);
            digest.update(buffer, 0, read); count += read;
            if (progress != null) progress.update(stage, count, request.sizeBytes);
        }
        control.check();
        if (count != request.sizeBytes || !hex(digest.digest()).equals(request.sha256)) {
            throw new ArchiveFailure("checksum-mismatch", "文件实际长度或 SHA-256 不匹配");
        }
    }
    static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte b : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return result.toString();
    }
    static ArchiveFailure failure(Exception cause) {
        if (cause instanceof SafFailure) return new ArchiveFailure(((SafFailure) cause).code, "SAF 发布访问失败", false, cause);
        if (cause instanceof SecurityException) return new ArchiveFailure("authorization-expired", "目录写授权不可用", false, cause);
        return ArchiveFailure.from(cause);
    }
}
