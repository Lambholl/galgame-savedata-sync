package io.github.galgame.savedatasync;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import static io.github.galgame.savedatasync.TransferJson.*;
import static io.github.galgame.savedatasync.TransferSchema.*;

/**
 * 新复制的应用进程所有者：只读准备与确认执行分开，流、归档和网络留在原生。
 * reserve 在保活启动前占名额，begin 仅在系统接受通知后执行一次；任务不跨重启恢复。
 * 活动任务及未释放缓存占用同一个 TargetOperation；页面销毁不关闭此对象。
 */
final class SyncTransferEngine implements AutoCloseable {
    interface Local {
        String deviceId();
        Map<String, Object> snapshot(String rootId, ArchiveControl control) throws Exception;
        List<ArchiveModel.Source> sources(SyncPlanModel.Plan plan) throws Exception;
        default boolean backup(String projectId, String rootId) throws Exception { throw fail("unsupported-operation"); }
        default long checkReceiveSpace(SyncPlanModel.Plan plan, java.nio.file.Path cacheRoot, long cacheBytes, ArchiveControl control, SyncWriter.Execution execution) throws Exception { throw fail("unsupported-operation"); }
        default Map<String, Object> apply(SyncPlanModel.Plan plan, SyncWriter.Material material, ArchiveControl control, SyncWriter.Execution execution) throws Exception { throw fail("unsupported-operation"); }
        default boolean retryCleanup() throws Exception { return true; }
        default void close() throws Exception {}
    }
    private static final long RETENTION = TimeUnit.MINUTES.toNanos(10);
    private final TransferEngine transport;
    private final ArchiveAdapter archives;
    private final Local local;
    private final ExecutorService preparer = Executors.newSingleThreadExecutor(), worker = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService watcher = Executors.newSingleThreadScheduledExecutor();
    private final ScheduledExecutorService heartbeats = Executors.newSingleThreadScheduledExecutor();
    private final Map<String, Preparation> preparations = new LinkedHashMap<>();
    private final Map<String, Job> jobs = new LinkedHashMap<>();
    private final Set<String> used = new HashSet<>();
    private Preparation preparing;
    private Job active;
    private Job heartbeatOwner;
    private ArchiveControl heartbeatControl;
    private boolean closed;
    private static final class Preparation {
        final String id = UUID.randomUUID().toString();
        final Map<String, Object> binding;
        final TransferEngine.SyncConnection connection;
        final String direction;
        final ArchiveControl control = new ArchiveControl();
        String status = "preparing", scanId;
        Map<String, Object> preview, error;
        long settled;
        volatile boolean timedOut;
        boolean consumed, cancelRequested;
        Preparation(Map<String, Object> binding, TransferEngine.SyncConnection connection, String direction) { this.binding = binding; this.connection = connection; this.direction = direction; }
        boolean upload() { return direction.equals("android-to-windows"); }
        Map<String, Object> state() { return object("schemaVersion", 1, "preparationId", id, "direction", direction, "status", status, "error", error); }
    }
    private static final class Job {
        final Preparation preparation;
        final SyncPlanModel.Plan plan;
        final long acceptedAt = System.currentTimeMillis();
        final ArchiveControl control = new ArchiveControl();
        Map<String, Object> state, remote, remoteError;
        ArchiveModel.Manifest manifest;
        ArchiveAdapter.Artifact artifact;
        volatile boolean running = true;
        boolean started, remoteAttempted, cancelSent, uploadComplete, hasLease = true;
        long ended;
        volatile boolean timedOut, preparingArchive;
        Job(Preparation preparation, SyncPlanModel.Plan plan) { this.preparation = preparation; this.plan = plan; }
        String path() { return "/v1/sync/jobs/" + plan.id; }
    }
    SyncTransferEngine(TransferEngine transport, Local local) {
        this.transport = transport; this.archives = transport.syncArchive(); this.local = local;
        watcher.scheduleAtFixedRate(this::tick, 100, 100, TimeUnit.MILLISECONDS);
        heartbeats.scheduleAtFixedRate(this::heartbeat, 3, 3, TimeUnit.SECONDS);
    }
    private void available() throws ArchiveFailure { if (closed) throw fail("unsupported-operation"); }
    private void purge() {
        long now = System.nanoTime();
        jobs.values().removeIf(job -> !job.running && !job.hasLease && now - job.ended >= RETENTION);
        preparations.values().removeIf(preparation -> preparation != preparing && !jobs.containsKey(preparation.id) && now - preparation.settled >= RETENTION);
    }
    private void trim(Preparation retained) {
        purge();
        if (jobs.size() >= 32) for (Job job : new ArrayList<>(jobs.values())) if (!job.running && !job.hasLease) { jobs.remove(job.plan.id); break; }
        if (preparations.size() >= 32) for (Preparation preparation : new ArrayList<>(preparations.values())) if (preparation != preparing && preparation != retained && !jobs.containsKey(preparation.id)) { preparations.remove(preparation.id); break; }
    }
    private void tick() {
        Preparation preparation; Job job;
        synchronized (this) { purge(); preparation = preparing; job = active; }
        if (preparation != null) try { preparation.control.check(); } catch (ArchiveFailure failure) {
            if (!failure.cancelled) preparation.timedOut = true; preparation.control.cancel();
        }
        if (job != null && job.running) try { job.control.check(); } catch (ArchiveFailure failure) {
            if (!failure.cancelled) job.timedOut = true; job.control.cancel();
        }
    }
    private void heartbeat() {
        Job job; ArchiveControl control;
        synchronized (this) {
            job = active; if (closed || job == null || !job.running || !job.preparingArchive) return;
            control = shortControl(); heartbeatOwner = job; heartbeatControl = control;
        }
        try {
            Object raw = job.preparation.connection.http.json("GET", job.path(), job.preparation.connection.session, null, 200, control);
            SyncJobModel.state(raw, job.plan, null);
            // 心跳只核对通信，不写入远端快照，避免与清单/内容回执的顺序竞争。
        } catch (Exception ignored) { /* 后续提交或查询由主 worker 判断；心跳不重放写入。 */ }
        finally {
            control.cancel(); synchronized (this) { if (heartbeatControl == control) { heartbeatControl = null; heartbeatOwner = null; } }
        }
    }
    private void stopHeartbeat(Job job) {
        ArchiveControl control; synchronized (this) { control = heartbeatOwner == job ? heartbeatControl : null; }
        if (control != null) control.cancel();
    }
    /** 普通只读准备，不占传输名额或启动前台服务；返回后按 preparationId 查询。 */
    synchronized Map<String, Object> prepare(Object rawBinding, String direction) throws Exception {
        available(); one(direction, "android-to-windows", "windows-to-android");
        Map<String, Object> binding = SyncJobModel.binding(rawBinding);
        require(local.deviceId().equals(binding.get("localDeviceId"))); trim(null);
        if (preparing != null || preparations.size() >= 32) throw fail("busy");
        Preparation preparation = new Preparation(binding, transport.syncConnection(binding), direction);
        preparations.put(preparation.id, preparation); preparing = preparation;
        preparer.execute(() -> prepareNow(preparation)); return preparation.state();
    }
    private void prepareNow(Preparation preparation) {
        boolean hasRemoteScan = false;
        Map<String, Object> prepared = null; ArchiveFailure problem = null;
        try {
            Map<String, Object> binding = preparation.binding; TransferEngine.SyncConnection connection = preparation.connection;
            transport.refreshSync(connection, binding, preparation.control);
            // 能力版本和固定预算必须先协商；旧批量接口不能承担覆盖。
            Object advertised;
            try { advertised = connection.http.json("GET", "/v1/sync/capabilities", connection.session, null, 200, preparation.control); }
            catch (ArchiveFailure failure) {
                if (failure.code.equals("not-found") || failure.code.equals("unsupported-operation")) throw new ArchiveFailure("unsupported-operation", "请更新两端应用后再同步", false, failure);
                throw failure;
            }
            Map<String, Object> capabilities = shape(advertised,
                "schemaVersion", "deviceId", "canScan", "canCopy", "canBackup", "canRestore", "limits");
            if (number(capabilities.get("schemaVersion"), 0, 9007199254740991L) != 1) throw new ArchiveFailure("protocol-mismatch", "请更新两端应用后再同步");
            require(connection.deviceId.equals(capabilities.get("deviceId")));
            for (String key : new String[] {"canScan", "canCopy", "canBackup", "canRestore"}) one(capabilities.get(key), "supported", "unsupported", "unknown");
            if (!capabilities.get("canScan").equals("supported") || !capabilities.get("canCopy").equals("supported") || !capabilities.get("canBackup").equals("supported")) {
                throw new ArchiveFailure("unsupported-operation", "对端尚未提供本次同步能力，请更新两端应用");
            }
            Map<String, Object> limits = object("maxEntries", 10000, "maxDepth", 64, "maxPathLength", 4096, "maxNameLength", 255,
                "maxRetainedScans", 32, "backupRetention", 3, "snapshotLifetimeMs", 600000, "scanTimeoutMs", 1800000);
            if (!SyncPlanModel.same(limits, capabilities.get("limits"))) throw new ArchiveFailure("protocol-mismatch", "两端同步预算不同，请更新两端应用");
            String targetRoot = string(binding.get("remoteRootId")), sourceRoot = string(binding.get("localRootId"));
            Map<String, Object> remote = SyncJobModel.scan(connection.http.json("POST", "/v1/sync/scans", connection.session, object("schemaVersion", 1, "rootId", targetRoot), 202, preparation.control), connection.deviceId, targetRoot, null);
            synchronized (this) { preparation.scanId = id(remote.get("scanId")); }
            hasRemoteScan = true;
            Map<String, Object> source = SyncJobModel.snapshot(local.snapshot(sourceRoot, preparation.control), local.deviceId(), sourceRoot);
            while (remote.get("status").equals("running")) {
                preparation.control.check(); Thread.sleep(100);
                remote = SyncJobModel.scan(connection.http.json("GET", "/v1/sync/scans/" + preparation.scanId, connection.session, null, 200, preparation.control), connection.deviceId, targetRoot, preparation.scanId);
            }
            hasRemoteScan = false;
            if (!remote.get("status").equals("succeeded")) {
                if (remote.get("error") != null) throw new ArchiveFailure(string(map(remote.get("error")).get("code")), "电脑目录扫描未完成");
                throw new ArchiveFailure("io-failure", "电脑目录扫描已取消");
            }
            boolean remoteBackup = SyncJobModel.backup(connection.http.json("GET", "/v1/sync/projects/" + binding.get("remoteProjectId"), connection.session, null, 200, preparation.control), binding);
            boolean shouldBackup = preparation.upload() ? remoteBackup : local.backup(string(binding.get("projectId")), sourceRoot);
            transport.verifySync(connection, binding); preparation.control.check();
            Map<String, Object> preview = object("schemaVersion", 1, "preparationId", preparation.id, "direction", preparation.direction, "binding", binding,
                "source", preparation.upload() ? source : remote.get("snapshot"), "target", preparation.upload() ? remote.get("snapshot") : source, "shouldBackup", shouldBackup); bytes(preview);
            prepared = preview;
        } catch (Exception cause) {
            problem = ArchiveFailure.from(cause);
        } finally {
            if (hasRemoteScan) cancelScan(preparation);
            if (problem == null) try { preparation.control.check(); } catch (ArchiveFailure failure) { problem = failure; }
            synchronized (this) {
                if (problem == null) { preparation.preview = prepared; preparation.status = "ready"; }
                else {
                    preparation.status = !preparation.timedOut && (problem.cancelled || preparation.cancelRequested) ? "cancelled" : "failed";
                    preparation.error = preparation.status.equals("cancelled") ? null : object("code", preparation.timedOut ? "timeout" : problem.code,
                        "message", preparation.timedOut ? "同步准备已超时，请重新扫描" : problem.getMessage(), "canRetry", false);
                }
                preparation.settled = System.nanoTime(); if (preparing == preparation) preparing = null;
            }
        }
    }
    private void cancelScan(Preparation preparation) {
        ArchiveControl control = shortControl();
        try { preparation.connection.http.json("DELETE", "/v1/sync/scans/" + preparation.scanId, preparation.connection.session, null, 202, control); }
        catch (Exception ignored) { /* 只读扫描自行到期，取消回执丢失不重放。 */ }
        finally { control.cancel(); }
    }
    private Preparation preparation(String id) throws Exception {
        available(); id(id); purge(); Preparation preparation = preparations.get(id);
        if (preparation == null) throw fail("not-found"); return preparation;
    }
    synchronized Map<String, Object> preparationState(String id) throws Exception { return map(copy(preparation(id).state())); }
    synchronized Map<String, Object> preview(String id) throws Exception {
        Preparation preparation = preparation(id); if (preparation.preview == null) throw fail("task-conflict"); return map(copy(preparation.preview));
    }
    Map<String, Object> cancelPreparation(String id) throws Exception {
        Preparation preparation; synchronized (this) { preparation = preparation(id); if (preparation.consumed) throw fail("task-conflict"); preparation.cancelRequested = true; }
        preparation.control.cancel();
        synchronized (this) { if (preparation.status.equals("ready") && !preparation.consumed) { preparation.status = "cancelled"; preparation.preview = null; preparation.settled = System.nanoTime(); } return map(copy(preparation.state())); }
    }
    /** 消费同一预览且先占名额；调用者随后只允许 begin 或 failStart，不准自动重试 execute。 */
    synchronized Map<String, Object> reserve(String id, Object rawPlan) throws Exception {
        Preparation preparation = preparation(id); SyncPlanModel.Plan plan = new SyncPlanModel.Plan(rawPlan);
        if (!preparation.status.equals("ready") || preparation.consumed || used.contains(id)) throw fail("task-conflict");
        if (System.nanoTime() - preparation.settled >= RETENTION) throw fail("not-found");
        require(plan.id.equals(id) && plan.project.equals(preparation.binding.get(preparation.upload() ? "remoteProjectId" : "projectId")) && plan.reason.equals("copy") &&
            plan.value.get("direction").equals(preparation.direction) && preparation.preview != null &&
            SyncPlanModel.same(plan.source.value, preparation.preview.get("source")) && SyncPlanModel.same(plan.target.value, preparation.preview.get("target")) &&
            plan.backup == (Boolean) preparation.preview.get("shouldBackup"));
        transport.verifySync(preparation.connection, preparation.binding); bytes(SyncJobModel.request(plan, preparation.binding));
        long observed = number((preparation.upload() ? plan.source : plan.target).value.get("observedAt"), -BackupModel.MAX_DATE, BackupModel.MAX_DATE), now = System.currentTimeMillis();
        if (observed > now || now - observed > 600000) throw fail("not-found");
        trim(preparation); if (used.size() >= 4096 || jobs.size() >= 32 || active != null) throw fail("busy");
        Job job = new Job(preparation, plan); if (!TargetOperation.acquire(job)) throw fail("busy");
        long count = number(plan.value.get("transferFileCount"), 0, 1024);
        job.state = object("schemaVersion", 1, "jobId", id, "direction", preparation.direction, "role", preparation.upload() ? "sender" : "receiver", "status", "running", "stage", "preparing",
            "updatedAt", now, "cancelRequested", false, "result", null, "error", null, "cleanupError", null,
            "progress", object("sourceBytesRead", 0L, "archiveBytesTransferred", 0L, "fileBytesVerified", 0L, "fileBytesPublished", 0L,
                "totalFileBytes", plan.value.get("totalFileBytes"), "totalArchiveBytes", count == 0 ? 0L : null, "totalFiles", count, "verifiedFiles", 0L, "publishedFiles", 0L));
        preparation.consumed = true; used.add(id); jobs.put(id, job); active = job; return transfer(job);
    }
    synchronized void begin(String id) throws Exception {
        Job job = job(id); if (job.started || !job.running) throw fail("task-conflict"); job.started = true;
        try { worker.execute(() -> run(job)); }
        catch (java.util.concurrent.RejectedExecutionException cause) { job.started = false; throw fail("unsupported-operation"); }
    }
    synchronized void failStart(String id, Exception cause) throws Exception {
        Job job = job(id); if (job.started) throw fail("task-conflict");
        if (job.preparation.upload()) terminal(job, "failed", ArchiveFailure.from(cause).code);
        else receiverFailed(job, ArchiveFailure.from(cause));
        job.running = false; job.ended = System.nanoTime(); release(job);
    }
    private synchronized void progress(Job job, String stage, String counter, long value) throws Exception {
        if (!job.state.get("status").equals("running")) return;
        if (counter != null) {
            Map<String, Object> counters = map(job.state.get("progress"));
            long maximum = number(counters.get(counter.equals("sourceBytesRead") ? "totalFileBytes" : "totalArchiveBytes"), 0, 1140850688);
            if (value < number(counters.get(counter), 0, maximum) || value > maximum) throw new ArchiveFailure("source-changed", "源文件已超出确认计划");
            counters.put(counter, value);
        }
        job.state.put("stage", stage); job.state.put("updatedAt", System.currentTimeMillis());
    }
    private void run(Job job) {
        try {
            job.control.check(); transport.refreshSync(job.preparation.connection, job.preparation.binding, job.control);
            boolean remoteBackup = SyncJobModel.backup(job.preparation.connection.http.json("GET", "/v1/sync/projects/" + job.preparation.binding.get("remoteProjectId"), job.preparation.connection.session, null, 200, job.control), job.preparation.binding);
            boolean shouldBackup = job.preparation.upload() ? remoteBackup : local.backup(job.plan.project, job.plan.target.root);
            if (shouldBackup != job.plan.backup) throw new ArchiveFailure("source-changed", (job.preparation.upload() ? "电脑" : "手机") + "备份设置已变化，请重新确认");
            job.remoteAttempted = true;
            try { accept(job, job.preparation.connection.http.json("POST", "/v1/sync/jobs", job.preparation.connection.session, SyncJobModel.request(job.plan, job.preparation.binding), 201, job.control)); }
            catch (Exception lost) { refresh(job, job.control); }
            if (job.preparation.upload()) {
                long count = number(job.plan.value.get("transferFileCount"), 0, 1024);
                if (count > 0) upload(job);
                else { synchronized (this) { job.uploadComplete = true; terminal(job, "sent", null); } }
                awaitRemote(job);
            } else download(job);
        } catch (Exception cause) {
            ArchiveFailure failure = ArchiveFailure.from(cause);
            if (!job.preparation.upload()) synchronized (this) { if (job.state.get("status").equals("running")) receiverFailed(job, failure); }
            else if (!job.uploadComplete) synchronized (this) {
                boolean wasCancelled = !job.timedOut && (failure.cancelled || Boolean.TRUE.equals(job.state.get("cancelRequested")));
                terminal(job, wasCancelled ? "cancelled" : "failed", wasCancelled ? null : job.timedOut ? "timeout" : failure.code);
            }
            // 用户取消、总期限或内容未发完才取消远端；发完后的查询失败保留远端继续写入。
            if (job.remoteAttempted) {
                if (!job.preparation.upload() || !job.uploadComplete || failure.cancelled || job.timedOut) cancelRemote(job);
                else synchronized (this) { if (job.remote == null || job.remote.get("status").equals("running")) job.remoteError = error("result-unknown"); }
            }
        } finally {
            job.preparingArchive = false; stopHeartbeat(job);
            synchronized (this) {
                cleanup(job); job.running = false; job.ended = System.nanoTime();
                if (job.state.get("status").equals("running")) {
                    if (job.preparation.upload()) terminal(job, "failed", "io-failure"); else receiverFailed(job, fail("io-failure"));
                }
                if (job.hasLease && job.state.get("cleanupError") == null) release(job);
            }
        }
    }
    private void upload(Job job) throws Exception {
        synchronized (this) {
            if (job.remote == null || !job.remote.get("status").equals("running") || !job.remote.get("stage").equals("preparing")) throw fail("task-conflict");
        }
        transport.verifySync(job.preparation.connection, job.preparation.binding);
        job.preparingArchive = true;
        try {
            job.artifact = archives.prepare(job.plan.id, local.deviceId(), job.plan.source.root, local.sources(job.plan), job.control,
                (stage, value, total) -> { if (stage.equals("preparing")) progress(job, "preparing", "sourceBytesRead", value); });
        } finally { job.preparingArchive = false; stopHeartbeat(job); }
        try { SyncJobModel.manifest(job.artifact.manifest, job.plan); }
        catch (Exception changed) { throw new ArchiveFailure("source-changed", "源文件与确认时的内容或属性不同", false, changed); }
        synchronized (this) { job.manifest = job.artifact.manifest; map(job.state.get("progress")).put("totalArchiveBytes", job.manifest.archive.sizeBytes); }
        transport.verifySync(job.preparation.connection, job.preparation.binding);
        try { accept(job, job.preparation.connection.http.json("PUT", job.path() + "/manifest", job.preparation.connection.session, manifestJson(job.manifest), 200, job.control)); }
        catch (Exception lost) {
            refresh(job, job.control);
            ArchiveModel.Manifest remote = TransferSchema.manifest(job.preparation.connection.http.json("GET", job.path() + "/manifest", job.preparation.connection.session, null, 200, job.control));
            SyncJobModel.manifest(remote, job.plan); require(SyncPlanModel.same(manifestJson(remote), manifestJson(job.manifest)));
        }
        while (isRemoteRunning(job) && remoteStage(job).equals("preparing")) { job.control.check(); Thread.sleep(100); refresh(job, job.control); }
        if (!isRemoteRunning(job) || !remoteStage(job).equals("awaiting-content")) throw fail("task-conflict");
        progress(job, "transferring", null, 0);
        try {
            accept(job, job.preparation.connection.http.upload(job.path() + "/content", job.preparation.connection.session, job.manifest.archive, job.artifact.openArchive(), job.control,
                (stage, value, total) -> progress(job, "transferring", "archiveBytesTransferred", value)));
        } catch (Exception lost) { refresh(job, job.control); }
        synchronized (this) {
            require(job.remote != null && number(map(job.remote.get("progress")).get("archiveBytesTransferred"), 0, job.manifest.archive.sizeBytes) == job.manifest.archive.sizeBytes &&
                !java.util.Arrays.asList("preparing", "awaiting-content", "transferring").contains(job.remote.get("stage")));
            map(job.state.get("progress")).put("archiveBytesTransferred", job.manifest.archive.sizeBytes);
            job.uploadComplete = true; terminal(job, "sent", null);
            // 源快照发送完成后立即释放大缓存；任务名额和通知保留到 receiver 结果确定。
            cleanup(job);
        }
    }
    /** 下载只能认领一次；完整私有材料通过校验后才调用本机写入器。 */
    private void download(Job job) throws Exception {
        while (isRemoteRunning(job) && remoteStage(job).equals("preparing")) {
            job.control.check(); Thread.sleep(100);
            try { refresh(job, job.control); }
            catch (Exception cause) { job.control.check(); recover(job); synchronized (this) { if (job.remoteError != null) throw cause; } }
        }
        long count = number(job.plan.value.get("transferFileCount"), 0, 1024);
        if (count == 0) {
            require(job.remote != null && job.remote.get("status").equals("sent"));
        } else {
            if (!isRemoteRunning(job) || !remoteStage(job).equals("ready")) {
                if (job.remote != null && job.remote.get("error") != null) throw new ArchiveFailure(string(map(job.remote.get("error")).get("code")), "电脑未能准备本次归档");
                throw fail("task-conflict");
            }
            if (job.manifest == null) refresh(job, job.control);
            require(job.manifest != null); SyncJobModel.manifest(job.manifest, job.plan);
            verifyTargetContext(job.plan.project, job.plan.target.root);
            long extra = local.checkReceiveSpace(job.plan, archives.privateRoot(), job.manifest.archive.sizeBytes + job.manifest.totalFileBytes, job.control, execution(job));
            archives.checkReceiveSpace(job.manifest, extra);
            job.control.check(); progress(job, "transferring", null, 0); job.preparingArchive = true;
            java.io.InputStream input = job.preparation.connection.http.download(job.path() + "/content", job.preparation.connection.session, job.manifest.archive, job.control,
                (stage, value, total) -> progress(job, "transferring", "archiveBytesTransferred", value));
            job.artifact = archives.receive(job.manifest, input, job.control, (stage, value, total) -> {
                if (stage.equals("verifying")) synchronized (this) {
                    map(job.state.get("progress")).put("fileBytesVerified", value); progress(job, "verifying", null, 0);
                }
            });
            synchronized (this) {
                Map<String, Object> counters = map(job.state.get("progress")); counters.put("fileBytesVerified", job.manifest.totalFileBytes); counters.put("verifiedFiles", count);
            }
            // 完整体已独立校验；发送端末次回执丢失不改写本机已知结果，也不重发 GET 内容。
            recover(job);
        }
        job.preparingArchive = true;
        Map<String, Object> result = local.apply(job.plan, count == 0 ? null : material(job), job.control, execution(job));
        synchronized (this) { receiverResult(job, result); }
    }
    private SyncWriter.Material material(Job job) {
        return new SyncWriter.Material() {
            @Override public Map<String, Object> snapshot() throws Exception { return map(copy(job.plan.source.value)); }
            @Override public ArchiveModel.Source file(String entryId) throws Exception {
                for (ArchiveModel.PreparedFile file : job.manifest.files) if (file.sourceEntryId.equals(entryId)) return new ArchiveModel.Source() {
                    @Override public void validateRoot(String rootId) throws ArchiveFailure { require(rootId.equals(job.plan.source.root)); }
                    @Override public ArchiveModel.Observation observe(ArchiveControl control) throws Exception {
                        control.check(); return new ArchiveModel.Observation(job.plan.id + ":" + file.fileId, file.sourceEntryId, file.sourceParentId, file.sourceName, file.sizeBytes, file.sourceModifiedAt);
                    }
                    @Override public java.io.InputStream open(ArchiveControl control) throws Exception { control.check(); return job.artifact.openFile(file.fileId); }
                };
                throw fail("invalid-request");
            }
        };
    }
    private SyncWriter.Execution execution(Job job) {
        return new SyncWriter.Execution(job, job.acceptedAt, new SyncWriter.Observer() {
            @Override public void stage(String stage) throws Exception { progress(job, stage, null, 0); }
            @Override public void outcome(Map<String, Object> result) throws Exception {
                if (!result.get("status").equals("succeeded") || result.get("action").equals("create-directory")) return;
                synchronized (SyncTransferEngine.this) {
                    Map<String, Object> counters = map(job.state.get("progress"));
                    counters.put("publishedFiles", number(counters.get("publishedFiles"), 0, 1024) + 1);
                    counters.put("fileBytesPublished", number(counters.get("fileBytesPublished"), 0, BackupModel.MAX_TOTAL) + number(result.get("sizeBytes"), 0, BackupModel.MAX_FILE));
                    job.state.put("updatedAt", System.currentTimeMillis());
                }
            }
        });
    }
    /** SAF 后端每次复核当前 native 会话、目标项目/根与本机备份设置。 */
    synchronized void verifyTargetContext(String project, String root) throws Exception {
        Job job = active;
        if (job == null || !job.running || job.preparation.upload() || !job.plan.project.equals(project) || !job.plan.target.root.equals(root) || !TargetOperation.owns(job)) throw fail("permission-denied");
        transport.verifySync(job.preparation.connection, job.preparation.binding);
        if (local.backup(project, root) != job.plan.backup) throw new ArchiveFailure("source-changed", "手机备份设置已变化，请重新确认");
    }
    private void receiverFailed(Job job, ArchiveFailure cause) {
        try {
            boolean cancelled = !job.timedOut && (cause.cancelled || Boolean.TRUE.equals(job.state.get("cancelRequested")));
            String code = job.timedOut ? "timeout" : cause.code.equals("result-unknown") ? "io-failure" : cause.code;
            Object failure = cancelled ? null : error(code); List<Object> outcomes = new ArrayList<>();
            for (int i = 0; i < job.plan.writes.size(); i++) {
                Map<String, Object> operation = job.plan.writes.get(i);
                outcomes.add(object("path", operation.get("path"), "action", operation.get("action"), "status", i == 0 ? cancelled ? "cancelled" : "failed" : "not-attempted", "sizeBytes", null, "sha256", null, "error", i == 0 ? failure : null));
            }
            receiverResult(job, object("schemaVersion", 1, "planId", job.plan.id, "backupId", null, "outcomes", outcomes, "error", failure, "cleanupError", cause.cleanupFailure == null ? null : error("cleanup-failed")));
            if (cancelled) { job.state.put("cancelRequested", true); job.state.put("status", "cancelled"); }
        } catch (Exception invalid) { throw new IllegalStateException("原生失败结果与确认计划不符", invalid); }
    }
    private void receiverResult(Job job, Map<String, Object> result) throws Exception {
        long[] actual = SyncJobModel.result(result, job.plan); boolean complete = true, cancelled = false;
        for (Object item : list(result.get("outcomes"))) {
            String status = string(map(item).get("status")); complete &= status.equals("succeeded"); cancelled |= status.equals("cancelled");
        }
        Map<String, Object> counters = map(job.state.get("progress")); counters.put("publishedFiles", actual[0]); counters.put("fileBytesPublished", actual[1]);
        Object failure = result.get("error");
        String status = failure != null && map(failure).get("code").equals("result-unknown") ? "unknown" : complete && failure == null ? "succeeded" : cancelled ? "cancelled" : "failed";
        job.state.put("result", result); job.state.put("error", failure); job.state.put("cleanupError", result.get("cleanupError"));
        job.state.put("status", status); job.state.put("stage", "done"); job.state.put("updatedAt", System.currentTimeMillis());
        if (cancelled) job.state.put("cancelRequested", true);
    }
    private synchronized boolean isRemoteRunning(Job job) { return job.remote != null && job.remote.get("status").equals("running"); }
    private synchronized String remoteStage(Job job) { return job.remote == null ? "preparing" : (String) job.remote.get("stage"); }
    private void awaitRemote(Job job) throws Exception {
        while (isRemoteRunning(job)) {
            job.control.check(); Thread.sleep(100);
            try { refresh(job, job.control); }
            catch (Exception cause) {
                job.control.check(); recover(job);
                synchronized (this) { if (job.remoteError != null) throw cause; }
                // 已重新读到运行状态时继续等同一任务，保持通知和名额，不提前结束。
            }
        }
    }
    private void refresh(Job job, ArchiveControl control) throws Exception {
        transport.verifySync(job.preparation.connection, job.preparation.binding);
        Object raw = job.preparation.connection.http.json("GET", job.path(), job.preparation.connection.session, null, 200, control);
        if (!job.preparation.upload() && job.manifest == null && number(job.plan.value.get("transferFileCount"), 0, 1024) > 0 && map(map(raw).get("progress")).get("totalArchiveBytes") != null) {
            ArchiveModel.Manifest manifest = TransferSchema.manifest(job.preparation.connection.http.json("GET", job.path() + "/manifest", job.preparation.connection.session, null, 200, control));
            SyncJobModel.manifest(manifest, job.plan);
            synchronized (this) { job.manifest = manifest; map(job.state.get("progress")).put("totalArchiveBytes", manifest.archive.sizeBytes); }
        }
        accept(job, raw);
    }
    private synchronized void accept(Job job, Object raw) throws Exception {
        Map<String, Object> state = SyncJobModel.state(raw, job.plan, job.manifest);
        if (job.remote != null) {
            if (!job.remote.get("status").equals("running")) {
                require(state.get("status").equals(job.remote.get("status")));
                if (job.remote.get("result") != null) {
                    Map<String, Object> previousResult = new LinkedHashMap<>(map(job.remote.get("result"))), nextResult = new LinkedHashMap<>(map(state.get("result")));
                    previousResult.remove("cleanupError"); nextResult.remove("cleanupError"); require(SyncPlanModel.same(previousResult, nextResult));
                } else require(state.get("result") == null);
            }
            Map<String, Object> previous = map(job.remote.get("progress")), next = map(state.get("progress"));
            for (String key : new String[] {"sourceBytesRead", "archiveBytesTransferred", "fileBytesVerified", "fileBytesPublished", "verifiedFiles", "publishedFiles"}) require(number(next.get(key), 0, 1140850688) >= number(previous.get(key), 0, 1140850688));
            if (previous.get("totalArchiveBytes") != null) require(SyncPlanModel.same(previous.get("totalArchiveBytes"), next.get("totalArchiveBytes")));
        }
        job.remote = state; job.remoteError = null;
    }
    private static ArchiveControl shortControl() { return new ArchiveControl(System::nanoTime, TimeUnit.SECONDS.toNanos(5)); }
    private void recover(Job job) { synchronized (job) {
        ArchiveControl control = shortControl();
        try { refresh(job, control); }
        catch (Exception cause) { synchronized (this) { job.remoteError = error("result-unknown"); } }
        finally { control.cancel(); }
    } }
    private void cancelRemote(Job job) { synchronized (job) {
        ArchiveControl control = shortControl(); boolean shouldCancel;
        synchronized (this) { shouldCancel = !job.cancelSent && (job.remote == null || job.remote.get("status").equals("running")); if (shouldCancel) job.cancelSent = true; }
        try {
            if (shouldCancel) {
                try { accept(job, job.preparation.connection.http.json("DELETE", job.path(), job.preparation.connection.session, null, 202, control)); }
                catch (Exception lost) { /* 只查询实际结果，DELETE 也不自动重发。 */ }
            }
            refresh(job, control);
            while (isRemoteRunning(job)) { control.check(); Thread.sleep(100); refresh(job, control); }
        } catch (Exception cause) { synchronized (this) { job.remoteError = error("result-unknown"); } }
        finally { control.cancel(); }
    } }
    private synchronized void terminal(Job job, String status, String code) {
        job.state.put("status", status); job.state.put("stage", "done"); job.state.put("error", code == null ? null : error(code));
        if (status.equals("cancelled")) job.state.put("cancelRequested", true); job.state.put("updatedAt", System.currentTimeMillis());
    }
    private boolean cleanup(Job job) {
        try {
            if (!local.retryCleanup()) throw fail("cleanup-failed");
            if (job.artifact != null) { job.artifact.close(); job.artifact = null; } archives.retryCleanup();
            job.state.put("cleanupError", null); if (job.state.get("result") != null) map(job.state.get("result")).put("cleanupError", null); return true;
        } catch (Exception cause) {
            job.state.put("cleanupError", error("cleanup-failed"));
            if (job.state.get("result") != null) mapUnchecked(job.state.get("result")).put("cleanupError", error("cleanup-failed")); return false;
        }
    }
    private void release(Job job) { TargetOperation.release(job); job.hasLease = false; if (active == job) active = null; }
    private Job job(String id) throws Exception { available(); id(id); purge(); Job job = jobs.get(id); if (job == null) throw fail("not-found"); return job; }
    private Map<String, Object> transfer(Job job) throws Exception { return map(copy(object("schemaVersion", 1, "jobId", job.plan.id, "local", job.state, "remote", job.remote, "remoteError", job.remoteError))); }
    Map<String, Object> query(String id, boolean refresh) throws Exception {
        Job job; synchronized (this) { job = job(id); }
        if (refresh && !job.running && job.remoteAttempted) recover(job);
        synchronized (this) { return transfer(job); }
    }
    synchronized Object manifest(String id) throws Exception { Job job = job(id); return job.manifest == null ? null : copy(manifestJson(job.manifest)); }
    synchronized Object current() throws Exception { available(); purge(); Job last = active; if (last == null) for (Job job : jobs.values()) last = job; return last == null ? null : last.plan.id; }
    Map<String, Object> cancel(String id, boolean timeout) throws Exception {
        Job job; synchronized (this) { job = job(id); if (timeout) job.timedOut = true; job.state.put("cancelRequested", !timeout); }
        job.control.cancel(); if (!job.running && job.remoteAttempted) worker.execute(() -> cancelRemote(job));
        synchronized (this) { return transfer(job); }
    }
    synchronized void retryCleanup() throws Exception {
        if (active == null) return; if (active.running) throw fail("busy");
        if (!cleanup(active)) throw fail("cleanup-failed"); release(active);
    }
    synchronized void release(String id) throws Exception {
        available(); id(id); Job job = jobs.get(id); Preparation preparation = preparations.get(id);
        if (job != null && (job.running || job.hasLease)) throw fail("busy"); if (preparation == preparing) throw fail("busy");
        if (job == null && preparation == null) throw fail("not-found"); jobs.remove(id); preparations.remove(id);
    }
    synchronized boolean busy() { return active != null; }
    synchronized String activeId() { return active == null ? null : active.plan.id; }
    /** 通知只读取小快照，不在系统主线程复制整份计划、清单和结果。 */
    synchronized Map<String, Object> notice() {
        if (active == null) return null;
        String stage = (String) active.state.get("stage");
        Map<String, Object> progress = mapUnchecked(active.state.get("progress"));
        if (active.preparation.upload() && active.running && active.uploadComplete) {
            stage = active.remote != null && active.remote.get("status").equals("running") ? (String) active.remote.get("stage") : "sent";
            if (active.remote != null) progress = mapUnchecked(active.remote.get("progress"));
        }
        return object("transferId", active.plan.id, "upload", active.preparation.upload(), "running", active.running, "stage", stage, "progress", new LinkedHashMap<>(progress));
    }
    @SuppressWarnings("unchecked") private static Map<String, Object> mapUnchecked(Object value) { return (Map<String, Object>) value; }
    /** 仅由原生所有者退出/验证调用；插件销毁不取消任务。 */
    @Override public void close() throws Exception {
        synchronized (this) { closed = true; if (preparing != null) preparing.control.cancel(); if (active != null) active.control.cancel(); if (heartbeatControl != null) heartbeatControl.cancel(); }
        watcher.shutdownNow(); heartbeats.shutdownNow(); preparer.shutdown(); worker.shutdown();
        if (!preparer.awaitTermination(30, TimeUnit.SECONDS) || !worker.awaitTermination(30, TimeUnit.SECONDS) || !heartbeats.awaitTermination(10, TimeUnit.SECONDS)) throw fail("timeout");
        synchronized (this) { if (active != null && !cleanup(active)) throw fail("cleanup-failed"); if (active != null) release(active); preparations.clear(); jobs.clear(); }
        local.close();
    }
}
