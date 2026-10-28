package io.github.galgame.savedatasync;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.FileChannel;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import static io.github.galgame.savedatasync.TransferJson.*;
import static io.github.galgame.savedatasync.TransferSchema.*;

/**
 * 应用私有持久备份；变更串行，恢复材料按引用保留。只读 SAF 同步根。
 * 创建由原生确认计划编排调用，公开插件只有设置、摘要和明确的清理操作。
 */
final class BackupStore implements AutoCloseable {
    private static final Set<Path> OPEN = new HashSet<>();
    private static final String ROUND_ID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    final Path root;
    private final SyncScanner.Source source;
    private final BackupFiles files;
    private final Object rootKey;
    private final Map<String, Object> owner;
    private final Map<Handle, String> handles = new LinkedHashMap<>();
    private final ScheduledExecutorService watcher = Executors.newSingleThreadScheduledExecutor();
    private volatile Active active;
    private volatile boolean closed;
    private boolean leaseReleased;
    private Round pendingCleanup;
    private boolean pendingHasMarker;
    private String pendingRotationProject, pendingRotationRoot;
    private static final class Active {
        final ArchiveControl control;
        volatile boolean timedOut;
        Active(ArchiveControl control) { this.control = Objects.requireNonNull(control); }
    }
    private static final class Round {
        final Path path;
        final Object key;
        final Map<String, Object> marker, manifest;
        Round(Path path, Object key, Map<String, Object> marker, Map<String, Object> manifest) {
            this.path = path; this.key = key; this.marker = marker; this.manifest = manifest;
        }
        String id() { return (String) marker.get("backupId"); }
    }
    BackupStore(Path privateDirectory, SyncScanner.Source source, BackupFiles.Io io) throws Exception {
        this.source = Objects.requireNonNull(source); id(source.deviceId()); files = new BackupFiles(io);
        Path parent = privateDirectory.toAbsolutePath().normalize(); files.directory(parent);
        root = parent.resolve("backups");
        synchronized (OPEN) {
            if (!OPEN.add(root)) throw BackupFiles.failure("busy");
            try {
                if (!exists(root)) Files.createDirectory(root);
                rootKey = files.directory(root);
                Path marker = root.resolve("owner.json");
                if (!exists(marker)) {
                    if (!names(root).isEmpty()) throw BackupFiles.failure("permission-denied");
                    files.writeJson(marker, object("schemaVersion", 1, "storeId", UUID.randomUUID().toString(), "deviceId", source.deviceId()));
                }
                owner = shape(files.readJson(marker), "schemaVersion", "storeId", "deviceId");
                number(owner.get("schemaVersion"), 1, 1); id(owner.get("storeId"));
                if (!source.deviceId().equals(id(owner.get("deviceId")))) throw BackupFiles.failure("permission-denied");
            } catch (Exception failure) { OPEN.remove(root); watcher.shutdownNow(); throw failure; }
        }
        watcher.scheduleAtFixedRate(() -> {
            Active current = active;
            if (current == null) return;
            try { current.control.check(); }
            catch (ArchiveFailure failure) {
                if ("timeout".equals(failure.code)) current.timedOut = true;
                current.control.cancel();
            }
        }, 100, 100, TimeUnit.MILLISECONDS);
    }
    private static boolean exists(Path path) { return Files.exists(path, LinkOption.NOFOLLOW_LINKS); }
    private static List<Path> names(Path root) throws Exception {
        List<Path> result = new ArrayList<>();
        try (DirectoryStream<Path> paths = Files.newDirectoryStream(root)) {
            for (Path path : paths) {
                if (result.size() >= 4096) throw BackupFiles.failure("resource-limit");
                result.add(path);
            }
        }
        return result;
    }
    private void check(Active current) throws ArchiveFailure {
        if (current.timedOut) throw new ArchiveFailure("timeout", "当前备份操作超时");
        current.control.check();
    }
    private void alive() throws Exception {
        if (closed) throw BackupFiles.failure("busy");
        verifyRoot();
    }
    private void verifyRoot() throws Exception {
        if (!Objects.equals(rootKey, files.directory(root)) ||
            !Arrays.equals(bytes(owner), bytes(files.readJson(root.resolve("owner.json"))))) throw BackupFiles.failure("permission-denied");
    }
    private void verifyRound(Round round, boolean hasMarker) throws Exception {
        verifyRoot();
        if (!Objects.equals(round.key, files.directory(round.path)) || (hasMarker &&
            !Arrays.equals(bytes(round.marker), bytes(files.readJson(round.path.resolve("round.json")))))) throw BackupFiles.failure("source-changed");
    }
    private List<Round> rounds() throws Exception {
        alive(); List<Round> result = new ArrayList<>();
        for (Path path : names(root)) {
            String name = path.getFileName().toString();
            if (name.equals("owner.json") || name.equals("settings.json") || name.matches("settings-" + ROUND_ID + "\\.tmp")) continue;
            if (!name.matches(ROUND_ID)) throw BackupFiles.failure("permission-denied");
            Object key = files.directory(path);
            Map<String, Object> marker = shape(files.readJson(path.resolve("round.json")), "schemaVersion", "storeId", "backupId", "projectId", "rootId");
            number(marker.get("schemaVersion"), 1, 1); id(marker.get("projectId")); id(marker.get("rootId"));
            if (!owner.get("storeId").equals(marker.get("storeId")) || !name.equals(marker.get("backupId"))) throw BackupFiles.failure("permission-denied");
            Map<String, Object> manifest = null;
            if (exists(path.resolve("manifest.json"))) {
                manifest = BackupModel.manifest(files.readJson(path.resolve("manifest.json")));
                if (!name.equals(manifest.get("backupId")) || !source.deviceId().equals(manifest.get("deviceId")) ||
                    !marker.get("projectId").equals(manifest.get("projectId")) || !marker.get("rootId").equals(manifest.get("rootId")) ||
                    exists(path.resolve("manifest.retired"))) throw BackupFiles.failure("permission-denied");
            }
            result.add(new Round(path, key, marker, manifest));
        }
        return result;
    }
    private static boolean group(Round round, String project, String root) {
        return round.marker.get("projectId").equals(project) && round.marker.get("rootId").equals(root);
    }
    private static void ids(String project, String root) throws Exception { id(project); id(root); }
    /** 摘要不携带文件路径；详情按单轮读取，以保持 8 MiB 控制响应限制。 */
    synchronized Map<String, Object> list(String projectId, String rootId) throws Exception {
        ids(projectId, rootId); List<Round> rounds = rounds(); sort(rounds);
        List<Object> backups = new ArrayList<>(), incomplete = new ArrayList<>();
        for (Round round : rounds) if (group(round, projectId, rootId)) {
            if (round.manifest == null) incomplete.add(round.id());
            else {
                long total = 0; List<Object> values = TransferJson.list(round.manifest.get("files"));
                for (Object value : values) total += number(map(value).get("sizeBytes"), 0, BackupModel.MAX_FILE);
                backups.add(object("backupId", round.id(), "projectId", projectId, "rootId", rootId,
                    "createdAt", round.manifest.get("createdAt"), "reason", round.manifest.get("reason"), "fileCount", values.size(), "totalFileBytes", total));
            }
        }
        return object("backups", backups, "incomplete", incomplete);
    }
    private static void sort(List<Round> rounds) {
        rounds.sort((a, b) -> Long.compare(b.manifest == null ? Long.MIN_VALUE : ((Number) b.manifest.get("createdAt")).longValue(),
            a.manifest == null ? Long.MIN_VALUE : ((Number) a.manifest.get("createdAt")).longValue()));
    }
    private Round find(String projectId, String rootId, String backupId) throws Exception {
        ids(projectId, rootId); id(backupId);
        for (Round round : rounds()) if (group(round, projectId, rootId) && round.id().equals(backupId)) return round;
        throw BackupFiles.failure("not-found");
    }
    synchronized Map<String, Object> manifest(String projectId, String rootId, String backupId) throws Exception {
        Round round = find(projectId, rootId, backupId);
        if (round.manifest == null) throw BackupFiles.failure("not-found");
        return map(copy(round.manifest));
    }
    /** 缺少项目设置时使用 true，坏设置不被默认值覆盖；格式独立于游戏配置。 */
    synchronized Map<String, Object> settings() throws Exception {
        alive(); Path path = root.resolve("settings.json");
        return exists(path) ? BackupModel.settings(files.readJson(path)) : object("schemaVersion", 1, "projects", new ArrayList<>());
    }
    synchronized Map<String, Object> setPreference(String projectId, String rootId, boolean shouldBackup) throws Exception {
        ids(projectId, rootId); Map<String, Object> settings = settings();
        List<Object> values = new ArrayList<>(TransferJson.list(settings.get("projects")));
        values.removeIf(value -> mapUnchecked(value).get("projectId").equals(projectId) && mapUnchecked(value).get("rootId").equals(rootId));
        values.add(object("projectId", projectId, "rootId", rootId, "shouldBackup", shouldBackup));
        Map<String, Object> next = BackupModel.settings(object("schemaVersion", 1, "projects", values));
        Path temporary = root.resolve("settings-" + UUID.randomUUID() + ".tmp");
        try { files.writeJson(temporary, next); verifyRoot(); files.move(temporary, root.resolve("settings.json"), true); }
        catch (Exception cause) {
            ArchiveFailure failure = ArchiveFailure.from(cause);
            try { if (exists(temporary)) { verifyRoot(); files.delete(temporary, TransferJson.MAX_BYTES); } }
            catch (Exception cleanup) { failure.cleanupFailure = cleanupFailure(cleanup); }
            throw failure;
        }
        return next;
    }
    @SuppressWarnings("unchecked") private static Map<String, Object> mapUnchecked(Object value) { return (Map<String, Object>) value; }
    synchronized Map<String, Object> info() throws Exception {
        return object("displayPath", root.toString(), "settings", settings());
    }
    synchronized Map<String, Object> capacity(long required) throws Exception {
        alive(); Long available = files.space(root, required);
        return object("requiredBytes", required, "availableBytes", available == null ? null : Math.min(9007199254740991L, available));
    }
    /** 保存已确认的全部旧文件；false 或无替换返回 null，不写 SAF 目标。恢复保护必须开启。 */
    synchronized Map<String, Object> create(String projectId, String rootId, String reason, boolean shouldBackup,
                                           List<Object> entries, ArchiveControl control) throws Exception {
        ids(projectId, rootId); one(reason, "copy", "restore"); require(!reason.equals("restore") || shouldBackup);
        List<BackupModel.SourceFile> sources = BackupModel.sources(entries); alive();
        if (pendingCleanup != null || pendingRotationProject != null) throw BackupFiles.failure("cleanup-failed");
        Active work = new Active(control); active = work;
        Round round = null; boolean hasMarker = false, committed = false;
        try {
            check(work);
            if (!shouldBackup || sources.isEmpty()) return object("manifest", null, "cleanupError", null);
            List<Round> previous = rounds(); long created = System.currentTimeMillis();
            for (Round value : previous) {
                if (value.manifest == null) throw BackupFiles.failure("cleanup-failed");
                created = Math.max(created, ((Number) value.manifest.get("createdAt")).longValue() + 1);
            }
            String backupId = UUID.randomUUID().toString(); List<Object> values = new ArrayList<>(); long total = 0;
            for (int i = 0; i < sources.size(); i++) {
                BackupModel.SourceFile file = sources.get(i); total += file.size;
                values.add(object("fileId", ArchiveModel.id(i), "path", file.path, "sizeBytes", file.size, "sha256", file.sha256, "modifiedAt", file.modified));
            }
            Map<String, Object> manifest = BackupModel.manifest(object("schemaVersion", 1, "backupId", backupId,
                "projectId", projectId, "deviceId", source.deviceId(), "rootId", rootId, "createdAt", created, "reason", reason, "files", values));
            BackupModel.snapshot(manifest); byte[] metadata = bytes(manifest);
            capacity(total + metadata.length + 4096); check(work);
            Path path = root.resolve(backupId); Files.createDirectory(path);
            Map<String, Object> marker = object("schemaVersion", 1, "storeId", owner.get("storeId"), "backupId", backupId, "projectId", projectId, "rootId", rootId);
            round = new Round(path, files.directory(path), marker, null);
            files.writeJson(path.resolve("round.json"), marker); hasMarker = true;
            for (int i = 0; i < sources.size(); i++) {
                verifyRound(round, true); check(work);
                BackupModel.SourceFile file = sources.get(i);
                ArchiveModel.Source input = resolve(rootId, file, work); input.validateRoot(rootId);
                ArchiveModel.Observation before = input.observe(control); before.validate();
                if (!before.entryId.equals(file.entryId) || !before.name.equals(file.path.get(file.path.size() - 1)) ||
                    (before.size != null && before.size != file.size) || !Objects.equals(before.modified, file.modified)) throw BackupFiles.failure("source-changed");
                Path destination = path.resolve(ArchiveModel.id(i));
                InputStream reader = control.track(input.open(control));
                FileChannel output = null;
                try {
                    output = control.track(files.writer(destination)); MessageDigest hash = MessageDigest.getInstance("SHA-256");
                    long size = 0; byte[] buffer = new byte[65536];
                    for (int count; (count = reader.read(buffer)) != -1;) {
                        check(work); size += count;
                        if (size > file.size) throw BackupFiles.failure("source-changed");
                        files.write(output, destination, buffer, count); hash.update(buffer, 0, count);
                    }
                    check(work);
                    if (size != file.size || !ArchiveFormat.hex(hash.digest()).equals(file.sha256) || !before.same(input.observe(control))) throw BackupFiles.failure("source-changed");
                    files.sync(output);
                } finally {
                    try { reader.close(); } finally { control.untrack(reader); if (output != null) { try { output.close(); } finally { control.untrack(output); } } }
                }
                verifyFile(round, map(values.get(i)), work);
            }
            verifyRound(round, true); check(work); files.writeJson(path.resolve("manifest.pending"), manifest); check(work);
            files.move(path.resolve("manifest.pending"), path.resolve("manifest.json"), false); committed = true;
            Object cleanup = null;
            try { prune(projectId, rootId, work); } catch (Exception failure) { pendingRotationProject = projectId; pendingRotationRoot = rootId; cleanup = error(cleanupFailure(failure)); }
            return object("manifest", copy(manifest), "cleanupError", cleanup);
        } catch (Exception cause) {
            ArchiveFailure failure = stopped(cause, work);
            if (round != null && !committed) try { remove(round, hasMarker); }
            catch (Exception cleanup) { pendingCleanup = round; pendingHasMarker = hasMarker; failure.cleanupFailure = cleanupFailure(cleanup); }
            throw failure;
        } finally { active = null; }
    }
    private ArchiveModel.Source resolve(String rootId, BackupModel.SourceFile file, Active work) throws Exception {
        String parentId = null;
        for (int i = 0; i < file.path.size(); i++) {
            check(work); List<Object> listing = source.list(rootId, parentId, work.control); Map<String, Object> selected = null;
            for (Object raw : listing) {
                Map<String, Object> entry = metadata(raw);
                require(rootId.equals(entry.get("rootId")) && Objects.equals(parentId, entry.get("parentId")));
                if (file.path.get(i).equals(entry.get("name"))) {
                    if (selected != null) throw BackupFiles.failure("name-conflict");
                    selected = entry;
                }
            }
            if (selected == null) throw BackupFiles.failure("source-changed");
            if (i < file.path.size() - 1) {
                if (!"directory".equals(selected.get("kind"))) throw BackupFiles.failure("source-changed");
                parentId = id(selected.get("entryId"));
            } else if (!"file".equals(selected.get("kind")) || !file.entryId.equals(selected.get("entryId"))) throw BackupFiles.failure("source-changed");
        }
        return source.file(rootId, file.entryId);
    }
    private void verifyFile(Round round, Map<String, Object> file, Active work) throws Exception {
        verifyRound(round, true); Path path = round.path.resolve(string(file.get("fileId")));
        long expected = number(file.get("sizeBytes"), 0, BackupModel.MAX_FILE);
        BasicFileAttributes before = files.regular(path, BackupModel.MAX_FILE);
        MessageDigest hash = MessageDigest.getInstance("SHA-256"); long size = 0; byte[] buffer = new byte[65536];
        InputStream input = work.control.track(files.reader(path, BackupModel.MAX_FILE));
        try (InputStream reader = input) {
            for (int count; (count = reader.read(buffer)) != -1;) {
                check(work); size += count; if (size > expected) throw BackupFiles.failure("checksum-mismatch");
                hash.update(buffer, 0, count);
            }
        } finally { work.control.untrack(input); }
        check(work); files.same(path, before, BackupModel.MAX_FILE);
        if (size != expected || !ArchiveFormat.hex(hash.digest()).equals(file.get("sha256"))) throw BackupFiles.failure("checksum-mismatch");
    }
    private void prune(String projectId, String rootId, Active work) throws Exception {
        List<Round> rounds = rounds(); rounds.removeIf(round -> round.manifest == null || !group(round, projectId, rootId)); sort(rounds);
        if (rounds.size() <= 3) return;
        for (Round round : rounds.subList(0, 3)) for (Object file : TransferJson.list(round.manifest.get("files"))) verifyFile(round, map(file), work);
        for (Round round : rounds.subList(3, rounds.size())) if (!handles.containsValue(round.id())) {
            try { remove(round, true); }
            catch (Exception failure) { pendingCleanup = round; pendingHasMarker = true; throw failure; }
        }
    }
    synchronized void rotate(String projectId, String rootId) throws Exception {
        ids(projectId, rootId); alive(); if (pendingCleanup != null) throw BackupFiles.failure("cleanup-failed");
        Active work = new Active(new ArchiveControl()); active = work;
        try { prune(projectId, rootId, work); } catch (Exception failure) { throw stopped(failure, work); }
        finally { active = null; }
    }
    /** 重试本实例本次创建留下的清理，不扫描或删除其他轮次的未完成数据。 */
    synchronized boolean retryCleanup() {
        if (active != null || closed) return false;
        try {
            if (pendingCleanup != null) { remove(pendingCleanup, pendingHasMarker); pendingCleanup = null; }
            if (pendingRotationProject != null) { rotate(pendingRotationProject, pendingRotationRoot); pendingRotationProject = null; pendingRotationRoot = null; }
            return true;
        } catch (Exception failure) { return false; }
    }
    synchronized void cleanupIncomplete(String projectId, String rootId, String backupId) throws Exception {
        Round round = find(projectId, rootId, backupId);
        if (round.manifest != null) throw BackupFiles.failure("permission-denied");
        remove(round, true);
        if (pendingCleanup != null && pendingCleanup.path.equals(round.path) && Objects.equals(pendingCleanup.key, round.key)) pendingCleanup = null;
    }
    private void remove(Round round, boolean hasMarker) throws Exception {
        verifyRound(round, hasMarker); if (handles.containsValue(round.id())) throw BackupFiles.failure("busy");
        Map<String, BasicFileAttributes> owned = new LinkedHashMap<>();
        for (Path path : names(round.path)) {
            String name = path.getFileName().toString(); boolean raw = name.matches("f[0-9]{6}") && Integer.parseInt(name.substring(1)) >= 1 && Integer.parseInt(name.substring(1)) <= 1024;
            if (!raw && !Arrays.asList("round.json", "manifest.json", "manifest.pending", "manifest.retired").contains(name)) throw BackupFiles.failure("cleanup-failed");
            owned.put(name, files.regular(path, raw ? BackupModel.MAX_FILE : TransferJson.MAX_BYTES));
        }
        if (owned.containsKey("manifest.json")) {
            files.move(round.path.resolve("manifest.json"), round.path.resolve("manifest.retired"), false);
            owned.put("manifest.retired", owned.remove("manifest.json"));
        }
        for (Map.Entry<String, BasicFileAttributes> file : owned.entrySet()) if (!file.getKey().equals("round.json")) {
            verifyRound(round, hasMarker); Path path = round.path.resolve(file.getKey());
            files.same(path, file.getValue(), file.getKey().startsWith("f") ? BackupModel.MAX_FILE : TransferJson.MAX_BYTES);
            files.delete(path, file.getKey().startsWith("f") ? BackupModel.MAX_FILE : TransferJson.MAX_BYTES);
        }
        verifyRound(round, hasMarker);
        if (owned.containsKey("round.json")) files.delete(round.path.resolve("round.json"), TransferJson.MAX_BYTES);
        try { files.deleteDirectory(round.path); }
        catch (Exception failure) { verifyRound(round, false); files.writeJson(round.path.resolve("round.json"), round.marker); throw failure; }
    }
    private ArchiveFailure stopped(Exception cause, Active work) {
        if (work.timedOut) return new ArchiveFailure("timeout", "当前备份操作超时", false, cause);
        try { work.control.check(); } catch (ArchiveFailure stopped) { return new ArchiveFailure(stopped.code, stopped.getMessage(), stopped.cancelled, cause); }
        return ArchiveFailure.from(cause);
    }
    private static ArchiveFailure cleanupFailure(Exception cause) { return new ArchiveFailure("cleanup-failed", "备份轮换或残留清理失败", false, cause); }
    static Map<String, Object> error(ArchiveFailure failure) { return object("code", failure.code, "message", failure.getMessage(), "canRetry", false); }

    /** 校验完整材料后取得引用；使用期间保留该轮，文件流只交给原生恢复编排。 */
    synchronized Handle acquire(String projectId, String rootId, String backupId, ArchiveControl control) throws Exception {
        if (handles.size() >= 32) throw BackupFiles.failure("resource-limit");
        Round round = find(projectId, rootId, backupId); if (round.manifest == null) throw BackupFiles.failure("not-found");
        Active work = new Active(control); active = work; Handle handle = new Handle(round); handles.put(handle, round.id());
        try {
            BackupModel.snapshot(round.manifest);
            for (Object file : TransferJson.list(round.manifest.get("files"))) verifyFile(round, map(file), work);
            return handle;
        } catch (Exception failure) { handles.remove(handle); throw stopped(failure, work); }
        finally { active = null; }
    }
    final class Handle implements AutoCloseable {
        private final Round round;
        private final Set<InputStream> readers = new HashSet<>();
        private boolean released;
        Handle(Round round) { this.round = round; }
        Map<String, Object> manifest() throws Exception { return map(copy(round.manifest)); }
        synchronized Map<String, Object> snapshot() throws Exception { if (released) throw BackupFiles.failure("not-found"); return BackupModel.snapshot(round.manifest); }
        ArchiveModel.Source source(String fileId) throws Exception {
            Map<String, Object> selected = null;
            for (Object raw : TransferJson.list(round.manifest.get("files"))) if (map(raw).get("fileId").equals(fileId)) selected = map(raw);
            if (selected == null) throw BackupFiles.failure("not-found");
            final Map<String, Object> file = selected; final Path path = round.path.resolve(fileId);
            final List<String> names = BackupModel.path(file.get("path"));
            String parent = null;
            if (names.size() > 1) for (Object entry : TransferJson.list(snapshot().get("entries"))) {
                Map<String, Object> value = map(entry);
                if (value.get("kind").equals("directory") && BackupModel.path(value.get("path")).equals(names.subList(0, names.size() - 1))) parent = string(value.get("entryId"));
            }
            final String parentId = parent;
            return new ArchiveModel.Source() {
                @Override public void validateRoot(String rootId) throws ArchiveFailure { require(round.id().equals(rootId)); }
                @Override public ArchiveModel.Observation observe(ArchiveControl control) throws Exception {
                    synchronized (Handle.this) { if (released || closed) throw BackupFiles.failure("not-found"); }
                    control.check(); verifyRound(round, true); BasicFileAttributes current = files.regular(path, BackupModel.MAX_FILE);
                    return new ArchiveModel.Observation(current.fileKey() + ":" + current.size() + ":" + current.lastModifiedTime(),
                        fileId, parentId, names.get(names.size() - 1), current.size(), nullable(file.get("modifiedAt"), -BackupModel.MAX_DATE, BackupModel.MAX_DATE));
                }
                @Override public InputStream open(ArchiveControl control) throws Exception {
                    observe(control); final InputStream input = files.reader(path, BackupModel.MAX_FILE);
                    FilterInputStream reader = new FilterInputStream(input) {
                        @Override public void close() throws IOException {
                            super.close(); control.untrack(this); synchronized (Handle.this) { readers.remove(this); }
                        }
                    };
                    synchronized (Handle.this) {
                        if (released || closed) { reader.close(); throw BackupFiles.failure("not-found"); }
                        readers.add(reader);
                    }
                    try { return control.track(reader); } catch (Exception failure) { reader.close(); throw failure; }
                }
            };
        }
        Map<String, Object> release() throws Exception {
            synchronized (this) {
                if (!readers.isEmpty()) throw BackupFiles.failure("busy");
                if (released) return object("cleanupError", null); released = true;
            }
            synchronized (BackupStore.this) {
                handles.remove(this); if (closed) return object("cleanupError", null);
                try { rotate(string(round.marker.get("projectId")), string(round.marker.get("rootId"))); return object("cleanupError", null); }
                catch (Exception failure) { return object("cleanupError", error(cleanupFailure(failure))); }
            }
        }
        @Override public void close() throws Exception {
            List<InputStream> closing; synchronized (this) { closing = new ArrayList<>(readers); }
            Exception failure = null;
            for (InputStream reader : closing) try { reader.close(); } catch (Exception cause) { failure = cause; }
            if (failure != null) throw failure;
            release();
        }
    }
    /** 只在原生所有者关闭存储时释放任务/读流；已提交轮次持久保留。 */
    @Override public void close() throws Exception {
        closed = true; Active current = active; if (current != null) current.control.cancel();
        synchronized (this) {
            if (leaseReleased) return;
            for (Handle handle : new ArrayList<>(handles.keySet())) handle.close();
            watcher.shutdownNow(); synchronized (OPEN) { OPEN.remove(root); }
            leaseReleased = true;
        }
    }
}
