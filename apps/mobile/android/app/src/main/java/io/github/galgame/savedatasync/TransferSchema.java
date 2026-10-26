package io.github.galgame.savedatasync;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import static io.github.galgame.savedatasync.TransferJson.*;

/** v1 传输的封闭字段和任务上下文守卫；全部执行于原生，不能依赖 JS 校验网络输入。 */
final class TransferSchema {
    static final String ERROR_CODES = "invalid-request protocol-mismatch session-mismatch task-conflict invalid-archive resource-limit busy timeout permission-denied authorization-expired not-found not-readable unsupported-operation name-conflict path-outside-root source-changed checksum-mismatch network-failure insufficient-space io-failure cleanup-failed result-unknown";
    private TransferSchema() {}
    static void require(boolean value) throws ArchiveFailure { if (!value) throw fail("invalid-request"); }
    static Map<String, Object> shape(Object value, String... keys) throws ArchiveFailure {
        Map<String, Object> m = map(value); require(m.keySet().equals(new HashSet<>(Arrays.asList(keys)))); return m;
    }
    static String string(Object value) throws ArchiveFailure { require(value instanceof String); return (String) value; }
    static String id(Object value) throws ArchiveFailure { require(SafValues.isId(value)); return (String) value; }
    static String parent(Object value) throws ArchiveFailure { return value == null ? null : id(value); }
    static String text(Object value) throws ArchiveFailure { String result = string(value); require(ArchiveModel.text(result)); return result; }
    static long number(Object value, long min, long max) throws ArchiveFailure {
        require(value instanceof Number); Number n = (Number) value; long result = n.longValue();
        require(n.doubleValue() == result && result >= min && result <= max); return result;
    }
    static Long nullable(Object value, long min, long max) throws ArchiveFailure { return value == null ? null : number(value, min, max); }
    static void one(Object value, String... values) throws ArchiveFailure { require(Arrays.asList(values).contains(value)); }
    static String fileId(Object value, int index) throws ArchiveFailure { require(ArchiveModel.id(index).equals(value)); return (String) value; }
    static List<Object> bounded(Object value, boolean empty) throws ArchiveFailure {
        List<Object> result = list(value); require((empty || !result.isEmpty()) && result.size() <= 1024); return result;
    }
    static Map<String, Object> selection(Object value) throws ArchiveFailure {
        Map<String, Object> m = shape(value, "protocolVersion", "transferId", "sourceRootId", "files");
        require(number(m.get("protocolVersion"), 1, 1) == 1); id(m.get("transferId")); id(m.get("sourceRootId"));
        List<Object> files = bounded(m.get("files"), false); Set<String> ids = new HashSet<>();
        for (int i = 0; i < files.size(); i++) { Map<String, Object> f = shape(files.get(i), "fileId", "entryId");
            fileId(f.get("fileId"), i); require(ids.add(id(f.get("entryId")))); }
        return m;
    }
    static List<Object> targets(Object value, int count) throws ArchiveFailure {
        List<Object> targets = bounded(value, false); require(targets.size() == count); Set<String> ids = new HashSet<>(), names = new HashSet<>();
        for (Object item : targets) {
            Map<String, Object> t = shape(item, "fileId", "parentId", "name"); String id = string(t.get("fileId"));
            require(id.matches("f[0-9]{6}") && Integer.parseInt(id.substring(1)) >= 1 && Integer.parseInt(id.substring(1)) <= count && ids.add(id));
            String parent = parent(t.get("parentId")), name = string(t.get("name")); require(PublicationModel.portableName(name));
            require(names.add(String.valueOf(parent) + "\n" + PublicationModel.nameKey(name)));
        }
        return targets;
    }
    static ArchiveModel.Manifest manifest(Object value) throws ArchiveFailure {
        Map<String, Object> m = shape(value, "protocolVersion", "transferId", "sourceDeviceId", "sourceRootId", "files", "totalFileBytes", "archive");
        number(m.get("protocolVersion"), 1, 1); String transfer = id(m.get("transferId")), device = id(m.get("sourceDeviceId")), root = id(m.get("sourceRootId"));
        List<Object> values = bounded(m.get("files"), false); List<ArchiveModel.PreparedFile> files = new ArrayList<>();
        for (int i = 0; i < values.size(); i++) {
            Map<String, Object> f = shape(values.get(i), "fileId", "sourceEntryId", "sourceParentId", "sourceName", "sourceModifiedAt", "sizeBytes", "sha256");
            String entry = id(f.get("sourceEntryId")), parent = parent(f.get("sourceParentId"));
            String hash = string(f.get("sha256")); require(ArchiveModel.hash(hash));
            files.add(new ArchiveModel.PreparedFile(fileId(f.get("fileId"), i), new ArchiveModel.Observation("remote-" + entry, entry, parent,
                text(f.get("sourceName")), null, nullable(f.get("sourceModifiedAt"), -8640000000000000L, 8640000000000000L)),
                number(f.get("sizeBytes"), 0, 268435456), hash));
        }
        Map<String, Object> a = shape(m.get("archive"), "format", "compressionLevel", "sizeBytes", "tarSizeBytes", "sha256");
        require("tar.gz".equals(a.get("format"))); number(a.get("compressionLevel"), 1, 1); String hash = string(a.get("sha256")); require(ArchiveModel.hash(hash));
        ArchiveModel.Manifest result = new ArchiveModel.Manifest(transfer, device, root, files,
            number(m.get("totalFileBytes"), 0, 1073741824), new ArchiveModel.Descriptor(number(a.get("sizeBytes"), 1, 1140850688),
                number(a.get("tarSizeBytes"), 1024, 1074790400), hash));
        result.validate(new ArchiveModel.Limits()); return result;
    }
    static Map<String, Object> manifestJson(ArchiveModel.Manifest m) {
        List<Object> files = new ArrayList<>();
        for (ArchiveModel.PreparedFile f : m.files) files.add(object("fileId", f.fileId, "sourceEntryId", f.sourceEntryId,
            "sourceParentId", f.sourceParentId, "sourceName", f.sourceName, "sourceModifiedAt", f.sourceModifiedAt, "sizeBytes", f.sizeBytes, "sha256", f.sha256));
        return object("protocolVersion", 1, "transferId", m.transferId, "sourceDeviceId", m.sourceDeviceId, "sourceRootId", m.sourceRootId,
            "files", files, "totalFileBytes", m.totalFileBytes, "archive", object("format", "tar.gz", "compressionLevel", 1,
                "sizeBytes", m.archive.sizeBytes, "tarSizeBytes", m.archive.tarSizeBytes, "sha256", m.archive.sha256));
    }
    static Map<String, Object> limits() { return object("maxFiles", 1024, "maxFileBytes", 268435456L, "maxTotalFileBytes", 1073741824L,
        "maxTarBytes", 1074790400L, "maxArchiveBytes", 1140850688L, "maxJsonBytes", 8388608, "maxConcurrentBatches", 1, "maxTransfersPerSession", 4096); }
    static Map<String, Object> device(Object value) throws ArchiveFailure {
        Map<String, Object> m = shape(value, "device", "sessionId", "limits"); id(m.get("sessionId"));
        Map<String, Object> device = shape(m.get("device"), "protocolVersion", "deviceId", "displayName", "platform", "capabilities");
        if (!Long.valueOf(1).equals(device.get("protocolVersion"))) number(device.get("protocolVersion"), 1, 1);
        id(device.get("deviceId")); text(device.get("displayName")); require("windows".equals(device.get("platform")));
        Map<String, Object> capabilities = shape(device.get("capabilities"), "canListRoots", "canReadFiles", "canReceiveFiles", "canQueryTransfers", "canCancelTransfers");
        for (Object capability : capabilities.values()) one(capability, "supported", "unsupported", "unknown");
        Map<String, Object> limits = map(m.get("limits")); require(limits.keySet().equals(limits().keySet()));
        for (String key : limits().keySet()) require(number(limits.get(key), 1, 2000000000L) == ((Number) limits().get(key)).longValue());
        return m;
    }
    static Map<String, Object> error(Object value) throws ArchiveFailure {
        Map<String, Object> e = shape(value, "code", "message", "canRetry");
        require(Arrays.asList(ERROR_CODES.split(" ")).contains(e.get("code"))); text(e.get("message")); require(e.get("canRetry") instanceof Boolean);
        if ("result-unknown".equals(e.get("code")) || "session-mismatch".equals(e.get("code"))) require(Boolean.FALSE.equals(e.get("canRetry")));
        return e;
    }
    static Map<String, Object> error(String code) { return object("code", code, "message", "传输未完成，请核实本次目录与实际结果", "canRetry", false); }
    static Object unwrap(Object value) throws ArchiveFailure {
        Map<String, Object> m = map(value);
        if ("error".equals(m.get("status"))) {
            shape(m, "status", "error"); throw fail(string(error(m.get("error")).get("code")));
        }
        shape(m, "status", "value"); require("success".equals(m.get("status"))); return m.get("value");
    }
    static Map<String, Object> metadata(Object value) throws ArchiveFailure {
        Map<String, Object> e = shape(value, "rootId", "entryId", "parentId", "name", "kind", "sizeBytes", "modifiedAt", "capabilities");
        id(e.get("rootId")); id(e.get("entryId")); parent(e.get("parentId")); text(e.get("name"));
        require(!Objects.equals(e.get("entryId"), e.get("parentId"))); one(e.get("kind"), "file", "directory");
        if ("directory".equals(e.get("kind"))) require(e.get("sizeBytes") == null); else nullable(e.get("sizeBytes"), 0, 9007199254740991L);
        nullable(e.get("modifiedAt"), -8640000000000000L, 8640000000000000L);
        Map<String, Object> caps = shape(e.get("capabilities"), "canRead", "canList", "canCreate", "canRename", "canDelete");
        for (Object cap : caps.values()) one(cap, "supported", "unsupported", "unknown"); return e;
    }
    static List<Object> roots(Object value, String deviceId) throws ArchiveFailure {
        List<Object> values = list(value); require(values.size() <= 32768); Set<String> ids = new HashSet<>();
        for (Object item : values) {
            Map<String, Object> r = shape(item, "rootId", "deviceId", "displayName", "authorization");
            require(deviceId.equals(id(r.get("deviceId"))) && ids.add(id(r.get("rootId")))); text(r.get("displayName"));
            one(r.get("authorization"), "granted", "expired", "unavailable", "unverified");
        }
        return values;
    }
    static Map<String, Object> directory(Object value, String root, String parent) throws ArchiveFailure {
        Map<String, Object> m = shape(value, "rootId", "parentId", "observedAt", "entries"); require(root.equals(m.get("rootId")) && Objects.equals(parent, m.get("parentId")));
        number(m.get("observedAt"), -8640000000000000L, 8640000000000000L); List<Object> entries = list(m.get("entries")); require(entries.size() <= 32768);
        Set<String> ids = new HashSet<>();
        for (Object item : entries) { Map<String, Object> e = metadata(item); require(root.equals(e.get("rootId")) && Objects.equals(parent, e.get("parentId")) && ids.add(string(e.get("entryId")))); }
        return m;
    }
    static Map<String, Object> receiveRequest(ArchiveModel.Manifest m, String root, List<Object> targets) {
        return object("protocolVersion", 1, "manifest", manifestJson(m), "targetRootId", root, "targets", targets);
    }
    static Map<String, Object> outcome(PublicationModel.Result r) {
        Map<String, Object> value = object("fileId", r.fileId, "status", r.status);
        if ("succeeded".equals(r.status)) {
            PublicationModel.Entry e = r.entry;
            value.put("bytesWritten", r.bytesWritten); value.put("sha256", r.sha256);
            value.put("entry", object("rootId", e.rootId, "entryId", e.entryId, "parentId", e.parentId, "name", e.name, "kind", "file",
                "sizeBytes", e.size, "modifiedAt", e.modified, "capabilities", object("canRead", "supported", "canList", "unsupported",
                    "canCreate", "unsupported", "canRename", "unsupported", "canDelete", "unsupported")));
        } else {
            if (!"cancelled".equals(r.status)) value.put("error", error(r.errorCode));
            List<Object> residual = new ArrayList<>(); for (PublicationModel.Entry e : r.residualEntries) residual.add(object("rootId", e.rootId, "entryId", e.entryId));
            value.put("residualEntries", residual);
        }
        return value;
    }
    static Map<String, Object> target(List<Object> targets, String id) throws ArchiveFailure {
        for (Object value : targets) if (id.equals(map(value).get("fileId"))) return map(value);
        throw fail("invalid-request");
    }

    /** 同时检查角色、阶段、计数、完整顺序和实际清单/目标，拒绝错误任务的成功结果。 */
    static Map<String, Object> state(Object value, String transferId, String direction, String role,
                                     ArchiveModel.Manifest manifest, String targetRoot, List<Object> targets, int totalFiles) throws ArchiveFailure {
        Map<String, Object> s = map(value); boolean running = "running".equals(s.get("status"));
        if (running) shape(s, "transferId", "direction", "role", "updatedAt", "status", "stage", "progress", "cancelRequested", "fileResults");
        else shape(s, "transferId", "direction", "role", "updatedAt", "status", "error", "fileResults", "cleanupStatus", "cleanupError");
        require(transferId.equals(s.get("transferId")) && direction.equals(s.get("direction")) && role.equals(s.get("role")));
        number(s.get("updatedAt"), -8640000000000000L, 8640000000000000L);
        boolean sender = "sender".equals(role); List<Object> results = sender ? new ArrayList<>() : bounded(s.get("fileResults"), true);
        if (sender) require(s.get("fileResults") == null);
        else checkResults(results, manifest, targetRoot, targets, running, totalFiles, s.get("status"));
        if (running) {
            require(s.get("cancelRequested") instanceof Boolean);
            one(s.get("stage"), sender ? new String[] {"preparing", "ready", "transferring", "cleaning"} :
                new String[] {"preparing", "awaiting-content", "transferring", "verifying", "publishing", "cleaning"});
            Map<String, Object> p = shape(s.get("progress"), "sourceBytesRead", "archiveBytesTransferred", "fileBytesVerified", "fileBytesPublished",
                "totalFileBytes", "totalArchiveBytes", "totalFiles", "verifiedFiles", "publishedFiles");
            long source = number(p.get("sourceBytesRead"), 0, 1073741824), transferred = number(p.get("archiveBytesTransferred"), 0, 1140850688),
                verified = number(p.get("fileBytesVerified"), 0, 1073741824), published = number(p.get("fileBytesPublished"), 0, 1073741824);
            require(number(p.get("totalFiles"), 1, 1024) == totalFiles);
            long vf = number(p.get("verifiedFiles"), 0, totalFiles), pf = number(p.get("publishedFiles"), 0, totalFiles);
            Long total = nullable(p.get("totalFileBytes"), 0, 1073741824), archive = nullable(p.get("totalArchiveBytes"), 0, 1140850688);
            require((total == null || (source <= total && verified <= total && published <= total)) && (archive == null || transferred <= archive));
            require(pf <= vf && (manifest == null || ((total == null || total == manifest.totalFileBytes) && (archive == null || archive == manifest.archive.sizeBytes))));
            if (sender) require(verified == 0 && published == 0 && vf == 0 && pf == 0);
            else {
                require(source == 0); long successBytes = 0, successFiles = 0;
                for (Object item : results) { Map<String, Object> r = map(item); if ("succeeded".equals(r.get("status"))) { successFiles++; successBytes += ((Number) r.get("bytesWritten")).longValue(); } }
                require(pf == successFiles && published == successBytes);
            }
            String stage = string(s.get("stage"));
            if (!"cleaning".equals(stage)) {
                if (sender && stage.equals("preparing")) require(transferred == 0);
                else { require(total != null && archive != null); if (sender) require(source == total); }
                if (stage.equals("ready") || stage.equals("awaiting-content") || stage.equals("preparing")) require(transferred == 0);
                if (!sender && (stage.equals("preparing") || stage.equals("awaiting-content") || stage.equals("transferring"))) require(verified == 0 && vf == 0 && results.isEmpty());
                if (stage.equals("verifying") || stage.equals("publishing")) require(archive != null && transferred == archive);
                if (stage.equals("verifying")) require(results.isEmpty());
                if (stage.equals("publishing")) require(total != null && verified == total && vf == totalFiles);
            }
        } else {
            one(s.get("cleanupStatus"), "not-needed", "complete", "incomplete", "unknown");
            if ("incomplete".equals(s.get("cleanupStatus"))) require("cleanup-failed".equals(error(s.get("cleanupError")).get("code")));
            else if ("unknown".equals(s.get("cleanupStatus"))) require("result-unknown".equals(error(s.get("cleanupError")).get("code")));
            else require(s.get("cleanupError") == null);
            one(s.get("status"), sender ? new String[] {"sent", "failed", "cancelled", "unknown"} : new String[] {"succeeded", "failed", "cancelled", "unknown"});
            if ("sent".equals(s.get("status")) || "succeeded".equals(s.get("status")) || "cancelled".equals(s.get("status"))) require(s.get("error") == null);
            else require("unknown".equals(s.get("status")) == "result-unknown".equals(error(s.get("error")).get("code")));
        }
        return s;
    }
    private static void checkResults(List<Object> results, ArchiveModel.Manifest manifest, String root, List<Object> targets,
                                     boolean running, int count, Object status) throws ArchiveFailure {
        require(results.size() <= count && (running || results.size() == count)); Set<String> entries = new HashSet<>();
        boolean stopped = false, unknown = false, failed = false, cancelled = false; String reason = null;
        for (int i = 0; i < results.size(); i++) {
            Map<String, Object> r = map(results.get(i)); fileId(r.get("fileId"), i); String state = string(r.get("status"));
            one(state, "succeeded", "failed", "unknown", "cancelled", "not-attempted");
            if (stopped) require("not-attempted".equals(state));
            if (!"succeeded".equals(state)) stopped = true;
            if ("succeeded".equals(state)) {
                shape(r, "fileId", "status", "bytesWritten", "sha256", "entry"); long bytes = number(r.get("bytesWritten"), 0, 268435456);
                require(ArchiveModel.hash(string(r.get("sha256")))); Map<String, Object> e = metadata(r.get("entry"));
                require("file".equals(e.get("kind")) && entries.add(string(e.get("entryId"))) && (e.get("sizeBytes") == null || bytes == ((Number) e.get("sizeBytes")).longValue()));
                if (manifest != null) {
                    ArchiveModel.PreparedFile f = manifest.files.get(i); Map<String, Object> t = target(targets, f.fileId);
                    require(bytes == f.sizeBytes && f.sha256.equals(r.get("sha256")) && root.equals(e.get("rootId")) &&
                        Objects.equals(t.get("parentId"), e.get("parentId")) && t.get("name").equals(e.get("name")));
                }
            } else if ("not-attempted".equals(state)) {
                require(!running); shape(r, "fileId", "status", "reason"); one(r.get("reason"), "batch-invalid", "prior-failure", "cancelled");
                if (reason != null) require(reason.equals(r.get("reason"))); reason = string(r.get("reason"));
            } else {
                if (state.equals("cancelled")) { cancelled = true; shape(r, "fileId", "status", "residualEntries"); }
                else { shape(r, "fileId", "status", "error", "residualEntries"); require(state.equals("unknown") == "result-unknown".equals(error(r.get("error")).get("code"))); unknown |= state.equals("unknown"); failed |= state.equals("failed"); }
                for (Object item : bounded(r.get("residualEntries"), true)) { Map<String, Object> e = shape(item, "rootId", "entryId"); id(e.get("rootId")); require(entries.add(id(e.get("entryId"))) && (root == null || root.equals(e.get("rootId")))); }
            }
        }
        if (!running) {
            String expected = unknown ? "unknown" : failed ? "failed" : cancelled || "cancelled".equals(reason) ? "cancelled" : stopped ? "failed" : "succeeded";
            require(expected.equals(status));
            if (reason != null) require(reason.equals(unknown || failed ? "prior-failure" : cancelled ? "cancelled" : reason));
            if (!unknown && !failed && !cancelled && stopped) require("batch-invalid".equals(reason) || "cancelled".equals(reason));
        }
    }
}
