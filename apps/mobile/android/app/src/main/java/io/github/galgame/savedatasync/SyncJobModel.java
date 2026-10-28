package io.github.galgame.savedatasync;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import static io.github.galgame.savedatasync.TransferJson.*;
import static io.github.galgame.savedatasync.TransferSchema.*;

/** 新同步的原生数据边界；网络输入须在原生通过，不能依赖页面中的共享守卫。 */
final class SyncJobModel {
    private SyncJobModel() {}
    static Map<String, Object> binding(Object raw) throws Exception {
        Map<String, Object> value = shape(copy(raw), "projectId", "remoteProjectId", "localDeviceId", "remoteDeviceId", "localRootId", "remoteRootId");
        for (Object item : value.values()) id(item);
        require(!value.get("localDeviceId").equals(value.get("remoteDeviceId"))); return value;
    }
    private static Map<String, Object> game(Object games, Object expected) throws Exception {
        Map<String, Object> found = null; Set<String> ids = new HashSet<>(); List<Object> list = list(games); require(list.size() <= 128);
        for (Object item : list) {
            Map<String, Object> game = shape(item, "id", "name", "root"); require(ids.add(id(game.get("id")))); text(game.get("name"));
            if (expected.equals(game.get("id"))) found = game;
        }
        if (found == null) throw new ArchiveFailure("session-mismatch", "已连接目录表中的项目已变化"); return found;
    }
    private static boolean linked(Object raw, Object local, Object remote) throws Exception {
        boolean found = false; Set<String> ids = new HashSet<>(); List<Object> links = list(raw); require(links.size() <= 128);
        for (Object item : links) {
            Map<String, Object> link = shape(item, "localGameId", "remoteGameId"); require(ids.add(id(link.get("localGameId")))); id(link.get("remoteGameId"));
            found |= local.equals(link.get("localGameId")) && remote.equals(link.get("remoteGameId"));
        }
        return found;
    }
    /** 双向公开关联须与已保存配置发布的同一项目及根一致，设备名称和地址不参与匹配。 */
    static void catalogBinding(Map<String, Object> hello, Map<String, Object> reply, Map<String, Object> binding) throws Exception {
        if (hello == null || reply == null) throw fail("session-mismatch");
        Map<String, Object> local = game(hello.get("games"), binding.get("projectId")), remote = game(reply.get("games"), binding.get("remoteProjectId"));
        for (boolean isLocal : new boolean[] {true, false}) {
            Map<String, Object> root = map((isLocal ? local : remote).get("root"));
            String device = string(binding.get(isLocal ? "localDeviceId" : "remoteDeviceId"));
            TransferSchema.roots(java.util.Collections.singletonList(root), device);
            if (!root.get("rootId").equals(binding.get(isLocal ? "localRootId" : "remoteRootId")) || !root.get("authorization").equals("granted")) {
                throw new ArchiveFailure("authorization-expired", "项目目录授权或绑定已变化");
            }
        }
        if (!linked(hello.get("links"), binding.get("projectId"), binding.get("remoteProjectId")) ||
            !linked(reply.get("links"), binding.get("remoteProjectId"), binding.get("projectId"))) throw fail("session-mismatch");
    }
    /** 原始扫描名称保留冲突供页面展示；可执行计划再使用更严格的 SyncPlanModel。 */
    private static List<String> rawPath(Object raw) throws Exception {
        List<Object> values = list(raw); require(!values.isEmpty() && values.size() <= 64); List<String> result = new ArrayList<>(); int length = -1;
        for (Object item : values) {
            String name = string(item); require(!name.isEmpty() && name.length() <= 255 && !name.equals(".") && !name.equals("..") &&
                name.indexOf(0) < 0 && name.indexOf('/') < 0 && name.indexOf('\\') < 0);
            length += name.length() + 1; result.add(name);
        }
        require(length <= 4096); return result;
    }
    static Map<String, Object> snapshot(Object raw, String device, String root) throws Exception {
        Map<String, Object> value = shape(copy(raw), "schemaVersion", "scanId", "deviceId", "rootId", "observedAt", "entries", "error");
        number(value.get("schemaVersion"), 1, 1); id(value.get("scanId")); number(value.get("observedAt"), -BackupModel.MAX_DATE, BackupModel.MAX_DATE);
        require(device.equals(value.get("deviceId")) && root.equals(value.get("rootId")) && value.get("error") == null);
        List<Object> entries = list(value.get("entries")); require(entries.size() <= 10000); Set<String> ids = new HashSet<>(); Map<String, Map<String, Object>> paths = new LinkedHashMap<>();
        for (Object item : entries) {
            Map<String, Object> entry = shape(item, "entryId", "path", "kind", "sizeBytes", "modifiedAt", "sha256", "error");
            require(ids.add(id(entry.get("entryId"))) && entry.get("error") == null);
            List<String> path = rawPath(entry.get("path")); require(paths.put(SyncPlanModel.key(path), entry) == null);
            nullable(entry.get("modifiedAt"), -BackupModel.MAX_DATE, BackupModel.MAX_DATE); one(entry.get("kind"), "file", "directory");
            if (entry.get("kind").equals("file")) { number(entry.get("sizeBytes"), 0, 9007199254740991L); BackupModel.hash(entry.get("sha256")); }
            else require(entry.get("sizeBytes") == null && entry.get("sha256") == null);
        }
        for (Object item : entries) {
            List<String> path = rawPath(map(item).get("path"));
            if (path.size() > 1) { Map<String, Object> parent = paths.get(SyncPlanModel.key(path.subList(0, path.size() - 1))); require(parent != null && parent.get("kind").equals("directory")); }
        }
        entries.sort((left, right) -> { try { return BackupModel.compare(rawPath(map(left).get("path")), rawPath(map(right).get("path"))); } catch (Exception invalid) { throw new IllegalArgumentException(invalid); } });
        return value;
    }
    static Map<String, Object> scan(Object raw, String device, String root, String scanId) throws Exception {
        Map<String, Object> state = shape(copy(raw), "schemaVersion", "scanId", "rootId", "status", "scannedEntries", "bytesRead", "snapshot", "error");
        number(state.get("schemaVersion"), 1, 1); id(state.get("scanId")); require(root.equals(state.get("rootId")) && (scanId == null || scanId.equals(state.get("scanId"))));
        long count = number(state.get("scannedEntries"), 0, 10000), bytes = number(state.get("bytesRead"), 0, 9007199254740991L);
        one(state.get("status"), "running", "succeeded", "failed", "cancelled");
        if (state.get("status").equals("running") || state.get("status").equals("cancelled")) require(state.get("snapshot") == null && state.get("error") == null);
        else if (state.get("status").equals("failed")) error(state.get("error"));
        else {
            require(state.get("error") == null); Map<String, Object> snapshot = snapshot(state.get("snapshot"), device, root);
            require(snapshot.get("scanId").equals(state.get("scanId")) && list(snapshot.get("entries")).size() == count);
            long actual = 0;
            for (Object item : list(snapshot.get("entries"))) if (map(item).get("kind").equals("file")) {
                long size = number(map(item).get("sizeBytes"), 0, 9007199254740991L); require(actual <= 9007199254740991L - size); actual += size;
            }
            require(actual == bytes); state.put("snapshot", snapshot);
        }
        return state;
    }
    static boolean backup(Object raw, Map<String, Object> binding) throws Exception {
        Map<String, Object> value = shape(raw, "schemaVersion", "projectId", "deviceId", "rootId", "shouldBackup"); number(value.get("schemaVersion"), 1, 1);
        require(binding.get("remoteProjectId").equals(value.get("projectId")) && binding.get("remoteDeviceId").equals(value.get("deviceId")) &&
            binding.get("remoteRootId").equals(value.get("rootId")) && value.get("shouldBackup") instanceof Boolean); return (Boolean) value.get("shouldBackup");
    }
    static void manifest(ArchiveModel.Manifest manifest, SyncPlanModel.Plan plan) throws Exception {
        manifest.validate(new ArchiveModel.Limits()); require(manifest.transferId.equals(plan.id) && manifest.sourceDeviceId.equals(plan.source.device) && manifest.sourceRootId.equals(plan.source.root));
        require(manifest.files.size() == number(plan.value.get("transferFileCount"), 0, 1024) && manifest.totalFileBytes == number(plan.value.get("totalFileBytes"), 0, BackupModel.MAX_TOTAL));
        int index = 0;
        for (Map<String, Object> operation : plan.writes) if (!operation.get("action").equals("create-directory")) {
            Map<String, Object> source = plan.source.entry(operation.get("sourceEntryId")); List<String> path = BackupModel.path(source.get("path"));
            ArchiveModel.PreparedFile file = manifest.files.get(index++);
            require(file.sourceEntryId.equals(source.get("entryId")) && Objects.equals(file.sourceParentId, plan.source.parent(path)) && file.sourceName.equals(path.get(path.size() - 1)) &&
                Objects.equals(file.sourceModifiedAt, nullable(source.get("modifiedAt"), -BackupModel.MAX_DATE, BackupModel.MAX_DATE)) &&
                file.sizeBytes == number(source.get("sizeBytes"), 0, BackupModel.MAX_FILE) && file.sha256.equals(source.get("sha256")));
        }
    }
    static Map<String, Object> request(SyncPlanModel.Plan plan, Map<String, Object> binding) {
        return object("schemaVersion", 1, "jobId", plan.id, "sourceProjectId", binding.get("projectId"), "targetProjectId", binding.get("remoteProjectId"), "plan", plan.value);
    }
    private static void cleanup(Object raw) throws Exception { if (raw != null) require(error(raw).get("code").equals("cleanup-failed")); }
    /** 核对本次完整结果顺序、实际成功指纹及保护备份；返回已确认成功的文件数量和字节数。 */
    private static long[] result(Object raw, SyncPlanModel.Plan plan) throws Exception {
        Map<String, Object> result = shape(raw, "schemaVersion", "planId", "backupId", "outcomes", "error", "cleanupError"); number(result.get("schemaVersion"), 1, 1);
        require(plan.id.equals(result.get("planId"))); parent(result.get("backupId")); cleanup(result.get("cleanupError"));
        if (result.get("error") != null) error(result.get("error"));
        List<Object> outcomes = list(result.get("outcomes")); require(outcomes.size() == plan.writes.size());
        boolean stopped = false, cancelled = false; long files = 0, bytes = 0;
        for (int index = 0; index < outcomes.size(); index++) {
            Map<String, Object> outcome = shape(outcomes.get(index), "path", "action", "status", "sizeBytes", "sha256", "error"), operation = plan.writes.get(index);
            require(SyncPlanModel.same(outcome.get("path"), operation.get("path")) && operation.get("action").equals(outcome.get("action")));
            String status = string(outcome.get("status")); one(status, "succeeded", "failed", "cancelled", "unknown", "not-attempted");
            if (stopped) require(status.equals("not-attempted"));
            if (status.equals("succeeded")) {
                require(outcome.get("error") == null);
                if (plan.backup && !plan.replacements.isEmpty()) require(result.get("backupId") != null);
                if (outcome.get("action").equals("create-directory")) require(outcome.get("sizeBytes") == null && outcome.get("sha256") == null);
                else {
                    Map<String, Object> source = plan.source.entry(operation.get("sourceEntryId"));
                    require(SyncPlanModel.same(source.get("sizeBytes"), outcome.get("sizeBytes")) && source.get("sha256").equals(outcome.get("sha256")));
                    files++; bytes += number(outcome.get("sizeBytes"), 0, BackupModel.MAX_FILE);
                }
            } else {
                stopped = true; require(outcome.get("sizeBytes") == null && outcome.get("sha256") == null);
                if (status.equals("failed") || status.equals("unknown")) {
                    Map<String, Object> failure = error(outcome.get("error")); require(result.get("error") != null);
                    require(status.equals("unknown") == failure.get("code").equals("result-unknown"));
                    if (status.equals("unknown")) require(map(result.get("error")).get("code").equals("result-unknown"));
                } else { require(outcome.get("error") == null); cancelled |= status.equals("cancelled"); }
            }
        }
        if (!outcomes.isEmpty()) require(stopped ? result.get("error") != null || cancelled : result.get("error") == null);
        return new long[] { files, bytes };
    }
    /** receiver 状态始终与完整确认计划对应，清单尚未声明时归档总量允许为 null。 */
    static Map<String, Object> state(Object raw, SyncPlanModel.Plan plan, ArchiveModel.Manifest manifest) throws Exception {
        Map<String, Object> state = shape(copy(raw), "schemaVersion", "jobId", "direction", "role", "status", "stage", "updatedAt", "cancelRequested", "progress", "result", "error", "cleanupError");
        number(state.get("schemaVersion"), 1, 1); require(plan.id.equals(state.get("jobId")) && plan.value.get("direction").equals(state.get("direction")) && state.get("role").equals("receiver"));
        number(state.get("updatedAt"), -BackupModel.MAX_DATE, BackupModel.MAX_DATE); require(state.get("cancelRequested") instanceof Boolean);
        if (state.get("error") != null) error(state.get("error")); cleanup(state.get("cleanupError"));
        Map<String, Object> progress = shape(state.get("progress"), "sourceBytesRead", "archiveBytesTransferred", "fileBytesVerified", "fileBytesPublished", "totalFileBytes", "totalArchiveBytes", "totalFiles", "verifiedFiles", "publishedFiles");
        long count = number(plan.value.get("transferFileCount"), 0, 1024), total = number(plan.value.get("totalFileBytes"), 0, BackupModel.MAX_TOTAL);
        require(number(progress.get("sourceBytesRead"), 0, 0) == 0 && number(progress.get("totalFiles"), 0, 1024) == count && number(progress.get("totalFileBytes"), 0, BackupModel.MAX_TOTAL) == total);
        Long packed = nullable(progress.get("totalArchiveBytes"), 0, 1140850688);
        long transferred = number(progress.get("archiveBytesTransferred"), 0, packed == null ? 0 : packed), verified = number(progress.get("fileBytesVerified"), 0, total), published = number(progress.get("fileBytesPublished"), 0, verified);
        long vf = number(progress.get("verifiedFiles"), 0, count), pf = number(progress.get("publishedFiles"), 0, vf);
        require(count == 0 ? total == 0 && packed != null && packed == 0 : packed == null || packed > 0);
        require((vf != count || verified == total) && (pf != count || published == total) && (pf != 0 || published == 0));
        if (manifest != null && packed != null) require(packed == manifest.archive.sizeBytes);
        String status = string(state.get("status")); one(status, "running", "succeeded", "failed", "cancelled", "unknown");
        one(state.get("stage"), "preparing", "awaiting-content", "transferring", "verifying", "backing-up", "writing", "cleaning", "done");
        if (status.equals("running")) require(!state.get("stage").equals("done") && state.get("error") == null && state.get("result") == null);
        else {
            require(state.get("stage").equals("done") && state.get("result") != null);
            long[] actual = result(state.get("result"), plan); require(actual[0] == pf && actual[1] == published && SyncPlanModel.same(map(state.get("result")).get("error"), state.get("error")));
            if (status.equals("succeeded")) {
                require(state.get("error") == null && vf == count && pf == count);
                for (Object outcome : list(map(state.get("result")).get("outcomes"))) require(map(outcome).get("status").equals("succeeded"));
            } else if (status.equals("cancelled")) require(state.get("error") == null && Boolean.TRUE.equals(state.get("cancelRequested")));
            else { require(state.get("error") != null); require(status.equals("unknown") == map(state.get("error")).get("code").equals("result-unknown")); }
        }
        return state;
    }
}
