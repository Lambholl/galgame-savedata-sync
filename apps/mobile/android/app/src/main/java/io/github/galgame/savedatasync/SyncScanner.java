package io.github.galgame.savedatasync;

import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import static io.github.galgame.savedatasync.TransferJson.*;
import static io.github.galgame.savedatasync.TransferSchema.*;

/**
 * 本次只读扫描注册表。单工作线程处理 I/O，控制线程取消查询与阻塞读；结果只存内存。
 * 普通本地只读操作，不启动保活服务或处理应用前后台状态。
 */
final class SyncScanner implements AutoCloseable {
    interface Source {
        String deviceId();
        List<Object> list(String rootId, String parentId, ArchiveControl control) throws Exception;
        ArchiveModel.Source file(String rootId, String entryId) throws Exception;
    }
    static final int MAX_ENTRIES = 10000, MAX_DEPTH = 64, MAX_PATH = 4096, MAX_RESULTS = 32;
    private static final long MAX_SAFE = 9007199254740991L;
    private final Source source;
    private final int maxEntries;
    private final long timeoutMillis, retentionMillis;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService watcher = Executors.newSingleThreadScheduledExecutor();
    private final Map<String, Job> jobs = new LinkedHashMap<>();
    private Job active;
    private boolean closed;

    private static final class Job {
        final String id, rootId;
        final ArchiveControl control;
        final long started = System.nanoTime();
        final List<Object> entries = new ArrayList<>();
        final Set<String> ids = new HashSet<>();
        Map<String, Object> state;
        long ended, bytesRead;
        volatile boolean cancelled, timedOut;
        Job(String rootId, long timeout) { this(rootId, timeout, null); }
        Job(String rootId, long timeout, ArchiveControl external) {
            id = UUID.randomUUID().toString(); this.rootId = rootId;
            control = external == null ? new ArchiveControl(System::nanoTime, TimeUnit.MILLISECONDS.toNanos(timeout)) : external;
            state = object("schemaVersion", 1, "scanId", id, "rootId", rootId, "status", "running",
                "scannedEntries", 0, "bytesRead", 0L, "snapshot", null, "error", null);
        }
    }
    SyncScanner(Source source) { this(source, MAX_ENTRIES, 1800000, 600000); }
    /** 原生验证可收紧预算；不能通过 JS 改写。 */
    SyncScanner(Source source, int maxEntries, long timeoutMillis, long retentionMillis) {
        if (source == null || !SafValues.isId(source.deviceId()) || maxEntries < 1 || maxEntries > MAX_ENTRIES ||
            timeoutMillis < 1 || timeoutMillis > 1800000 || retentionMillis < 1 || retentionMillis > 600000) {
            throw new IllegalArgumentException("Invalid scan source or limits");
        }
        this.source = source; this.maxEntries = maxEntries;
        this.timeoutMillis = timeoutMillis; this.retentionMillis = retentionMillis;
        watcher.scheduleAtFixedRate(this::tick, 25, 25, TimeUnit.MILLISECONDS);
    }
    /** 仅登记已有根引用；返回后可用 query 取得真实终态。 */
    synchronized Map<String, Object> start(String rootId) throws Exception {
        id(rootId);
        if (closed || active != null) throw fail("busy");
        purge(); if (jobs.size() >= MAX_RESULTS) throw fail("resource-limit");
        Job job = new Job(rootId, timeoutMillis); jobs.put(job.id, job); active = job;
        try { worker.execute(() -> run(job)); }
        catch (java.util.concurrent.RejectedExecutionException cause) { jobs.remove(job.id); active = null; throw fail("busy"); }
        return map(copy(job.state));
    }
    /** 返回深拷贝的公开数据；查询不刷新扫描和结果期限。 */
    synchronized Map<String, Object> query(String scanId) throws Exception {
        purge(); return map(copy(find(scanId).state));
    }
    /** 原生目标任务在自身 I/O 线程重扫；取消/期限由该任务控制，不登记或延长扫描结果。 */
    Map<String, Object> snapshotNow(String rootId, ArchiveControl control) throws Exception {
        id(rootId); synchronized (this) { if (closed) throw fail("busy"); }
        Job job = new Job(rootId, timeoutMillis, control);
        visit(job, null, Collections.emptyList()); check(job);
        job.entries.sort((a, b) -> comparePath(pathUnchecked(a), pathUnchecked(b)));
        Map<String, Object> result = snapshot(job, null); bytes(result); return result;
    }
    /** 返回当前快照，取消终态要等工作线程关闭源流后查询。 */
    Map<String, Object> cancel(String scanId) throws Exception {
        Job job; synchronized (this) { job = find(scanId); if (job == active) job.cancelled = true; }
        if (job.cancelled) job.control.cancel();
        return query(scanId);
    }
    private Job find(String scanId) throws ArchiveFailure {
        id(scanId); Job job = jobs.get(scanId); if (job == null) throw fail("not-found"); return job;
    }
    private synchronized void purge() {
        long now = System.nanoTime();
        jobs.values().removeIf(job -> job != active && job.ended != 0 &&
            now - job.ended >= TimeUnit.MILLISECONDS.toNanos(retentionMillis));
    }
    private void tick() {
        Job timed = null;
        synchronized (this) {
            purge();
            if (active != null && System.nanoTime() - active.started >= TimeUnit.MILLISECONDS.toNanos(timeoutMillis)) {
                active.timedOut = true; timed = active;
            }
        }
        if (timed != null) timed.control.cancel();
    }
    private void check(Job job) throws Exception {
        if (job.timedOut) throw new ArchiveFailure("timeout", "当前扫描超时");
        job.control.check();
    }
    private Map<String, Object> snapshot(Job job, Object error) {
        return object("schemaVersion", 1, "scanId", job.id, "deviceId", source.deviceId(), "rootId", job.rootId,
            "observedAt", System.currentTimeMillis(), "entries", new ArrayList<>(job.entries), "error", error);
    }
    private void run(Job job) {
        Map<String, Object> snapshot = null, error = null;
        String status = "succeeded";
        try {
            visit(job, null, Collections.emptyList()); check(job);
            job.entries.sort((a, b) -> comparePath(pathUnchecked(a), pathUnchecked(b)));
            snapshot = snapshot(job, null);
            if (bytes(snapshot).length > TransferJson.MAX_BYTES - 4096) throw fail("resource-limit");
        } catch (Exception cause) {
            if (job.cancelled) status = "cancelled";
            else {
                status = "failed";
                String code = job.timedOut ? "timeout" : cause instanceof ArchiveFailure ? ((ArchiveFailure) cause).code : "io-failure";
                error = scanError(code); snapshot = snapshot(job, error);
                try { if (bytes(snapshot).length > TransferJson.MAX_BYTES - 4096) snapshot.put("entries", new ArrayList<>()); }
                catch (Exception tooLarge) { snapshot.put("entries", new ArrayList<>()); }
            }
        } finally {
            synchronized (this) {
                job.state = object("schemaVersion", 1, "scanId", job.id, "rootId", job.rootId, "status", status,
                    "scannedEntries", job.entries.size(), "bytesRead", job.bytesRead, "snapshot", snapshot, "error", error);
                job.ended = System.nanoTime(); active = null;
            }
        }
    }
    @SuppressWarnings("unchecked") private static List<String> pathUnchecked(Object entry) {
        return (List<String>) ((Map<String, Object>) entry).get("path");
    }
    private static int comparePath(List<String> a, List<String> b) {
        for (int i = 0; i < Math.min(a.size(), b.size()); i++) {
            int compared = a.get(i).compareTo(b.get(i)); if (compared != 0) return compared;
        }
        return Integer.compare(a.size(), b.size());
    }
    private static void validatePath(List<String> path) throws ArchiveFailure {
        if (path.isEmpty() || path.size() > MAX_DEPTH) throw fail("resource-limit");
        int length = -1;
        for (String name : path) {
            if (name.isEmpty() || name.length() > 255 || name.equals(".") || name.equals("..") ||
                name.indexOf(0) >= 0 || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0) throw fail("name-conflict");
            length += name.length() + 1;
        }
        if (length > MAX_PATH) throw fail("resource-limit");
    }
    private static String listingKey(List<Object> entries) throws Exception {
        List<Object> values = new ArrayList<>();
        for (Object raw : entries) {
            Map<String, Object> entry = metadata(raw);
            values.add(object("entryId", entry.get("entryId"), "name", entry.get("name"), "kind", entry.get("kind"),
                "sizeBytes", entry.get("sizeBytes"), "modifiedAt", entry.get("modifiedAt")));
        }
        values.sort((a, b) -> ((String) ((Map<?, ?>) a).get("entryId")).compareTo((String) ((Map<?, ?>) b).get("entryId")));
        return new String(bytes(values), java.nio.charset.StandardCharsets.UTF_8);
    }
    private void visit(Job job, String parentId, List<String> parentPath) throws Exception {
        check(job); List<Object> before = source.list(job.rootId, parentId, job.control); check(job);
        String key = listingKey(before);
        List<Object> ordered = new ArrayList<>(before);
        ordered.sort((a, b) -> ((String) ((Map<?, ?>) a).get("name")).compareTo((String) ((Map<?, ?>) b).get("name")));
        Set<String> names = new HashSet<>();
        for (Object raw : ordered) {
            check(job); Map<String, Object> entry = metadata(raw);
            require(job.rootId.equals(entry.get("rootId")) && Objects.equals(parentId, entry.get("parentId")));
            String entryId = id(entry.get("entryId")), name = string(entry.get("name"));
            if (!names.add(name) || !job.ids.add(entryId)) throw fail("name-conflict");
            List<String> path = new ArrayList<>(parentPath); path.add(name); validatePath(path);
            if (job.entries.size() >= maxEntries) throw fail("resource-limit");
            Map<String, Object> value = object("entryId", entryId, "path", path, "kind", entry.get("kind"),
                "sizeBytes", entry.get("sizeBytes"), "modifiedAt", entry.get("modifiedAt"), "sha256", null, "error", null);
            job.entries.add(value); progress(job);
            try {
                if ("directory".equals(entry.get("kind"))) visit(job, entryId, path);
                else hash(job, entry, value);
            } catch (Exception cause) {
                value.put("error", scanError(job.timedOut ? "timeout" : cause instanceof ArchiveFailure ? ((ArchiveFailure) cause).code : "io-failure"));
                throw cause;
            }
        }
        String after = listingKey(source.list(job.rootId, parentId, job.control)); check(job);
        if (!key.equals(after)) throw new ArchiveFailure("source-changed", "目录在扫描期间变化");
    }
    private synchronized void progress(Job job) {
        job.state = object("schemaVersion", 1, "scanId", job.id, "rootId", job.rootId, "status", "running",
            "scannedEntries", job.entries.size(), "bytesRead", job.bytesRead, "snapshot", null, "error", null);
    }
    private void hash(Job job, Map<String, Object> entry, Map<String, Object> value) throws Exception {
        ArchiveModel.Source file = source.file(job.rootId, string(entry.get("entryId"))); file.validateRoot(job.rootId);
        ArchiveModel.Observation before = file.observe(job.control); before.validate();
        if (!Objects.equals(before.entryId, entry.get("entryId")) || !Objects.equals(before.parentId, entry.get("parentId")) ||
            !Objects.equals(before.name, entry.get("name")) || !Objects.equals(before.size, nullable(entry.get("sizeBytes"), 0, MAX_SAFE)) ||
            !Objects.equals(before.modified, nullable(entry.get("modifiedAt"), -8640000000000000L, 8640000000000000L))) throw fail("source-changed");
        MessageDigest digest = MessageDigest.getInstance("SHA-256"); long size = 0; byte[] buffer = new byte[65536];
        InputStream input = job.control.track(file.open(job.control));
        try (InputStream owned = input) {
            for (int count; (count = owned.read(buffer)) != -1;) {
                check(job); if (count == 0) continue;
                if (size > MAX_SAFE - count || job.bytesRead > MAX_SAFE - count) throw fail("resource-limit");
                size += count; job.bytesRead += count; digest.update(buffer, 0, count); progress(job);
            }
        } finally { job.control.untrack(input); }
        check(job);
        if (!before.same(file.observe(job.control)) || (before.size != null && before.size != size)) throw fail("source-changed");
        value.put("sizeBytes", size); value.put("sha256", ArchiveFormat.hex(digest.digest()));
    }
    static Map<String, Object> scanError(String code) {
        String message;
        switch (code) {
            case "source-changed": message = "目录或文件在扫描期间变化，请重新扫描"; break;
            case "permission-denied": case "authorization-expired": message = "目录权限已失效，请重新选择目录"; break;
            case "resource-limit": message = "扫描条目、路径或结果超过限制"; break;
            case "not-found": message = "扫描或目录引用不存在，请重新读取"; break;
            case "timeout": message = "当前扫描超时，请重新扫描"; break;
            case "name-conflict": message = "目录包含重复或无法使用的名称"; break;
            case "busy": message = "已有扫描正在进行或扫描器已停止"; break;
            default: message = "当前目录扫描失败，请重新读取";
        }
        return object("code", code, "message", message, "canRetry", false);
    }
    /** 关闭扫描器时取消活动读取，等待工作线程释放资源后清空内存结果。 */
    @Override public void close() throws Exception {
        Job job; synchronized (this) { closed = true; job = active; if (job != null) job.cancelled = true; }
        if (job != null) job.control.cancel();
        worker.shutdown();
        if (!worker.awaitTermination(30, TimeUnit.SECONDS)) throw new ArchiveFailure("timeout", "扫描读取尚未结束");
        watcher.shutdownNow(); synchronized (this) { jobs.clear(); }
    }
}
