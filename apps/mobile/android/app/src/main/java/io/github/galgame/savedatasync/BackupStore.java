package io.github.galgame.savedatasync;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.FileChannel;
import java.nio.file.DirectoryStream;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.ArrayList;
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
 * 持久备份，放在用户能直接管理的应用专属外部目录：backups/游戏名/时间/，内含 backup.json 和按原路径保存的 files/。
 * 用户可以随时删除或改名其中任何内容，所以每次都按实际目录重新读取，一份备份出问题不影响其他备份。
 * 变更串行，恢复材料按引用保留；设置放内部目录，删掉备份文件夹不丢设置。只读 SAF 同步根。
 */
final class BackupStore implements AutoCloseable {
    /** 平台提供的位置和名称；目录被用户删除后由实现重新取得。 */
    interface Location {
        Path directory() throws Exception;
        /** 游戏当前名称，只决定新备份的文件夹名；找不到时返回 null。 */
        String gameName(String projectId);
    }
    private static final Set<Path> OPEN = new HashSet<>();
    private static final String COMMITTED = "backup.json", UNFINISHED = "in-progress.json", CONTENT = "files";
    private final Path settingsDirectory, settingsFile;
    private final Location location;
    private final SyncScanner.Source source;
    private final BackupFiles files;
    private final Map<Handle, String> handles = new LinkedHashMap<>();
    private final ScheduledExecutorService watcher = Executors.newSingleThreadScheduledExecutor();
    private volatile Active active;
    private volatile boolean closed;
    private boolean leaseReleased;
    private Round pendingCleanup;
    private String pendingRotationProject, pendingRotationRoot;
    private static final class Active {
        final ArchiveControl control;
        volatile boolean timedOut;
        Active(ArchiveControl control) { this.control = Objects.requireNonNull(control); }
    }
    /** complete 表示已提交且文件齐全；其余情况按未完成显示，可以清理但不能恢复。 */
    private static final class Round {
        final Path path;
        final Object key;
        final Map<String, Object> manifest;
        final boolean complete;
        Round(Path path, Object key, Map<String, Object> manifest, boolean complete) {
            this.path = path; this.key = key; this.manifest = manifest; this.complete = complete;
        }
        String id() { return (String) manifest.get("backupId"); }
        long createdAt() { return ((Number) manifest.get("createdAt")).longValue(); }
    }
    BackupStore(Path privateDirectory, Location location, SyncScanner.Source source, BackupFiles.Io io) throws Exception {
        this.location = Objects.requireNonNull(location); this.source = Objects.requireNonNull(source); id(source.deviceId()); files = new BackupFiles(io);
        settingsDirectory = privateDirectory.toAbsolutePath().normalize(); files.directory(settingsDirectory);
        settingsFile = settingsDirectory.resolve("backup-settings.json");
        synchronized (OPEN) { if (!OPEN.add(settingsDirectory)) { watcher.shutdownNow(); throw BackupFiles.failure("busy"); } }
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
        if (current.timedOut) throw new ArchiveFailure("timeout", "The current backup operation timed out.");
        current.control.check();
    }
    private void alive() throws Exception { if (closed) throw BackupFiles.failure("busy"); }
    /** 备份根目录；不存在就重新建立，所以用户可以把整个文件夹删掉。外部存储不可用时报错，写入随之被挡住。 */
    synchronized Path root() throws Exception {
        alive(); Path parent = location.directory().toAbsolutePath().normalize(); files.directory(parent);
        Path root = parent.resolve("backups");
        if (!exists(root)) Files.createDirectory(root);
        files.directory(root);
        return root;
    }
    private void verifyRound(Round round) throws Exception {
        if (!Objects.equals(round.key, files.directory(round.path))) throw BackupFiles.failure("source-changed");
    }
    private List<Round> rounds() throws Exception {
        List<Round> result = new ArrayList<>(); Set<String> seen = new HashSet<>();
        for (Path game : names(root())) {
            if (!Files.isDirectory(game, LinkOption.NOFOLLOW_LINKS)) continue;
            List<Path> paths;
            try { paths = names(game); } catch (NoSuchFileException removed) { continue; }
            for (Path path : paths) {
                Round round = read(path);
                if (round != null && seen.add(round.id())) result.add(round);
            }
        }
        return result;
    }
    /** 读一个备份文件夹；不是本机备份或读不懂的返回 null，留给用户自己处理。 */
    private Round read(Path path) {
        try {
            if (!Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) return null;
            boolean committed = exists(path.resolve(COMMITTED));
            Path marker = path.resolve(committed ? COMMITTED : UNFINISHED);
            if (!exists(marker)) return null;
            Map<String, Object> manifest = BackupModel.manifest(files.readJson(marker));
            if (!source.deviceId().equals(manifest.get("deviceId"))) return null;
            return new Round(path, files.directory(path), manifest, committed && intact(path, manifest));
        } catch (Exception unreadable) { return null; }
    }
    /** 只核对文件在不在、大小对不对，内容在恢复前完整校验。 */
    private boolean intact(Path path, Map<String, Object> manifest) throws Exception {
        for (Object raw : TransferJson.list(manifest.get("files"))) {
            Map<String, Object> file = map(raw);
            try { if (files.regular(content(path, file), BackupModel.MAX_FILE).size() != number(file.get("sizeBytes"), 0, BackupModel.MAX_FILE)) return false; }
            catch (Exception missing) { return false; }
        }
        return true;
    }
    private static Path content(Path round, Map<String, Object> file) throws Exception {
        Path path = round.resolve(CONTENT);
        for (String name : BackupModel.path(file.get("path"))) path = path.resolve(name);
        return path;
    }
    private static boolean group(Round round, String project, String root) {
        return round.manifest.get("projectId").equals(project) && round.manifest.get("rootId").equals(root);
    }
    private static void ids(String project, String root) throws Exception { id(project); id(root); }
    /** 摘要不携带文件路径；详情按单轮读取，以保持 8 MiB 控制响应限制。 */
    synchronized Map<String, Object> list(String projectId, String rootId) throws Exception {
        ids(projectId, rootId); List<Round> rounds = rounds(); sort(rounds);
        List<Object> backups = new ArrayList<>(), incomplete = new ArrayList<>();
        for (Round round : rounds) if (group(round, projectId, rootId)) {
            if (!round.complete) incomplete.add(object("backupId", round.id(), "occupiedBytes", occupied(round)));
            else {
                long total = 0; List<Object> values = TransferJson.list(round.manifest.get("files"));
                for (Object value : values) total += number(map(value).get("sizeBytes"), 0, BackupModel.MAX_FILE);
                backups.add(object("backupId", round.id(), "projectId", projectId, "rootId", rootId,
                    "createdAt", round.manifest.get("createdAt"), "reason", round.manifest.get("reason"), "fileCount", values.size(), "totalFileBytes", total));
            }
        }
        return object("backups", backups, "incomplete", incomplete);
    }
    /** 一轮文件夹占用的字节数；读取失败时未知，由界面单独显示。 */
    private Long occupied(Round round) {
        try (java.util.stream.Stream<Path> paths = Files.walk(round.path)) {
            long total = 0;
            for (Path path : (Iterable<Path>) paths::iterator) {
                BasicFileAttributes value = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                if (value.isRegularFile()) total += value.size();
            }
            return total;
        } catch (Exception unknown) { return null; }
    }
    private static void sort(List<Round> rounds) {
        rounds.sort((a, b) -> Long.compare(b.complete ? b.createdAt() : Long.MIN_VALUE, a.complete ? a.createdAt() : Long.MIN_VALUE));
    }
    private Round lookup(String projectId, String rootId, String backupId) throws Exception {
        ids(projectId, rootId); id(backupId);
        for (Round round : rounds()) if (group(round, projectId, rootId) && round.id().equals(backupId)) return round;
        return null;
    }
    private Round find(String projectId, String rootId, String backupId) throws Exception {
        Round round = lookup(projectId, rootId, backupId);
        if (round == null || !round.complete) throw BackupFiles.failure("not-found");
        return round;
    }
    synchronized Map<String, Object> manifest(String projectId, String rootId, String backupId) throws Exception {
        return map(copy(find(projectId, rootId, backupId).manifest));
    }
    /** 缺少文件时使用默认全局设置，坏设置不被默认值覆盖；格式独立于游戏配置。 */
    synchronized Map<String, Object> settings() throws Exception {
        alive();
        return exists(settingsFile) ? BackupModel.settings(files.readJson(settingsFile)) : BackupModel.emptySettings();
    }
    /** 单独设置某个游戏目录；policy 为 null 时改回跟随全局。 */
    synchronized Map<String, Object> setPreference(String projectId, String rootId, Map<String, Object> policy) throws Exception {
        ids(projectId, rootId); Map<String, Object> settings = settings();
        List<Object> values = new ArrayList<>(TransferJson.list(settings.get("projects")));
        values.removeIf(value -> mapUnchecked(value).get("projectId").equals(projectId) && mapUnchecked(value).get("rootId").equals(rootId));
        if (policy != null) values.add(object("projectId", projectId, "rootId", rootId, "shouldBackup", policy.get("shouldBackup"), "keepCount", policy.get("keepCount")));
        return writeSettings(BackupModel.settings(object("schemaVersion", 2, "defaults", settings.get("defaults"), "projects", values)));
    }
    /** 修改全局设置；单独设置的游戏目录不受影响。 */
    synchronized Map<String, Object> setDefaults(Map<String, Object> policy) throws Exception {
        Map<String, Object> settings = settings();
        return writeSettings(BackupModel.settings(object("schemaVersion", 2, "defaults", policy, "projects", settings.get("projects"))));
    }
    private Map<String, Object> writeSettings(Map<String, Object> next) throws Exception {
        Path temporary = settingsDirectory.resolve("backup-settings-" + UUID.randomUUID() + ".tmp");
        try { files.writeJson(temporary, next); files.move(temporary, settingsFile, true); }
        catch (Exception cause) {
            ArchiveFailure failure = ArchiveFailure.from(cause);
            try { if (exists(temporary)) files.delete(temporary, TransferJson.MAX_BYTES); }
            catch (Exception cleanup) { failure.cleanupFailure = cleanupFailure(cleanup); }
            throw failure;
        }
        return next;
    }
    @SuppressWarnings("unchecked") private static Map<String, Object> mapUnchecked(Object value) { return (Map<String, Object>) value; }
    synchronized Map<String, Object> info() throws Exception {
        return object("displayPath", root().toString(), "settings", settings());
    }
    synchronized Map<String, Object> capacity(long required) throws Exception {
        Long available = files.space(root(), required);
        return object("requiredBytes", required, "availableBytes", available == null ? null : Math.min(9007199254740991L, available));
    }
    /** 新备份的文件夹：游戏名/时间；同一秒已有同名文件夹时加序号。 */
    private Path createRoundDirectory(String projectId, long createdAt) throws Exception {
        Path game = root().resolve(BackupModel.folderName(location.gameName(projectId), projectId));
        Files.createDirectories(game); String name = BackupModel.roundName(createdAt);
        for (int i = 1; i <= 100; i++) {
            Path path = game.resolve(i == 1 ? name : name + "_" + i);
            try { Files.createDirectory(path); return path; } catch (FileAlreadyExistsException taken) { /* 试下一个序号。 */ }
        }
        throw BackupFiles.failure("io-failure");
    }
    /** 保存编排器选定的全部目标文件；关闭备份或集合为空时返回 null，并保持 SAF 目标不变。恢复时必须开启保护备份。 */
    synchronized Map<String, Object> create(String projectId, String rootId, String reason, boolean shouldBackup,
                                           List<Object> entries, ArchiveControl control) throws Exception {
        ids(projectId, rootId); one(reason, "copy", "restore"); require(!reason.equals("restore") || shouldBackup);
        List<BackupModel.SourceFile> sources = BackupModel.sources(entries); alive();
        if (pendingCleanup != null || pendingRotationProject != null) throw BackupFiles.failure("cleanup-failed");
        Active work = new Active(control); active = work;
        Round round = null; boolean committed = false;
        try {
            check(work);
            if (!shouldBackup || sources.isEmpty()) return object("manifest", null, "cleanupError", null);
            long created = System.currentTimeMillis();
            for (Round value : rounds()) created = Math.max(created, value.createdAt() + 1);
            String backupId = UUID.randomUUID().toString(); List<Object> values = new ArrayList<>(); long total = 0;
            for (int i = 0; i < sources.size(); i++) {
                BackupModel.SourceFile file = sources.get(i); total += file.size;
                values.add(object("fileId", ArchiveModel.id(i), "path", file.path, "sizeBytes", file.size, "sha256", file.sha256, "modifiedAt", file.modified));
            }
            Map<String, Object> manifest = BackupModel.manifest(object("schemaVersion", 1, "backupId", backupId,
                "projectId", projectId, "deviceId", source.deviceId(), "rootId", rootId, "createdAt", created, "reason", reason, "files", values));
            BackupModel.snapshot(manifest); byte[] metadata = bytes(manifest);
            capacity(total + metadata.length + 4096); check(work);
            Path path = createRoundDirectory(projectId, created);
            round = new Round(path, files.directory(path), manifest, false);
            files.writeJson(path.resolve(UNFINISHED), manifest);
            for (int i = 0; i < sources.size(); i++) {
                verifyRound(round); check(work);
                BackupModel.SourceFile file = sources.get(i);
                ArchiveModel.Source input = resolve(rootId, file, work); input.validateRoot(rootId);
                ArchiveModel.Observation before = input.observe(control); before.validate();
                if (!before.entryId.equals(file.entryId) || !before.name.equals(file.path.get(file.path.size() - 1)) ||
                    (before.size != null && before.size != file.size) || !Objects.equals(before.modified, file.modified)) throw BackupFiles.failure("source-changed");
                Path destination = content(path, map(values.get(i)));
                Files.createDirectories(destination.getParent());
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
            verifyRound(round); check(work);
            files.move(path.resolve(UNFINISHED), path.resolve(COMMITTED), false); committed = true;
            Object cleanup = null;
            try { prune(projectId, rootId); } catch (Exception failure) { pendingRotationProject = projectId; pendingRotationRoot = rootId; cleanup = error(cleanupFailure(failure)); }
            return object("manifest", copy(manifest), "cleanupError", cleanup);
        } catch (Exception cause) {
            ArchiveFailure failure = stopped(cause, work);
            if (round != null && !committed) try { remove(round); }
            catch (Exception cleanup) { pendingCleanup = round; failure.cleanupFailure = cleanupFailure(cleanup); }
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
        verifyRound(round); Path path = content(round.path, file);
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
    /** 只按完整的备份计份：用户删掉或弄坏的不占名额，不会因此多删旧备份。 */
    private void prune(String projectId, String rootId) throws Exception {
        List<Round> rounds = rounds(); rounds.removeIf(round -> !round.complete || !group(round, projectId, rootId)); sort(rounds);
        int keep = (int) ((Number) BackupModel.resolve(settings(), projectId, rootId).get("keepCount")).longValue();
        if (rounds.size() <= keep) return;
        for (Round round : rounds.subList(keep, rounds.size())) if (!handles.containsValue(round.id())) {
            try { remove(round); }
            catch (Exception failure) { pendingCleanup = round; throw failure; }
        }
    }
    synchronized void rotate(String projectId, String rootId) throws Exception {
        ids(projectId, rootId); alive(); if (pendingCleanup != null) throw BackupFiles.failure("cleanup-failed");
        prune(projectId, rootId);
    }
    /** 重试本实例本次创建留下的清理，不扫描或删除其他轮次的未完成数据。 */
    synchronized boolean retryCleanup() {
        if (active != null || closed) return false;
        try {
            if (pendingCleanup != null) { remove(pendingCleanup); pendingCleanup = null; }
            if (pendingRotationProject != null) { rotate(pendingRotationProject, pendingRotationRoot); pendingRotationProject = null; pendingRotationRoot = null; }
            return true;
        } catch (Exception failure) { return false; }
    }
    private void forgetPending(Round round) {
        if (pendingCleanup != null && pendingCleanup.path.equals(round.path) && Objects.equals(pendingCleanup.key, round.key)) pendingCleanup = null;
    }
    /** 清理未完成或文件已缺失的备份；已经不存在就算清理完成。 */
    synchronized void cleanupIncomplete(String projectId, String rootId, String backupId) throws Exception {
        Round round = lookup(projectId, rootId, backupId);
        if (round == null) return;
        if (round.complete) throw BackupFiles.failure("permission-denied");
        remove(round); forgetPending(round);
    }
    /** 用户在应用里删除一份备份；正在用于恢复的由 remove 拒绝，已被手动删除的算删除成功。删到一半失败时变成未完成，可再清理。 */
    synchronized void deleteBackup(String projectId, String rootId, String backupId) throws Exception {
        Round round = lookup(projectId, rootId, backupId);
        if (round != null) { remove(round); forgetPending(round); }
    }
    /** 移除游戏时删除它在所有目录下的备份和单独设置；中途失败时游戏保留，可以重试。 */
    synchronized void deleteGameBackups(String projectId) throws Exception {
        id(projectId);
        for (Round round : rounds()) if (round.manifest.get("projectId").equals(projectId)) { remove(round); forgetPending(round); }
        if (projectId.equals(pendingRotationProject)) { pendingRotationProject = null; pendingRotationRoot = null; }
        Map<String, Object> settings = settings();
        List<Object> values = new ArrayList<>(TransferJson.list(settings.get("projects")));
        values.removeIf(value -> mapUnchecked(value).get("projectId").equals(projectId));
        writeSettings(BackupModel.settings(object("schemaVersion", 2, "defaults", settings.get("defaults"), "projects", values)));
    }
    /** 先把备份改回未完成状态再删文件，中途失败时它显示为可清理；标记最后删，游戏文件夹空了也一起删。 */
    private void remove(Round round) throws Exception {
        if (handles.containsValue(round.id())) throw BackupFiles.failure("busy");
        Path marker = round.path.resolve(UNFINISHED);
        if (exists(round.path.resolve(COMMITTED))) files.move(round.path.resolve(COMMITTED), marker, false);
        if (exists(round.path)) {
            Files.walkFileTree(round.path, new SimpleFileVisitor<Path>() {
                @Override public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                    if (!file.equals(marker)) Files.deleteIfExists(file);
                    return FileVisitResult.CONTINUE;
                }
                @Override public FileVisitResult visitFileFailed(Path file, IOException failure) throws IOException {
                    if (failure instanceof NoSuchFileException) return FileVisitResult.CONTINUE;
                    throw failure;
                }
                @Override public FileVisitResult postVisitDirectory(Path directory, IOException failure) throws IOException {
                    if (failure != null) throw failure;
                    if (!directory.equals(round.path)) Files.deleteIfExists(directory);
                    return FileVisitResult.CONTINUE;
                }
            });
            Files.deleteIfExists(marker); Files.deleteIfExists(round.path);
        }
        try { Files.deleteIfExists(round.path.getParent()); } catch (IOException stillUsed) { /* 游戏文件夹里还有其他备份。 */ }
    }
    private ArchiveFailure stopped(Exception cause, Active work) {
        if (work.timedOut) return new ArchiveFailure("timeout", "The current backup operation timed out.", false, cause);
        try { work.control.check(); } catch (ArchiveFailure stopped) { return new ArchiveFailure(stopped.code, stopped.getMessage(), stopped.cancelled, cause); }
        return ArchiveFailure.from(cause);
    }
    private static ArchiveFailure cleanupFailure(Exception cause) { return new ArchiveFailure("cleanup-failed", "Backup rotation or leftover cleanup failed.", false, cause); }
    static Map<String, Object> error(ArchiveFailure failure) { return object("code", failure.code, "message", failure.getMessage(), "canRetry", false); }

    /** 校验完整材料后取得引用；使用期间保留该轮，文件流只交给原生恢复编排。 */
    synchronized Handle acquire(String projectId, String rootId, String backupId, ArchiveControl control) throws Exception {
        if (handles.size() >= 32) throw BackupFiles.failure("resource-limit");
        Round round = find(projectId, rootId, backupId);
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
            final Map<String, Object> file = selected; final Path path = content(round.path, file);
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
                    control.check(); verifyRound(round); BasicFileAttributes current = files.regular(path, BackupModel.MAX_FILE);
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
                try { rotate(string(round.manifest.get("projectId")), string(round.manifest.get("rootId"))); return object("cleanupError", null); }
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
            watcher.shutdownNow(); synchronized (OPEN) { OPEN.remove(settingsDirectory); }
            leaseReleased = true;
        }
    }
}
