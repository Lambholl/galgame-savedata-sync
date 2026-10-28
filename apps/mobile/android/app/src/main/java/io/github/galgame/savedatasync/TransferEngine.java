package io.github.galgame.savedatasync;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static io.github.galgame.savedatasync.TransferJson.*;
import static io.github.galgame.savedatasync.TransferSchema.*;

/**
 * 原生双向任务所有者。用户发起 start，已发起的任务由持续通知服务持有，不随 Activity 暂停取消。
 * 不持久化地址、清单或历史哈希；query 只读快照，失败响应不授权重发 POST/PUT。
 * 下载准备清单前 query 返回 task-conflict；此时取消/失败仍生成全项未尝试的本地终态。
 */
final class TransferEngine {
    interface Local {
        String deviceId();
        List<ArchiveModel.Source> sources(String rootId, List<Object> selections) throws Exception;
    }
    interface Listener { void state(Map<String, Object> value); }
    private static final AtomicReference<TransferEngine> PROCESS = new AtomicReference<>();
    private final ArchiveAdapter archives;
    private final NewFilePublisher publisher;
    private final Local local;
    private final Listener listener;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> { Thread t = new Thread(r, "native-transfers"); t.setDaemon(true); return t; });
    private final ScheduledExecutorService watch = Executors.newSingleThreadScheduledExecutor(r -> { Thread t = new Thread(r, "transfer-task-deadline"); t.setDaemon(true); return t; });
    private final Map<String, Job> results = new LinkedHashMap<>();
    private final Set<String> used = new HashSet<>();
    private final Map<String, Map<String, Object>> remoteRoots = new HashMap<>(), remoteEntries = new HashMap<>();
    private final long totalMillis, retentionMillis;
    private final int pollMillis;
    private TransferHttp http;
    private Map<String, Object> remoteDevice;
    private String session, remoteDeviceId;
    private static final class Connection {
        final TransferHttp http;
        final Map<String, Object> descriptor;
        Map<String, Object> hello, reply;
        boolean announced;
        Connection(TransferHttp http, Map<String, Object> descriptor) { this.http = http; this.descriptor = descriptor; }
    }
    private final Map<String, Connection> connections = new LinkedHashMap<>();
    private Job active;
    private boolean closed, connecting;
    private static final class Job {
        final String id, direction, root;
        final Map<String, Object> selection;
        final List<Object> targets;
        final TransferHttp http;
        final String session, deviceId;
        Map<String, Object> connection;
        final Map<String, Map<String, Object>> baselines = new HashMap<>();
        final ArchiveControl control;
        final long started = System.nanoTime();
        ArchiveModel.Manifest manifest;
        ArchiveAdapter.Artifact artifact;
        Map<String, Object> state, remote;
        ArchiveFailure failure, remoteFailure;
        long source, transferred, verified, published, ended, lastEvent;
        int verifiedFiles, publishedFiles;
        boolean running = true, remoteAttempted, uploadBodyAttempted, allVerified;
        volatile boolean timedOut;
        String cleanup = "not-needed", cleanupError;
        RuntimeException notificationFailure;
        Job(Map<String, Object> request, String root, List<Object> targets, boolean upload, TransferHttp http, String session,
            String deviceId, long totalMillis) throws ArchiveFailure {
            id = string(request.get("transferId")); selection = request; this.root = root; this.targets = targets;
            direction = upload ? "android-to-windows" : "windows-to-android"; this.http = http; this.session = session; this.deviceId = deviceId;
            control = new ArchiveControl(System::nanoTime, TimeUnit.MILLISECONDS.toNanos(totalMillis));
        }
        boolean upload() { return direction.equals("android-to-windows"); }
        String path() { return "/v1/transfers/" + id; }
        int count() { return ((List<?>) selection.get("files")).size(); }
    }
    TransferEngine(ArchiveAdapter archives, NewFilePublisher publisher, Local local, Listener listener) {
        this(archives, publisher, local, listener, 1800000, 600000, 100);
    }
    TransferEngine(ArchiveAdapter archives, NewFilePublisher publisher, Local local, Listener listener, long totalMillis, long retentionMillis, int pollMillis) {
        if (totalMillis <= 0 || totalMillis > 1800000 || retentionMillis <= 0 || retentionMillis > 600000 || pollMillis < 1) throw new IllegalArgumentException("Invalid transfer budgets");
        this.archives = archives; this.publisher = publisher; this.local = local; this.listener = listener;
        this.totalMillis = totalMillis; this.retentionMillis = retentionMillis; this.pollMillis = pollMillis;
        watch.scheduleAtFixedRate(this::tick, 100, 100, TimeUnit.MILLISECONDS);
    }
    private void tick() {
        Job job;
        synchronized (this) {
            long now = System.nanoTime();
            results.values().removeIf(j -> {
                if (j != active && !j.running && now - j.ended >= TimeUnit.MILLISECONDS.toNanos(retentionMillis)) { outcomes.remove(j.id); return true; }
                return false;
            });
            job = active;
            if (job != null && job.running && now - job.started >= TimeUnit.MILLISECONDS.toNanos(totalMillis)) job.timedOut = true;
        }
        if (job != null && job.timedOut) job.control.cancel();
    }
    private synchronized void available() throws ArchiveFailure { if (closed) throw fail("unsupported-operation"); }
    Map<String, Object> connect(TransferHttp client, ArchiveControl control) throws Exception {
        synchronized (this) { available(); if (active != null || TargetOperation.hasWork() || connecting || !connections.isEmpty()) throw fail("busy"); connecting = true; http = null; }
        try {
            Map<String, Object> descriptor = device(client.json("GET", "/v1/device", null, null, 200, control));
            synchronized (this) {
                available(); control.check(); http = client; remoteDevice = descriptor; session = string(descriptor.get("sessionId"));
                remoteDeviceId = string(map(descriptor.get("device")).get("deviceId"));
                if (!connections.containsKey(remoteDeviceId) && connections.size() >= 32) throw fail("resource-limit");
                connections.put(remoteDeviceId, new Connection(client, descriptor)); remoteRoots.clear(); remoteEntries.clear();
            }
            return map(copy(descriptor));
        } finally { synchronized (this) { connecting = false; } }
    }
    synchronized void disconnect() throws ArchiveFailure {
        available(); if (active != null || TargetOperation.hasWork() || connecting) throw fail("busy"); connections.remove(remoteDeviceId); http = null; remoteDevice = null; session = null; remoteRoots.clear(); remoteEntries.clear();
    }
    synchronized List<Object> connections() throws Exception {
        available(); List<Object> result = new ArrayList<>();
        for (Connection value : connections.values()) result.add(copy(value.descriptor));
        return result;
    }
    synchronized Map<String, Object> selectDevice(String id) throws Exception {
        available(); if (connecting || (TargetOperation.hasWork() && !id.equals(remoteDeviceId))) throw fail("busy"); Connection value = connections.get(id);
        if (value == null) throw fail("not-found");
        http = value.http; remoteDevice = value.descriptor; remoteDeviceId = id;
        session = string(remoteDevice.get("sessionId")); remoteRoots.clear(); remoteEntries.clear();
        return map(copy(remoteDevice));
    }
    void disconnectDevice(String id, ArchiveControl control) throws Exception {
        Connection value;
        synchronized (this) { available(); if (connecting || active != null || TargetOperation.hasWork()) throw fail("busy"); value = connections.get(id); }
        if (value != null) try {
            value.http.json("POST", "/v1/catalog", string(value.descriptor.get("sessionId")), object("deviceId", local.deviceId(), "goodbye", true), 200, control);
        } catch (Exception ignored) { /* 本机仍断开；电脑收不到告别时由在线期限释放名额。 */ }
        synchronized (this) {
            connections.remove(id);
            if (id.equals(remoteDeviceId)) { http = null; remoteDevice = null; session = null; remoteRoots.clear(); remoteEntries.clear(); }
        }
    }
    /** 每台电脑独立交换目录元数据；不会改变当前浏览连接或活动任务。 */
    Object exchangeCatalog(String id, Object payload, String name, ArchiveControl control) throws Exception {
        Connection value; synchronized (this) { available(); value = connections.get(id); }
        if (value == null) throw fail("not-found");
        Map<String, Object> catalog = shape(copy(payload), "games", "links", "answer");
        List<Object> games = list(catalog.get("games")); require(games.size() <= 128 && list(catalog.get("links")).size() <= 128);
        List<Object> roots = new ArrayList<>(); Set<String> rootIds = new HashSet<>();
        for (Object entry : games) {
            Map<String, Object> game = shape(entry, "id", "name", "root"); id(game.get("id"));
            require(string(game.get("name")).length() <= 128);
            if (game.get("root") != null && rootIds.add(id(map(game.get("root")).get("rootId")))) roots.add(game.get("root"));
        }
        TransferSchema.roots(roots, local.deviceId());
        Map<String, Object> hello = object("deviceId", local.deviceId(), "name", name, "games", games, "links", catalog.get("links"), "answer", catalog.get("answer"));
        boolean isNewConnection;
        synchronized (this) { isNewConnection = !value.announced; }
        Object reply = value.http.json("POST", "/v1/catalog", string(value.descriptor.get("sessionId")), hello, 200, control, isNewConnection);
        Map<String, Object> replyMap = shape(copy(reply), "games", "links", "request");
        synchronized (this) {
            require(connections.get(id) == value);
            value.announced = true; value.hello = map(copy(hello)); value.reply = replyMap;
        }
        return reply;
    }
    /** 新编排固定当前已交换目录表的连接身份；文件材料仍由同一个原生缓存适配器持有。 */
    static final class SyncConnection {
        final TransferHttp http;
        final String session, deviceId;
        private final Connection identity;
        SyncConnection(Connection identity, String localDeviceId) throws Exception {
            this.identity = identity; http = identity.http.forSync(localDeviceId);
            session = id(identity.descriptor.get("sessionId")); deviceId = id(map(identity.descriptor.get("device")).get("deviceId"));
        }
    }
    synchronized SyncConnection syncConnection(Map<String, Object> binding) throws Exception {
        connected(); SyncJobModel.binding(binding);
        require(local.deviceId().equals(binding.get("localDeviceId")) && remoteDeviceId.equals(binding.get("remoteDeviceId")));
        Connection connection = connections.get(remoteDeviceId);
        if (connection == null || !connection.announced || connection.hello == null || connection.reply == null) throw fail("session-mismatch");
        SyncConnection result = new SyncConnection(connection, local.deviceId()); verifySync(result, binding); return result;
    }
    synchronized void verifySync(SyncConnection connection, Map<String, Object> binding) throws Exception {
        available(); Connection current = connections.get(connection.deviceId);
        if (connecting || current != connection.identity || http != current.http || !connection.session.equals(session) ||
            !connection.deviceId.equals(remoteDeviceId)) throw fail("session-mismatch");
        require(local.deviceId().equals(binding.get("localDeviceId")) && connection.deviceId.equals(binding.get("remoteDeviceId")));
        SyncJobModel.catalogBinding(current.hello, current.reply, binding);
    }
    void refreshSync(SyncConnection connection, Map<String, Object> binding, ArchiveControl control) throws Exception {
        Map<String, Object> hello;
        synchronized (this) { verifySync(connection, binding); hello = map(copy(connection.identity.hello)); }
        exchangeCatalog(connection.deviceId, object("games", hello.get("games"), "links", hello.get("links"), "answer", null), string(hello.get("name")), control);
        synchronized (this) { verifySync(connection, binding); }
    }
    ArchiveAdapter syncArchive() { return archives; }
    private synchronized TransferHttp connected() throws ArchiveFailure { available(); if (connecting) throw fail("busy"); if (http == null) throw fail("not-found"); return http; }
    List<Object> roots(ArchiveControl control) throws Exception {
        TransferHttp client; String currentSession, deviceId;
        synchronized (this) { client = connected(); currentSession = session; deviceId = remoteDeviceId; }
        List<Object> values = TransferSchema.roots(client.json("GET", "/v1/roots", currentSession, null, 200, control), deviceId);
        synchronized (this) {
            available(); control.check(); require(http == client && currentSession.equals(session)); remoteRoots.clear(); remoteEntries.clear();
            for (Object r : values) remoteRoots.put(string(map(r).get("rootId")), map(r));
        }
        return list(copy(values));
    }
    Map<String, Object> directory(String rootId, String parentId, ArchiveControl control) throws Exception {
        id(rootId); parent(parentId); TransferHttp client; String currentSession;
        synchronized (this) {
            client = connected(); currentSession = session; require(remoteRoots.containsKey(rootId));
            if (parentId != null) { Map<String, Object> p = remoteEntries.get(rootId + "\n" + parentId); require(p != null && "directory".equals(p.get("kind"))); }
        }
        String path = "/v1/roots/" + rootId + "/entries" + (parentId == null ? "" : "?parentId=" + parentId);
        Map<String, Object> listing = TransferSchema.directory(client.json("GET", path, currentSession, null, 200, control), rootId, parentId);
        synchronized (this) {
            available(); control.check(); require(http == client && currentSession.equals(session));
            for (Object e : list(listing.get("entries"))) {
                String key = rootId + "\n" + string(map(e).get("entryId"));
                if (!remoteEntries.containsKey(key) && remoteEntries.size() >= 32768) throw fail("resource-limit");
                remoteEntries.put(key, map(e));
            }
        }
        return map(copy(listing));
    }
    /** start 的参数仅含 ID/单文件名；调用方拥有返回句柄，不拥有原生流。 */
    synchronized Map<String, Object> start(Object options, boolean upload) throws Exception {
        available(); connected(); Map<String, Object> arguments = shape(copy(options), "request", "targetRootId", "targets");
        Map<String, Object> request = selection(arguments.get("request")); List<Object> files = list(request.get("files"));
        String targetRoot = id(arguments.get("targetRootId")); List<Object> targets = targets(arguments.get("targets"), files.size());
        if (upload) require(remoteRoots.containsKey(targetRoot));
        else {
            require(remoteRoots.containsKey(request.get("sourceRootId")));
            for (Object f : files) { Map<String, Object> e = remoteEntries.get(request.get("sourceRootId") + "\n" + map(f).get("entryId")); require(e != null && "file".equals(e.get("kind"))); }
        }
        String id = string(request.get("transferId")); if (used.contains(id)) throw fail("task-conflict");
        if (used.size() >= 4096 || results.size() >= 32 || active != null || !TargetOperation.acquire(this)) throw fail("busy");
        if (!PROCESS.compareAndSet(null, this)) { TargetOperation.release(this); throw fail("busy"); }
        Job job = new Job(request, targetRoot, targets, upload, http, session, remoteDeviceId, totalMillis);
        job.connection = remoteDevice;
        if (!upload) for (Object f : files) {
            String entry = string(map(f).get("entryId")); job.baselines.put(entry, map(copy(remoteEntries.get(request.get("sourceRootId") + "\n" + entry))));
        }
        used.add(id); results.put(id, job); active = job;
        if (upload) running(job, "preparing");
        worker.execute(() -> run(job)); return object("transferId", id);
    }
    private void running(Job job, String stage) {
        synchronized (this) {
            job.state = object("transferId", job.id, "direction", job.direction, "role", job.upload() ? "sender" : "receiver", "updatedAt", System.currentTimeMillis(),
                "status", "running", "stage", stage, "cancelRequested", cancelled(job), "fileResults", job.upload() ? null : fileResults(job),
                "progress", object("sourceBytesRead", job.source, "archiveBytesTransferred", job.transferred, "fileBytesVerified", job.verified,
                    "fileBytesPublished", job.published, "totalFileBytes", job.manifest == null ? null : job.manifest.totalFileBytes,
                    "totalArchiveBytes", job.manifest == null ? null : job.manifest.archive.sizeBytes, "totalFiles", job.count(),
                    "verifiedFiles", job.verifiedFiles, "publishedFiles", job.publishedFiles));
        }
        emit(job, false);
    }
    private static boolean cancelled(Job job) { try { job.control.check(); return false; } catch (ArchiveFailure cause) { return true; } }
    private final Map<String, List<Object>> outcomes = new HashMap<>();
    private List<Object> fileResults(Job job) { return new ArrayList<>(outcomes.computeIfAbsent(job.id, ignored -> new ArrayList<>())); }
    private void emit(Job job, boolean force) {
        if (listener == null) return;
        try {
            Map<String, Object> snapshot;
            synchronized (this) {
                if (job.state == null || (!force && System.nanoTime() - job.lastEvent < TimeUnit.MILLISECONDS.toNanos(100))) return;
                job.lastEvent = System.nanoTime(); snapshot = map(copy(job.state));
            }
            listener.state(snapshot);
        } catch (Exception cause) { job.notificationFailure = new IllegalStateException("状态通知失败；可通过 query 获取实际状态", cause); }
    }
    private void run(Job job) {
        try {
            job.control.check();
            if (job.upload()) send(job); else receive(job);
        } catch (Exception cause) {
            ArchiveFailure failure = NewFilePublisher.failure(cause);
            if (job.timedOut) failure = fail("timeout");
            else { try { job.control.check(); } catch (ArchiveFailure cancelled) { failure = cancelled; } }
            synchronized (this) { job.failure = failure; }
            if (job.remoteAttempted && (failure.cancelled || !job.upload())) cancelRemote(job);
        } finally {
            if (job.state != null && "running".equals(job.state.get("status"))) running(job, "cleaning");
            boolean clean = cleanup(job);
            finish(job);
            synchronized (this) { job.running = false; job.ended = System.nanoTime(); if (clean) release(job); }
            emit(job, true);
        }
    }
    private void send(Job job) throws Exception {
        List<ArchiveModel.Source> sources = local.sources(string(job.selection.get("sourceRootId")), list(job.selection.get("files")));
        job.artifact = archives.prepare(job.id, local.deviceId(), string(job.selection.get("sourceRootId")), sources, job.control,
            (stage, count, total) -> { if (stage.equals("preparing")) { synchronized (this) { job.source = Math.max(job.source, count); } running(job, "preparing"); } });
        synchronized (this) { job.manifest = job.artifact.manifest; job.source = job.manifest.totalFileBytes; }
        running(job, "ready"); job.control.check();
        Map<String, Object> request = receiveRequest(job.manifest, job.root, job.targets); job.remoteAttempted = true;
        Object accepted;
        try { accepted = job.http.json("POST", "/v1/transfers/uploads", job.session, request, 201, job.control); }
        catch (ArchiveFailure cause) {
            if (!cause.code.equals("network-failure") && !cause.code.equals("timeout")) throw cause;
            // 登记回执丢失只查询同 ID，不能重发 POST。若实际已接纳，则继续唯一一次内容发送。
            accepted = job.http.json("GET", job.path(), job.session, null, 200, job.control);
        }
        Map<String, Object> remote = acceptRemote(job, accepted);
        require("running".equals(remote.get("status")) && "awaiting-content".equals(remote.get("stage")));
        running(job, "transferring"); job.uploadBodyAttempted = true;
        try {
            Object response = job.http.upload(job.path() + "/content", job.session, job.manifest.archive, job.artifact.openArchive(), job.control,
                (stage, count, total) -> { synchronized (this) { job.transferred = count; } running(job, "transferring"); });
            acceptRemote(job, response);
        } catch (Exception cause) {
            if (cancelled(job)) throw cause;
            try { pollRemote(job, false); }
            catch (Exception queryFailure) { synchronized (this) { job.remoteFailure = fail("result-unknown"); } }
            if (job.transferred != job.manifest.archive.sizeBytes) throw fail("result-unknown");
        }
        // sent 只确认本机完整发送，不将 Windows receiver 成功包装成本机发布。
        terminalSender(job, "sent", null);
        try { pollRemote(job, true); } catch (Exception cause) {
            if (cancelled(job)) cancelRemote(job);
            synchronized (this) { job.remoteFailure = fail("result-unknown"); }
        }
    }
    private void receive(Job job) throws Exception {
        job.remoteAttempted = true;
        Object accepted;
        try { accepted = job.http.json("POST", "/v1/transfers/downloads", job.session, job.selection, 202, job.control); }
        catch (ArchiveFailure cause) {
            if (!cause.code.equals("network-failure") && !cause.code.equals("timeout")) throw cause;
            accepted = job.http.json("GET", job.path(), job.session, null, 200, job.control);
        }
        acceptRemote(job, accepted); Map<String, Object> remote = pollReady(job);
        require("running".equals(remote.get("status")) && "ready".equals(remote.get("stage")));
        Object manifest = job.http.json("GET", job.path() + "/manifest", job.session, null, 200, job.control);
        ArchiveModel.Manifest prepared = TransferSchema.manifest(manifest);
        require(prepared.transferId.equals(job.id) && prepared.sourceDeviceId.equals(job.deviceId) && prepared.sourceRootId.equals(job.selection.get("sourceRootId")) && prepared.files.size() == job.count());
        List<Object> selected = list(job.selection.get("files"));
        for (int i = 0; i < prepared.files.size(); i++) {
            ArchiveModel.PreparedFile f = prepared.files.get(i); require(f.sourceEntryId.equals(map(selected.get(i)).get("entryId")));
            Map<String, Object> baseline;
            baseline = job.baselines.get(f.sourceEntryId);
            require(baseline != null && f.sourceName.equals(baseline.get("name")) && Objects.equals(f.sourceParentId, baseline.get("parentId")) &&
                Objects.equals(f.sourceModifiedAt, baseline.get("modifiedAt")) && (baseline.get("sizeBytes") == null || f.sizeBytes == ((Number) baseline.get("sizeBytes")).longValue()));
        }
        synchronized (this) { job.manifest = prepared; }
        running(job, "preparing");
        archives.checkReceiveSpace(prepared);
        for (ArchiveModel.PreparedFile f : prepared.files) publisher.preflight(publication(job, f), prepared.totalFileBytes, job.control);
        running(job, "transferring");
        InputStream input = job.http.download(job.path() + "/content", job.session, prepared.archive, job.control,
            (stage, count, total) -> { synchronized (this) { job.transferred = count; } running(job, "transferring"); });
        job.artifact = archives.receive(prepared, input, job.control, (stage, count, total) -> {
            if (stage.equals("receiving")) { synchronized (this) { job.transferred = count; } running(job, "transferring"); }
            else if (stage.equals("verifying")) { synchronized (this) { job.verified = count; } running(job, "verifying"); }
        });
        synchronized (this) { job.allVerified = true; job.verified = prepared.totalFileBytes; job.verifiedFiles = prepared.files.size(); }
        for (ArchiveModel.PreparedFile f : prepared.files) {
            job.control.check(); running(job, "publishing");
            PublicationModel.Result result = publisher.publish(publication(job, f), () -> job.artifact.openFile(f.fileId), null, job.control);
            synchronized (this) {
                outcomes.computeIfAbsent(job.id, ignored -> new ArrayList<>()).add(outcome(result));
                if (result.status.equals("succeeded")) { job.published += f.sizeBytes; job.publishedFiles++; }
                if (result.cleanup.equals("incomplete") || result.cleanup.equals("unknown")) { job.cleanup = result.cleanup; job.cleanupError = result.cleanupError; }
            }
            if (!result.status.equals("succeeded")) break;
        }
        // 最后一次确认成功可以赢得取消竞争，不在此处回滚或再检查取消。
    }
    private PublicationModel.Request publication(Job job, ArchiveModel.PreparedFile f) throws ArchiveFailure {
        Map<String, Object> t = target(job.targets, f.fileId);
        return new PublicationModel.Request(f.fileId, job.root, parent(t.get("parentId")), string(t.get("name")), f.sizeBytes, f.sha256);
    }
    private Map<String, Object> pollReady(Job job) throws Exception {
        while (true) {
            job.control.check(); Map<String, Object> s; synchronized (this) { s = job.remote; }
            if (!"running".equals(s.get("status")) || "ready".equals(s.get("stage"))) return s;
            pause(job); acceptRemote(job, job.http.json("GET", job.path(), job.session, null, 200, job.control));
        }
    }
    private void pollRemote(Job job, boolean untilTerminal) throws Exception {
        do {
            job.control.check(); Map<String, Object> state = acceptRemote(job, job.http.json("GET", job.path(), job.session, null, 200, job.control));
            if (!untilTerminal || !"running".equals(state.get("status"))) return;
            pause(job);
        } while (true);
    }
    private void pause(Job job) throws Exception { Thread.sleep(pollMillis); job.control.check(); }
    private synchronized Map<String, Object> acceptRemote(Job job, Object value) throws Exception {
        Map<String, Object> state = TransferSchema.state(copy(value), job.id, job.direction, job.upload() ? "receiver" : "sender",
            job.manifest, job.upload() ? job.root : null, job.upload() ? job.targets : null, job.count());
        if (job.remote != null) {
            require(number(state.get("updatedAt"), -8640000000000000L, 8640000000000000L) >= number(job.remote.get("updatedAt"), -8640000000000000L, 8640000000000000L));
            require("running".equals(job.remote.get("status")) || !"running".equals(state.get("status")));
            if ("running".equals(state.get("status")) && "running".equals(job.remote.get("status"))) {
                Map<String, Object> previous = map(job.remote.get("progress")), current = map(state.get("progress"));
                for (String key : new String[] {"sourceBytesRead", "archiveBytesTransferred", "fileBytesVerified", "fileBytesPublished", "verifiedFiles", "publishedFiles"}) {
                    require(((Number) current.get(key)).longValue() >= ((Number) previous.get(key)).longValue());
                }
            }
        }
        job.remote = state; job.remoteFailure = null; return state;
    }
    private void cancelRemote(Job job) {
        try {
            ArchiveControl control = new ArchiveControl(System::nanoTime, TimeUnit.SECONDS.toNanos(5));
            Object result;
            try { result = job.http.json("DELETE", job.path(), job.session, null, 202, control); }
            catch (ArchiveFailure cause) {
                // DELETE 的终态回执为 200；只查询，不能用另一次 DELETE 重放。
                result = job.http.json("GET", job.path(), job.session, null, 200, control);
            }
            acceptRemote(job, result);
        } catch (Exception cause) { synchronized (this) { job.remoteFailure = fail("result-unknown"); } }
    }
    void cancel(String id) throws ArchiveFailure {
        Job job; synchronized (this) { available(); job = job(id); } if (job.running) job.control.cancel();
    }
    /** 通知上的显式操作与系统服务期限使用此入口，不依赖 Activity 是否可见。 */
    void cancelActive(String expectedId, boolean timeout) {
        Job job;
        synchronized (this) {
            job = active;
            if (job == null || !job.running || (expectedId != null && !job.id.equals(expectedId))) return;
            if (timeout) job.timedOut = true;
        }
        job.control.cancel();
    }
    synchronized boolean hasWork() { return active != null; }
    synchronized String activeId() { return active == null ? null : active.id; }
    /** 界面重建后只重新取得本次上下文，不发起或恢复任何网络操作。 */
    synchronized Object current() throws Exception {
        available(); Job last = active;
        if (last == null) for (Job job : results.values()) last = job;
        return last == null ? null : copy(object("options", object("request", last.selection, "targetRootId", last.root, "targets", last.targets), "upload", last.upload(), "device", last.connection));
    }
    /** 通知仅取阶段/计数快照，避免在主线程复制完整清单或文件结果。 */
    synchronized Map<String, Object> notice() {
        if (active == null) return null;
        Map<String, Object> state = active.state;
        Object progress = state == null ? null : state.get("progress");
        return object("transferId", active.id, "upload", active.upload(), "running", active.running,
            "stage", state == null ? "preparing" : state.getOrDefault("stage", state.get("status")),
            "progress", progress == null ? null : new HashMap<>(mapUnchecked(progress)));
    }
    private Job job(String id) throws ArchiveFailure { id(id); Job job = results.get(id); if (job == null) throw fail("result-unknown"); return job; }
    synchronized Map<String, Object> query(String id) throws Exception {
        available(); Job job = job(id);
        if (job.state == null) throw job.failure == null ? fail("task-conflict") : job.failure;
        return map(copy(job.state));
    }
    synchronized Map<String, Object> manifest(String id) throws Exception {
        available(); Job job = job(id); if (job.manifest == null) throw fail("task-conflict"); return manifestJson(job.manifest);
    }
    Map<String, Object> remoteState(String id, boolean refresh, ArchiveControl control) throws Exception {
        Job job; synchronized (this) { available(); job = job(id); }
        if (refresh) acceptRemote(job, job.http.json("GET", job.path(), job.session, null, 200, control));
        synchronized (this) {
            available(); control.check(); if (job.remoteFailure != null) throw job.remoteFailure;
            if (job.remote == null) throw fail("task-conflict"); return map(copy(job.remote));
        }
    }
    private boolean cleanup(Job job) {
        boolean clean = true;
        try { if (job.artifact != null) { job.artifact.close(); job.artifact = null; } archives.retryCleanup(); }
        catch (Exception cause) { clean = false; }
        if (!publisher.retryCleanup()) clean = false;
        synchronized (this) {
            if (!clean) { job.cleanup = "incomplete"; job.cleanupError = "cleanup-failed"; }
            else if (!"unknown".equals(job.cleanup)) {
                job.cleanup = "complete"; job.cleanupError = null;
                for (Object item : fileResults(job)) {
                    Map<String, Object> outcome = mapUnchecked(item);
                    if (outcome.containsKey("residualEntries")) outcome.put("residualEntries", new ArrayList<>());
                }
            }
        }
        return clean;
    }
    private synchronized void terminalSender(Job job, String status, String error) {
        job.state = terminal(job, status, error, null);
    }
    private Map<String, Object> terminal(Job job, String status, String error, Object results) {
        return object("transferId", job.id, "direction", job.direction, "role", job.upload() ? "sender" : "receiver", "updatedAt", System.currentTimeMillis(),
            "status", status, "error", error == null ? null : error(error), "fileResults", results, "cleanupStatus", job.cleanup,
            "cleanupError", job.cleanupError == null ? null : error(job.cleanupError));
    }
    private synchronized void finish(Job job) {
        if (!job.running && job.state != null && !"running".equals(job.state.get("status"))) {
            job.state.put("cleanupStatus", job.cleanup); job.state.put("cleanupError", job.cleanupError == null ? null : error(job.cleanupError));
            job.state.put("updatedAt", System.currentTimeMillis());
            if (!job.upload()) job.state.put("fileResults", fileResults(job));
            return;
        }
        if (job.upload()) {
            if (job.state != null && "sent".equals(job.state.get("status"))) { job.state = terminal(job, "sent", null, null); return; }
            ArchiveFailure failure = job.failure == null ? fail("io-failure") : job.failure;
            String status = failure.cancelled ? "cancelled" : job.uploadBodyAttempted && job.transferred > 0 ? "unknown" : "failed";
            job.state = terminal(job, status, status.equals("unknown") ? "result-unknown" : failure.cancelled ? null : failure.code, null); return;
        }
        // 清单取得前没有目标创建；失败/取消也须生成终态，供重建后的界面查询。
        List<Object> values = outcomes.computeIfAbsent(job.id, ignored -> new ArrayList<>());
        String status = "succeeded", code = null, reason = null;
        for (Object value : values) {
            Map<String, Object> result = mapUnchecked(value); String outcome = (String) result.get("status");
            if (!outcome.equals("succeeded")) { status = outcome; code = outcome.equals("cancelled") ? null : (String) mapUnchecked(result.get("error")).get("code"); reason = outcome.equals("cancelled") ? "cancelled" : "prior-failure"; break; }
        }
        if (values.size() < job.count() && reason == null) {
            ArchiveFailure failure = job.failure == null ? fail("io-failure") : job.failure;
            status = failure.cancelled ? "cancelled" : "failed"; code = failure.cancelled ? null : failure.code;
            reason = failure.cancelled ? "cancelled" : job.allVerified ? "prior-failure" : "batch-invalid";
            // 发布器在开始目标创建前拒绝，必须形成当项失败以保留已有成功，后项才为未尝试。
            if (job.allVerified && !failure.cancelled) values.add(object("fileId", ArchiveModel.id(values.size()), "status", "failed", "error", error(code), "residualEntries", new ArrayList<>()));
        }
        while (values.size() < job.count()) values.add(object("fileId", ArchiveModel.id(values.size()), "status", "not-attempted", "reason", reason));
        job.state = terminal(job, status, code, new ArrayList<>(values));
    }
    @SuppressWarnings("unchecked") private static Map<String, Object> mapUnchecked(Object value) { return (Map<String, Object>) value; }
    private synchronized void release(Job job) { if (active == job) { active = null; PROCESS.compareAndSet(this, null); TargetOperation.release(this); } }
    /** 不重放任务；可显式重试本次未释放资源，正常销毁的旧实例也可由新实例安全收尾。 */
    boolean retryCleanup() {
        TransferEngine owner = PROCESS.get();
        if (owner != null && owner != this) return owner.closed && owner.retryCleanup();
        Job job; synchronized (this) { job = active; if (job == null) return true; if (job.running) return false; }
        if (!cleanup(job)) return false;
        synchronized (this) { finish(job); release(job); } emit(job, true); return true;
    }
    /** 销毁只请求取消；工作线程在平台调用返回并清理后关闭，不在 UI 线程等待。 */
    void close() {
        synchronized (this) { if (closed) return; closed = true; if (active != null) active.control.cancel(); }
        worker.execute(() -> { retryCleanup(); publisher.stop(); watch.shutdown(); }); worker.shutdown();
    }
}
