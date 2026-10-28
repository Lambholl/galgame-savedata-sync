package io.github.galgame.savedatasync;

import android.content.Context;
import android.os.CancellationSignal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import static io.github.galgame.savedatasync.TransferJson.*;
import static io.github.galgame.savedatasync.TransferSchema.*;

/** 应用 Context 持有本机恢复预览与任务；Activity 重建后按 ID 查询，不判断前后台或自动重放。 */
final class SyncWriteRuntime implements AutoCloseable {
    private final Map<String, String> projects = new LinkedHashMap<>();
    private final Map<String, Job> jobs = new LinkedHashMap<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final java.util.concurrent.ScheduledExecutorService expiry = Executors.newSingleThreadScheduledExecutor();
    private final SafDirectoryStore store;
    final SyncWriter writer;
    private Job active;
    private boolean closed;
    private static final class Job {
        final String id = UUID.randomUUID().toString(), project, root, backup;
        ArchiveControl control = new ArchiveControl();
        SyncWriter.Restore restore;
        String status = "preparing";
        Object preview, result, error;
        long touched = System.nanoTime();
        boolean running = true;
        Job(String project, String root, String backup) { this.project = project; this.root = root; this.backup = backup; }
        Map<String, Object> state() throws Exception { return map(copy(object("restoreId", id, "projectId", project, "rootId", root, "backupId", backup,
            "status", status, "result", result, "error", error))); }
    }
    SyncWriteRuntime(Context context, SafDirectoryStore store, BackupStore backups) {
        this.store = store;
        writer = new SyncWriter(new SafSyncBackend(context, store, (project, root) -> {
            synchronized (SyncWriteRuntime.this) {
                if (!root.equals(projects.get(project))) throw new ArchiveFailure("permission-denied", "目标目录与本次本机项目绑定不符");
            }
        }), backups);
        expiry.scheduleAtFixedRate(() -> worker.execute(() -> { synchronized (SyncWriteRuntime.this) { purge(); } }), 1, 1, TimeUnit.MINUTES);
    }
    /** 平台适配层从已保存游戏配置绑定本机项目；只登记现有授权引用，活动任务期间拒绝变更。 */
    synchronized void bindProject(String project, String root) throws Exception {
        available();
        id(project); id(root);
        if (active != null || TargetOperation.hasWork()) throw new ArchiveFailure("busy", "活动任务期间不能修改项目绑定");
        store.publicationDirectory(root, null, new CancellationSignal(), false);
        if (!projects.containsKey(project) && projects.size() >= 128) throw new ArchiveFailure("resource-limit", "本机项目绑定数量超过限制");
        projects.put(project, root);
    }
    private synchronized Job find(String restoreId) throws Exception {
        available(); id(restoreId); purge(); Job job = jobs.get(restoreId);
        if (job == null) throw new ArchiveFailure("not-found", "恢复任务不存在或已过期"); return job;
    }
    private void purge() {
        long now = System.nanoTime();
        for (Job job : new ArrayList<>(jobs.values())) if (!job.running && now - job.touched >= TimeUnit.MINUTES.toNanos(10)) {
            if (job.restore != null) { try { job.restore.close(); } catch (Exception cleanup) { continue; } }
            jobs.remove(job.id);
        }
    }
    synchronized Map<String, Object> prepare(String project, String root, String backup) throws Exception {
        available(); id(project); id(root); id(backup); purge();
        if (!root.equals(projects.get(project))) throw new ArchiveFailure("permission-denied", "请先核实保存的本机项目与目录绑定");
        if (active != null || jobs.size() >= 32) throw new ArchiveFailure("busy", "已有恢复任务或结果数量已达限制");
        Job job = new Job(project, root, backup); jobs.put(job.id, job); active = job;
        worker.execute(() -> {
            try {
                SyncWriter.Restore restore = writer.prepareRestore(project, root, backup, job.control);
                synchronized (this) { job.restore = restore; job.control.check(); job.preview = restore.preview(); job.status = "ready"; settled(job); }
            } catch (Exception failure) { failed(job, failure); }
        });
        return job.state();
    }
    synchronized Map<String, Object> query(String restoreId) throws Exception { return find(restoreId).state(); }
    synchronized Map<String, Object> preview(String restoreId) throws Exception {
        Job job = find(restoreId); if (job.preview == null) throw new ArchiveFailure("task-conflict", "恢复预览尚未准备完成");
        Map<String, Object> result = map(copy(job.preview)); result.put("restoreId", job.id); return result;
    }
    synchronized Map<String, Object> execute(String restoreId, Object raw) throws Exception {
        Job job = find(restoreId);
        if (!job.status.equals("ready") || job.restore == null || active != null) throw new ArchiveFailure("task-conflict", "恢复预览已使用或尚未准备完成");
        SyncPlanModel.Plan plan = new SyncPlanModel.Plan(raw);
        if (!plan.id.equals(job.restore.planId) || !plan.project.equals(job.project) || !plan.reason.equals("restore") ||
            !SyncPlanModel.same(plan.source.value, job.restore.source) || !SyncPlanModel.same(plan.target.value, job.restore.target)) throw new ArchiveFailure("invalid-request", "确认计划与本次恢复预览不同");
        job.control = new ArchiveControl(); job.status = "running"; job.running = true; active = job;
        worker.execute(() -> {
            try {
                Map<String, Object> result = job.restore.apply(plan.value, job.control);
                synchronized (this) {
                    job.result = result; job.restore = null;
                    boolean complete = result.get("error") == null, cancelled = false;
                    for (Object item : list(result.get("outcomes"))) {
                        String status = string(map(item).get("status")); complete &= status.equals("succeeded"); cancelled |= status.equals("cancelled");
                    }
                    job.status = complete ? "succeeded" : cancelled ? "cancelled" : "failed";
                    job.error = result.get("error");
                    settled(job);
                }
            } catch (Exception failure) { failed(job, failure); }
        });
        return job.state();
    }
    private synchronized void failed(Job job, Exception cause) {
        ArchiveFailure failure = ArchiveFailure.from(cause);
        if (job.restore != null) {
            try { job.restore.close(); job.restore = null; }
            catch (Exception cleanup) { if (failure.cancelled) failure = new ArchiveFailure("cleanup-failed", "取消后恢复材料尚未完整释放", false, cleanup); }
        }
        job.status = failure.cancelled ? "cancelled" : "failed";
        job.error = failure.cancelled ? null : object("code", failure.code, "message", failure.getMessage(), "canRetry", false);
        settled(job);
    }
    /** 状态和活动名额在同一锁内提交，读取到 ready/终态后即可执行或释放。 */
    private void settled(Job job) { job.running = false; job.touched = System.nanoTime(); if (active == job) active = null; }
    Map<String, Object> cancel(String restoreId) throws Exception {
        Job job; synchronized (this) { job = find(restoreId); }
        job.control.cancel();
        synchronized (this) {
            if (job.status.equals("ready")) {
                job.restore.close(); job.restore = null; job.preview = null; job.status = "cancelled"; job.touched = System.nanoTime();
            }
            return job.state();
        }
    }
    synchronized void release(String restoreId) throws Exception {
        Job job = find(restoreId); if (job.running) throw new ArchiveFailure("busy", "恢复仍在运行");
        if (job.restore != null) { job.restore.close(); job.restore = null; }
        if (!writer.retryCleanup()) throw new ArchiveFailure("cleanup-failed", "目标资源尚未完整释放");
        jobs.remove(job.id);
    }
    boolean retryCleanup() { return writer.retryCleanup(); }
    private void available() throws ArchiveFailure { if (closed) throw new ArchiveFailure("unsupported-operation", "恢复任务所有者已关闭"); }
    /** 仅由原生所有者退出时调用，Activity 插件销毁不关闭应用级恢复任务。 */
    @Override public void close() throws Exception {
        Job job; synchronized (this) { closed = true; job = active; }
        expiry.shutdownNow(); if (job != null) job.control.cancel();
        worker.shutdown(); if (!worker.awaitTermination(30, TimeUnit.SECONDS)) throw new ArchiveFailure("timeout", "恢复任务尚未释放");
        writer.close(); synchronized (this) { jobs.clear(); projects.clear(); }
    }
}
