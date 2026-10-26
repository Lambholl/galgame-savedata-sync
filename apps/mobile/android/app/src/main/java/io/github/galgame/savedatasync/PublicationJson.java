package io.github.galgame.savedatasync;

import com.getcapacitor.JSObject;
import org.json.JSONArray;
import org.json.JSONObject;

/** 与共享 FileOutcome/BatchCleanup 对齐的原生结果；不暴露提供者 URI、异常或本地路径。 */
final class PublicationJson {
    private PublicationJson() {}
    static JSObject result(PublicationModel.Result result) {
        JSObject outcome = new JSObject(); outcome.put("fileId", result.fileId); outcome.put("status", result.status);
        if ("succeeded".equals(result.status)) {
            outcome.put("bytesWritten", result.bytesWritten); outcome.put("sha256", result.sha256);
            PublicationModel.Entry e = result.entry;
            outcome.put("entry", SafDirectoryStore.metadata(e.rootId, e.entryId, e.parentId,
                new SafDirectoryStore.Snapshot("native-only", e.name, false, true, false, e.size, e.modified)));
        } else {
            if (!"cancelled".equals(result.status)) outcome.put("error", error(result.errorCode));
            JSONArray residual = new JSONArray();
            for (PublicationModel.Entry entry : result.residualEntries) {
                JSObject reference = new JSObject(); reference.put("rootId", entry.rootId); reference.put("entryId", entry.entryId);
                residual.put(reference);
            }
            outcome.put("residualEntries", residual);
        }
        JSObject value = new JSObject(); value.put("outcome", outcome); value.put("cleanupStatus", result.cleanup);
        value.put("cleanupError", result.cleanupError == null ? JSONObject.NULL : error(result.cleanupError));
        return value;
    }
    private static JSObject error(String code) {
        JSObject value = new JSObject(); value.put("code", code);
        value.put("message", "result-unknown".equals(code) ? "文件发布结果待确认，请刷新目录，勿自动重试" :
            "cleanup-failed".equals(code) ? "本次新建条目或句柄尚未完成清理" : "新文件发布失败，请检查目标授权和文件状态");
        value.put("canRetry", false);
        return value;
    }
}
