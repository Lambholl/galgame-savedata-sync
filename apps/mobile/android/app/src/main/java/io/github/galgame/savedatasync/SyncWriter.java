package io.github.galgame.savedatasync;

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
import static io.github.galgame.savedatasync.TransferJson.*;
import static io.github.galgame.savedatasync.TransferSchema.*;

/**
 * 确认计划的原生执行器，仅由 I/O 工作线程调用；文件内容和句柄不跨桥。
 * 全部输入/目标复核及保护备份后逐项写入，首次失败停止；清理未完成保持进程互斥。
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
        /** 未知为 null；识别同卷后将目标候选与私有备份峰值相加。 */
        Boolean sharesVolume(Path privateDirectory) throws Exception;
    }
    interface Backend {
        SyncScanner.Source source();
        NewFilePublisher publisher();
        void authorizeProject(String projectId, String rootId, ArchiveControl control) throws Exception;
        default void authorize(SyncPlanModel.Plan plan, ArchiveControl control) throws Exception { authorizeProject(plan.project, plan.target.root, control); }
        Long available(String rootId, String parentId, ArchiveControl control) throws Exception;
        String createDirectory(String rootId, String parentId, String name, ArchiveControl control) throws Exception;
        Replacement replacement(String rootId, String parentId, Map<String, Object> expected, ArchiveControl control) throws Exception;
    }
    private static final class Job {
        final SyncPlanModel.Plan plan;
        final ArchiveControl control;
        final Object token = new Object();
        final Set<Closeable> resources = new HashSet<>();
        final Map<String, String> directories = new LinkedHashMap<>();
        volatile boolean timedOut;
        boolean running = true;
        Object cleanupError;
        Job(SyncPlanModel.Plan plan, ArchiveControl control) { this.plan = plan; this.control = control; }
    }
    private final Backend backend;
    private final BackupStore backups;
    private final SyncScanner scanner;
    private final Set<String> used = new HashSet<>();
    private final Set<Restore> restores = new HashSet<>();
    private final ScheduledExecutorService watcher = Executors.newSingleThreadScheduledExecutor();
    private volatile Job active;
    private volatile boolean closed;
    private volatile ArchiveControl preparing;
    private volatile boolean preparationTimedOut;
    private int restoring;
    SyncWriter(Backend backend, BackupStore backups) {
        this.backend = Objects.requireNonNull(backend); this.backups = Objects.requireNonNull(backups);
        scanner = new SyncScanner(backend.source());
        watcher.scheduleAtFixedRate(() -> {
            Job job = active;
            if (job == null || !job.running) {
                ArchiveControl preview = preparing; if (preview == null) return;
                try { preview.check(); } catch (ArchiveFailure stopped) { if (stopped.code.equals("timeout")) preparationTimedOut = true; preview.cancel(); }
                return;
            }
            try { job.control.check(); }
            catch (ArchiveFailure stopped) { if (stopped.code.equals("timeout")) job.timedOut = true; job.control.cancel(); }
        }, 25, 25, TimeUnit.MILLISECONDS);
    }
    private void check(Job job) throws Exception {
        if (job.timedOut) throw new ArchiveFailure("timeout", "当前写入操作超时");
        job.control.check(); backend.authorize(job.plan, job.control); job.control.check();
    }
    private static Map<String, Object> error(String code, String message) { return object("code", code, "message", message, "canRetry", false); }
    private static Map<String, Object> outcome(Map<String, Object> operation, String status, Object error, Map<String, Object> source) {
        boolean file = status.equals("succeeded") && !operation.get("action").equals("create-directory");
        return object("path", operation.get("path"), "action", operation.get("action"), "status", status,
            "sizeBytes", file ? source.get("sizeBytes") : null, "sha256", file ? source.get("sha256") : null, "error", error);
    }
    private static Map<String, Object> cleanupError() { return error("cleanup-failed", "本次文件或恢复材料尚未完整释放，请重试清理"); }
    private <T extends Closeable> T track(Job job, T value) throws Exception {
        job.resources.add(value); return job.control.track(value);
    }
    private void close(Job job, Closeable value) throws Exception {
        value.close(); job.control.untrack(value); job.resources.remove(value);
    }
    private static void digest(InputStream input, Map<String, Object> expected, ArchiveControl control, java.util.function.BooleanSupplier timedOut) throws Exception {
        MessageDigest hash = MessageDigest.getInstance("SHA-256"); long size = 0, limit = number(expected.get("sizeBytes"), 0, 9007199254740991L); byte[] buffer = new byte[65536];
        for (int count; (count = input.read(buffer)) != -1;) {
            if (timedOut.getAsBoolean()) throw new ArchiveFailure("timeout", "当前写入操作超时");
            control.check(); size += count; if (size > limit) throw new ArchiveFailure("checksum-mismatch", "实际内容超过确认长度");
            hash.update(buffer, 0, count);
        }
        control.check();
        if (size != limit || !ArchiveFormat.hex(hash.digest()).equals(expected.get("sha256"))) throw new ArchiveFailure("checksum-mismatch", "实际内容与确认指纹不同");
    }
    private ArchiveModel.Observation observe(SyncPlanModel.Plan plan, ArchiveModel.Source source, Map<String, Object> entry, ArchiveControl control) throws Exception {
        source.validateRoot(plan.source.root); ArchiveModel.Observation value = source.observe(control); value.validate();
        List<String> path = BackupModel.path(entry.get("path"));
        if (!value.entryId.equals(entry.get("entryId")) || !value.name.equals(path.get(path.size() - 1)) ||
            (value.size != null && value.size.longValue() != number(entry.get("sizeBytes"), 0, BackupModel.MAX_FILE)) ||
            !Objects.equals(value.modified, nullable(entry.get("modifiedAt"), -BackupModel.MAX_DATE, BackupModel.MAX_DATE))) throw new ArchiveFailure("source-changed", "原生材料与确认引用不同");
        return value;
    }
    private void preflight(Job job, Material material) throws Exception {
        check(job);
        Map<String, Object> current = scanner.snapshotNow(job.plan.target.root, job.control);
        if (!SyncPlanModel.same(current.get("entries"), job.plan.target.value.get("entries"))) throw new ArchiveFailure("source-changed", "目标内容与确认时不同，请重新扫描");
        for (Map<String, Object> entry : job.plan.target.paths.values()) if (entry.get("kind").equals("directory")) {
            job.directories.put(SyncPlanModel.key(entry.get("path")), string(entry.get("entryId")));
        }
        boolean hasNewFile = false;
        for (Map<String, Object> operation : job.plan.writes) if (!operation.get("action").equals("create-directory")) {
            check(job); Map<String, Object> entry = job.plan.source.entry(operation.get("sourceEntryId"));
            ArchiveModel.Source source = material.file(string(entry.get("entryId"))); ArchiveModel.Observation before = observe(job.plan, source, entry, job.control);
            InputStream input = track(job, source.open(job.control));
            try { digest(input, entry, job.control, () -> job.timedOut); }
            finally { close(job, input); }
            if (!before.same(source.observe(job.control))) throw new ArchiveFailure("source-changed", "输入材料在读取期间变化");
            if (operation.get("action").equals("create-file")) hasNewFile = true;
        }
        if (hasNewFile) backend.publisher().grant(job.plan.target.root);
        long growthBytes = targetGrowth(job.plan), oldBytes = job.plan.replacements.isEmpty() ? 0 :
            number(job.plan.value.get("backupFileBytes"), 0, BackupModel.MAX_TOTAL) + bytes(job.plan.value).length + 8192L;
        Boolean sameVolume = null;
        if (!job.plan.replacements.isEmpty()) {
            Map<String, Object> entry = map(job.plan.replacements.get(0)); List<String> path = BackupModel.path(entry.get("path"));
            Replacement replacement = track(job, backend.replacement(job.plan.target.root, parent(job, path), entry, job.control));
            try { sameVolume = replacement.sharesVolume(backups.root); } finally { close(job, replacement); }
        }
        Long available = backend.available(job.plan.target.root, null, job.control);
        long targetPeak = growthBytes + (Boolean.TRUE.equals(sameVolume) ? oldBytes : 0);
        if (available != null && available < targetPeak) throw new ArchiveFailure("insufficient-space", "目标存储空间不足以完成本次写入和备份");
        if (oldBytes > 0) backups.capacity(oldBytes + (Boolean.TRUE.equals(sameVolume) ? growthBytes : 0));
        check(job);
    }
    private long targetGrowth(SyncPlanModel.Plan plan) throws Exception {
        long total = 0;
        for (Map<String, Object> operation : plan.writes) if (!operation.get("action").equals("create-directory")) {
            long size = number(plan.source.entry(operation.get("sourceEntryId")).get("sizeBytes"), 0, BackupModel.MAX_FILE);
            long previous = operation.get("action").equals("replace-file") ? number(plan.target.entry(operation.get("targetEntryId")).get("sizeBytes"), 0, 9007199254740991L) : 0;
            total += Math.max(0, size - previous);
        }
        return total;
    }
    private String parent(Job job, List<String> path) throws Exception {
        if (path.size() == 1) return null;
        String value = job.directories.get(SyncPlanModel.key(path.subList(0, path.size() - 1)));
        if (value == null) throw new ArchiveFailure("source-changed", "目标父目录引用不存在"); return value;
    }
    private Map<String, Object> write(Job job, Map<String, Object> operation, Material material, int fileIndex) throws Exception {
        check(job); List<String> path = BackupModel.path(operation.get("path")); String parent = parent(job, path), name = path.get(path.size() - 1);
        if (operation.get("action").equals("create-directory")) {
            String id = backend.createDirectory(job.plan.target.root, parent, name, job.control);
            job.directories.put(SyncPlanModel.key(path), id); return outcome(operation, "succeeded", null, null);
        }
        Map<String, Object> entry = job.plan.source.entry(operation.get("sourceEntryId"));
        ArchiveModel.Source source = material.file(string(entry.get("entryId"))); ArchiveModel.Observation baseline = observe(job.plan, source, entry, job.control);
        if (operation.get("action").equals("create-file")) {
            PublicationModel.Request request = new PublicationModel.Request(ArchiveModel.id(fileIndex), job.plan.target.root, parent, name,
                number(entry.get("sizeBytes"), 0, BackupModel.MAX_FILE), string(entry.get("sha256")));
            PublicationModel.Result result = backend.publisher().publish(request, () -> source.open(job.control), null, job.control);
            if (result.cleanupError != null) job.cleanupError = cleanupError();
            if (job.timedOut && result.status.equals("cancelled")) return outcome(operation, "failed", error("timeout", "当前写入操作超时"), null);
            Object error = result.errorCode == null ? null : error(result.errorCode, result.status.equals("unknown") ? "新建文件结果未能完整核实，请重新读取目标" : "新建文件失败");
            return outcome(operation, result.status, error, entry);
        }
        Map<String, Object> old = job.plan.target.entry(operation.get("targetEntryId"));
        Replacement target = track(job, backend.replacement(job.plan.target.root, parent, old, job.control));
        boolean hasWritten = false;
        try {
            InputStream original = track(job, target.read(job.control));
            try { digest(original, old, job.control, () -> job.timedOut); } finally { close(job, original); }
            target.verify(job.control); check(job);
            InputStream input = track(job, source.open(job.control));
            OutputStream output = null;
            try {
                output = track(job, target.output(job.control)); MessageDigest hash = MessageDigest.getInstance("SHA-256");
                byte[] buffer = new byte[65536]; long size = 0, expected = number(entry.get("sizeBytes"), 0, BackupModel.MAX_FILE);
                for (int count; (count = input.read(buffer)) != -1;) {
                    check(job); if (count == 0) continue; size += count;
                    if (size > expected) throw new ArchiveFailure("checksum-mismatch", "原文长度超过确认值");
                    hasWritten = true; output.write(buffer, 0, count); hash.update(buffer, 0, count);
                }
                check(job);
                if (size != expected || !ArchiveFormat.hex(hash.digest()).equals(entry.get("sha256"))) throw new ArchiveFailure("checksum-mismatch", "原文内容与确认值不同");
                if (!baseline.same(source.observe(job.control))) throw new ArchiveFailure("source-changed", "原文在写入期间变化");
                hasWritten = true; target.finish(size, job.control);
            } finally { try { close(job, input); } finally { if (output != null) close(job, output); } }
            // 已修改的目标即使收到晚取消，也以独立有界回读报告实际结果。
            ArchiveControl inspection = new ArchiveControl(); target.verify(inspection);
            InputStream readback = trackInspection(job, target.read(inspection));
            try { digest(readback, entry, inspection, () -> false); } finally { close(job, readback); }
            // 结果已核实；目标句柄交给外围清理，关闭失败不能改写文件成功。
            target.verify(inspection);
            return outcome(operation, "succeeded", null, entry);
        } catch (Exception cause) {
            if (hasWritten) return outcome(operation, "unknown", error("result-unknown", "目标文件已进入写入，但结果未能完整核实，请重新读取目标"), null);
            throw cause;
        }
    }
    private <T extends Closeable> T trackInspection(Job job, T value) { job.resources.add(value); return value; }
    /** 非法、过期、已使用及 busy 确认抛异常；已接纳后返回完整实际结果，绝不自动重放。 */
    Map<String, Object> apply(Object raw, Material material, ArchiveControl control) throws Exception {
        SyncPlanModel.Plan plan = new SyncPlanModel.Plan(raw);
        require(plan.target.device.equals(backend.source().deviceId()));
        if (material == null) require(number(plan.value.get("transferFileCount"), 0, 1024) == 0);
        else require(SyncPlanModel.same(plan.source.value, material.snapshot()));
        long observed = number(plan.target.value.get("observedAt"), -BackupModel.MAX_DATE, BackupModel.MAX_DATE), now = System.currentTimeMillis();
        if (observed > now || now - observed > 600000) throw new ArchiveFailure("not-found", "本机确认快照已过期，请重新扫描");
        Job job = new Job(plan, control);
        synchronized (this) {
            if (closed || active != null || preparing != null) throw new ArchiveFailure("busy", "写入尚未结束或资源仍待清理");
            if (used.contains(plan.id)) throw new ArchiveFailure("task-conflict", "本次确认已执行，请重新扫描");
            if (used.size() >= 4096) throw new ArchiveFailure("resource-limit", "本进程确认标识容量已满");
            if (!TargetOperation.acquire(job.token)) throw new ArchiveFailure("busy", "已有传输或恢复任务");
            used.add(plan.id); active = job;
        }
        List<Object> outcomes = new ArrayList<>(); for (Map<String, Object> operation : plan.writes) outcomes.add(outcome(operation, "not-attempted", null, null));
        Object error = null, cleanup = null, backupId = null; int index = 0, fileIndex = 0;
        try {
            preflight(job, material);
            Map<String, Object> backup = backups.create(plan.project, plan.target.root, plan.reason, plan.backup, plan.replacements, control);
            cleanup = backup.get("cleanupError");
            if (!plan.replacements.isEmpty() && backup.get("manifest") == null) throw new ArchiveFailure("io-failure", "完整保护备份尚未提交");
            if (backup.get("manifest") != null) backupId = map(backup.get("manifest")).get("backupId");
            // SAF 与私有目录可能使用不同的逻辑设备 ID；备份落盘后再查实际余量，覆盖共享物理卷。
            Long remaining = backend.available(plan.target.root, null, control);
            if (remaining != null && remaining < targetGrowth(plan)) throw new ArchiveFailure("insufficient-space", "备份完成后的目标余量不足以写入本次文件增量");
            for (int i = 0; i < plan.writes.size(); i++) {
                index = i; Map<String, Object> operation = plan.writes.get(i), result = write(job, operation, material, fileIndex);
                outcomes.set(i, result); if (!operation.get("action").equals("create-directory")) fileIndex++;
                if (!result.get("status").equals("succeeded")) { error = result.get("error"); break; }
                if (!clean(job)) { cleanup = cleanupError(); error = i + 1 < plan.writes.size() ? cleanup : null; break; }
                index = i + 1;
            }
        } catch (Exception cause) {
            ArchiveFailure failure = ArchiveFailure.from(cause);
            if (!failure.code.equals("result-unknown") && !failure.code.equals("timeout")) {
                try { control.check(); } catch (ArchiveFailure stopped) { failure = stopped; }
            }
            if (job.timedOut) failure = new ArchiveFailure("timeout", "当前写入操作超时", false, cause);
            if (!failure.cancelled) error = error(failure.code, failure.getMessage());
            if (failure.cleanupFailure != null) cleanup = cleanupError();
            if (index < plan.writes.size() && map(outcomes.get(index)).get("status").equals("not-attempted")) {
                String status = failure.code.equals("result-unknown") ? "unknown" : failure.cancelled ? "cancelled" : "failed";
                outcomes.set(index, outcome(plan.writes.get(index), status, failure.cancelled ? null : error, null));
            }
        } finally {
            boolean clean = clean(job); if (!clean) cleanup = cleanupError();
            if (cleanup == null && job.cleanupError != null) cleanup = job.cleanupError;
            synchronized (this) { job.running = false; if (clean) { active = null; TargetOperation.release(job.token); } notifyAll(); }
        }
        return object("schemaVersion", 1, "planId", plan.id, "backupId", backupId, "outcomes", outcomes, "error", error, "cleanupError", cleanup);
    }
    private boolean clean(Job job) {
        boolean clean = true;
        for (Closeable resource : new ArrayList<>(job.resources)) try { close(job, resource); } catch (Exception failure) { clean = false; }
        return backend.publisher().retryCleanup() && clean;
    }
    /** 清理只重试资源释放，不重新创建或写入任何文件。 */
    synchronized boolean retryCleanup() {
        Job job = active; if (job != null && (job.running || !clean(job))) return false;
        for (Restore restore : new ArrayList<>(restores)) if (restore.consumed && !restore.running) {
            try { restore.close(); } catch (Exception failure) { return false; }
        }
        if (job != null) { active = null; TargetOperation.release(job.token); } return true;
    }
    /** 本机恢复预览保持输入引用；公开数据供纯 TS 生成计划，确认后必须提交同一份源/目标。 */
    final class Restore implements Material, AutoCloseable {
        final String planId = java.util.UUID.randomUUID().toString(), projectId, rootId;
        final long created = System.nanoTime();
        final BackupStore.Handle handle;
        final Map<String, Object> source, target;
        boolean consumed, running;
        Restore(String projectId, String rootId, BackupStore.Handle handle, Map<String, Object> target) throws Exception {
            this.projectId = projectId; this.rootId = rootId; this.handle = handle; source = handle.snapshot(); this.target = target;
        }
        Map<String, Object> preview() throws Exception {
            return map(copy(object("planId", planId, "projectId", projectId, "source", source, "target", target)));
        }
        @Override public Map<String, Object> snapshot() throws Exception { return map(copy(source)); }
        @Override public ArchiveModel.Source file(String entryId) throws Exception { return handle.source(entryId); }
        Map<String, Object> apply(Object raw, ArchiveControl control) throws Exception {
            SyncPlanModel.Plan plan = new SyncPlanModel.Plan(raw);
            synchronized (SyncWriter.this) {
                if (closed || consumed || !restores.contains(this) || System.nanoTime() - created > TimeUnit.MINUTES.toNanos(10)) throw new ArchiveFailure("not-found", "恢复预览已使用、关闭或过期");
                require(plan.reason.equals("restore") && plan.id.equals(planId) && plan.project.equals(projectId) && plan.target.root.equals(rootId) &&
                    SyncPlanModel.same(plan.source.value, source) && SyncPlanModel.same(plan.target.value, target));
                consumed = true; running = true; restoring++;
            }
            Map<String, Object> result = null;
            try { result = SyncWriter.this.apply(plan.value, this, control); return result; }
            finally {
                try {
                    Map<String, Object> released = handle.release();
                    if (result != null && result.get("cleanupError") == null) result.put("cleanupError", released.get("cleanupError"));
                    synchronized (SyncWriter.this) { restores.remove(this); }
                } catch (Exception failure) {
                    if (result != null) result.put("cleanupError", cleanupError());
                } finally {
                    synchronized (SyncWriter.this) { running = false; restoring--; SyncWriter.this.notifyAll(); }
                }
            }
        }
        @Override public void close() throws Exception {
            synchronized (SyncWriter.this) { if (running) throw new ArchiveFailure("busy", "恢复任务尚未结束"); consumed = true; }
            handle.close(); synchronized (SyncWriter.this) { consumed = true; restores.remove(this); }
        }
    }
    Restore prepareRestore(String projectId, String rootId, String backupId, ArchiveControl control) throws Exception {
        id(projectId); id(rootId); id(backupId);
        synchronized (this) {
            if (closed || active != null || preparing != null || restores.size() >= 32) throw new ArchiveFailure("busy", "已有操作或恢复预览数量已达限制");
            preparing = control; preparationTimedOut = false;
        }
        BackupStore.Handle handle = null;
        try {
            backend.authorizeProject(projectId, rootId, control);
            handle = backups.acquire(projectId, rootId, backupId, control);
            Restore result = new Restore(projectId, rootId, handle, scanner.snapshotNow(rootId, control));
            control.check(); synchronized (this) { if (closed) throw new ArchiveFailure("busy", "写入器已关闭"); restores.add(result); }
            return result;
        } catch (Exception failure) {
            if (handle != null) handle.close();
            if (preparationTimedOut) throw new ArchiveFailure("timeout", "恢复预览准备超时", false, failure);
            throw failure;
        } finally { synchronized (this) { preparing = null; notifyAll(); } }
    }
    /** 原生所有者关闭时取消工作并等待释放；普通前后台变化不调用此入口。 */
    @Override public void close() throws Exception {
        closed = true; Job job = active; if (job != null) job.control.cancel();
        ArchiveControl preview = preparing; if (preview != null) preview.cancel();
        synchronized (this) { while ((active != null && active.running) || preparing != null || restoring > 0) wait(1000); if (!retryCleanup()) throw new ArchiveFailure("cleanup-failed", "目标文件尚未释放"); }
        for (Restore restore : new ArrayList<>(restores)) restore.close();
        scanner.close(); watcher.shutdownNow(); backend.publisher().stop();
    }
}
