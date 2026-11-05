package io.github.galgame.savedatasync;

import com.getcapacitor.JSObject;
import org.json.JSONArray;
import org.json.JSONObject;

/** 把发布结果转成 shared 的 FileOutcome 和 BatchCleanup 格式；提供者 URI、异常和本地路径不写进去。 */
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
        value.put("message", "result-unknown".equals(code) ? "The file publication result is unconfirmed. Refresh the directory; do not retry automatically." :
            "cleanup-failed".equals(code) ? "Cleanup of this new entry or handle is incomplete." : "New file publication failed. Check target authorization and file status.");
        value.put("canRetry", false);
        return value;
    }
}
