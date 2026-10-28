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

/** 可执行 SyncPlan 的独立 Java 守卫；从两份完整快照重算动作/顺序/预算，拒绝删减冲突。 */
final class SyncPlanModel {
    private static final long MAX_SAFE = 9007199254740991L;
    private SyncPlanModel() {}
    static String key(Object path) throws Exception { return new String(bytes(path), java.nio.charset.StandardCharsets.UTF_8); }
    static boolean same(Object left, Object right) {
        if (left instanceof Number && right instanceof Number) return ((Number) left).longValue() == ((Number) right).longValue();
        if (left instanceof Map && right instanceof Map) {
            Map<?, ?> a = (Map<?, ?>) left, b = (Map<?, ?>) right;
            if (!a.keySet().equals(b.keySet())) return false;
            for (Object key : a.keySet()) if (!same(a.get(key), b.get(key))) return false;
            return true;
        }
        if (left instanceof List && right instanceof List) {
            List<?> a = (List<?>) left, b = (List<?>) right;
            if (a.size() != b.size()) return false;
            for (int i = 0; i < a.size(); i++) if (!same(a.get(i), b.get(i))) return false;
            return true;
        }
        return Objects.equals(left, right);
    }
    static final class Snapshot {
        final Map<String, Object> value;
        final String device, root, scan;
        final Map<String, Map<String, Object>> paths = new LinkedHashMap<>();
        final Map<String, Map<String, Object>> ids = new LinkedHashMap<>();
        Snapshot(Object raw) throws Exception {
            value = shape(copy(raw), "schemaVersion", "scanId", "deviceId", "rootId", "observedAt", "entries", "error");
            number(value.get("schemaVersion"), 1, 1); device = id(value.get("deviceId")); root = id(value.get("rootId")); scan = id(value.get("scanId"));
            number(value.get("observedAt"), -BackupModel.MAX_DATE, BackupModel.MAX_DATE); require(value.get("error") == null);
            List<Object> entries = list(value.get("entries")); require(entries.size() <= 10000); Set<String> names = new HashSet<>();
            List<String> previous = null;
            for (Object item : entries) {
                Map<String, Object> entry = shape(item, "entryId", "path", "kind", "sizeBytes", "modifiedAt", "sha256", "error");
                String entryId = id(entry.get("entryId")); List<String> path = BackupModel.path(entry.get("path"));
                require(entry.get("error") == null && names.add(BackupModel.key(path)) && !ids.containsKey(entryId));
                require(previous == null || BackupModel.compare(previous, path) < 0); previous = path;
                nullable(entry.get("modifiedAt"), -BackupModel.MAX_DATE, BackupModel.MAX_DATE);
                one(entry.get("kind"), "file", "directory");
                if (entry.get("kind").equals("file")) { number(entry.get("sizeBytes"), 0, MAX_SAFE); BackupModel.hash(entry.get("sha256")); }
                else require(entry.get("sizeBytes") == null && entry.get("sha256") == null);
                paths.put(key(path), entry); ids.put(entryId, entry);
            }
            for (Map<String, Object> entry : paths.values()) {
                List<String> path = BackupModel.path(entry.get("path"));
                if (path.size() > 1) {
                    Map<String, Object> parent = paths.get(key(path.subList(0, path.size() - 1)));
                    require(parent != null && parent.get("kind").equals("directory"));
                }
            }
        }
        Map<String, Object> entry(Object id) throws Exception { Map<String, Object> value = ids.get(string(id)); require(value != null); return value; }
        String parent(List<String> path) throws Exception {
            return path.size() == 1 ? null : id(paths.get(key(path.subList(0, path.size() - 1))).get("entryId"));
        }
    }
    static final class Plan {
        final Map<String, Object> value;
        final Snapshot source, target;
        final String id, project, reason;
        final boolean backup;
        final List<Map<String, Object>> writes = new ArrayList<>();
        final List<Object> replacements = new ArrayList<>();
        Plan(Object raw) throws Exception {
            value = shape(copy(raw), "planId", "projectId", "operation", "direction", "shouldBackup", "source", "target", "schemaVersion", "entries", "issues", "transferFileCount", "totalFileBytes", "backupFileBytes", "canExecute");
            bytes(value); number(value.get("schemaVersion"), 1, 1); id = id(value.get("planId")); project = id(value.get("projectId"));
            one(value.get("operation"), "copy", "restore"); reason = string(value.get("operation"));
            one(value.get("direction"), "android-to-windows", "windows-to-android", "local-restore");
            require(value.get("shouldBackup") instanceof Boolean && Boolean.TRUE.equals(value.get("canExecute")) && list(value.get("issues")).isEmpty());
            backup = (Boolean) value.get("shouldBackup"); source = new Snapshot(value.get("source")); target = new Snapshot(value.get("target"));
            boolean restore = reason.equals("restore");
            require(restore ? value.get("direction").equals("local-restore") && backup && source.device.equals(target.device) :
                !value.get("direction").equals("local-restore") && !source.device.equals(target.device));
            Map<String, String> equivalence = new LinkedHashMap<>();
            for (String key : target.paths.keySet()) equivalence.put(BackupModel.key(BackupModel.path(target.paths.get(key).get("path"))), key);
            for (String key : source.paths.keySet()) {
                String other = equivalence.get(BackupModel.key(BackupModel.path(source.paths.get(key).get("path")))); require(other == null || other.equals(key));
            }
            Map<String, Map<String, Object>> all = new LinkedHashMap<>(source.paths); target.paths.forEach(all::putIfAbsent);
            List<Object> operations = new ArrayList<>(); long total = 0, old = 0; int count = 0;
            for (String key : all.keySet()) {
                Map<String, Object> from = source.paths.get(key), to = target.paths.get(key); String action;
                if (from == null) action = "keep";
                else if (to == null) action = from.get("kind").equals("directory") ? "create-directory" : "create-file";
                else {
                    require(from.get("kind").equals(to.get("kind")));
                    action = from.get("kind").equals("directory") || (same(from.get("sizeBytes"), to.get("sizeBytes")) && from.get("sha256").equals(to.get("sha256"))) ? "skip" : "replace-file";
                }
                Map<String, Object> operation = object("path", (from == null ? to : from).get("path"), "action", action,
                    "sourceEntryId", from == null ? null : from.get("entryId"), "targetEntryId", to == null ? null : to.get("entryId"));
                operations.add(operation);
                if (action.equals("create-file") || action.equals("replace-file")) { count++; total += number(from.get("sizeBytes"), 0, BackupModel.MAX_FILE); require(total <= BackupModel.MAX_TOTAL); }
                if (action.equals("replace-file") && backup) { old += number(to.get("sizeBytes"), 0, BackupModel.MAX_FILE); replacements.add(to); require(old <= BackupModel.MAX_TOTAL); }
            }
            require(count <= 1024 && replacements.size() <= 1024);
            operations.sort((left, right) -> {
                try {
                    Map<String, Object> a = map(left), b = map(right); boolean ad = a.get("action").equals("create-directory"), bd = b.get("action").equals("create-directory");
                    if (ad != bd) return ad ? -1 : 1;
                    List<String> ap = BackupModel.path(a.get("path")), bp = BackupModel.path(b.get("path"));
                    int depth = ad ? Integer.compare(ap.size(), bp.size()) : 0;
                    return depth == 0 ? BackupModel.compare(ap, bp) : depth;
                } catch (Exception invalid) { throw new IllegalArgumentException(invalid); }
            });
            require(same(operations, value.get("entries")) && number(value.get("transferFileCount"), 0, 1024) == count &&
                number(value.get("totalFileBytes"), 0, BackupModel.MAX_TOTAL) == total && number(value.get("backupFileBytes"), 0, BackupModel.MAX_TOTAL) == old);
            for (Object operation : operations) {
                Map<String, Object> entry = map(operation);
                if (entry.get("action").equals("create-directory") || entry.get("action").equals("create-file") || entry.get("action").equals("replace-file")) writes.add(entry);
            }
        }
    }
}
