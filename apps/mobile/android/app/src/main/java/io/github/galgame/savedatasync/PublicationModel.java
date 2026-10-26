package io.github.galgame.savedatasync;

import java.text.Normalizer;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/** 原生单文件发布值对象；不持有路径、URI 或文件字节，不自动重试未知结果。 */
final class PublicationModel {
    static final int MAX_DIRECTORY_ENTRIES = 32768;
    private PublicationModel() {}

    static final class Request {
        final String fileId, rootId, parentId, name, sha256;
        final long sizeBytes;
        Request(String fileId, String rootId, String parentId, String name, long sizeBytes, String sha256) {
            this.fileId = fileId; this.rootId = rootId; this.parentId = parentId;
            this.name = name; this.sizeBytes = sizeBytes; this.sha256 = sha256;
        }
        void validate() throws ArchiveFailure {
            if (fileId == null || !fileId.matches("f[0-9]{6}") || Integer.parseInt(fileId.substring(1)) < 1 ||
                Integer.parseInt(fileId.substring(1)) > 1024 || !SafValues.isId(rootId) ||
                (parentId != null && !SafValues.isId(parentId)) || !portableName(name) ||
                sizeBytes < 0 || !ArchiveModel.hash(sha256)) {
                throw new ArchiveFailure("invalid-request", "新文件发布字段不合法");
            }
            if (sizeBytes > 268435456L) throw new ArchiveFailure("resource-limit", "单文件超过发布预算");
        }
    }

    static final class Document {
        final String id, name;
        final boolean directory, virtual;
        final Long size, modified;
        Document(String id, String name, boolean directory, boolean virtual, Long size, Long modified) {
            this.id = id; this.name = name; this.directory = directory; this.virtual = virtual;
            this.size = size; this.modified = modified;
        }
    }

    /** 只有公开的不透明引用；提供者文档 ID 不进入结果。 */
    static final class Entry {
        final String rootId, parentId, entryId, name;
        final Long size, modified;
        Entry(String rootId, String parentId, String entryId, String name, Long size, Long modified) {
            this.rootId = rootId; this.parentId = parentId; this.entryId = entryId;
            this.name = name; this.size = size; this.modified = modified;
        }
    }

    static final class Result {
        final String fileId, status, errorCode, cleanup, cleanupError;
        final Entry entry;
        final List<Entry> residualEntries;
        final long bytesWritten;
        final String sha256;
        Result(Request request, String status, String errorCode, Entry entry, Entry residual,
               String cleanup, String cleanupError) {
            fileId = request.fileId; this.status = status; this.errorCode = errorCode; this.entry = entry;
            residualEntries = residual == null ? Collections.emptyList() : Collections.singletonList(residual);
            this.cleanup = cleanup; this.cleanupError = cleanupError;
            bytesWritten = "succeeded".equals(status) ? request.sizeBytes : 0;
            sha256 = "succeeded".equals(status) ? request.sha256 : null;
        }
    }

    static boolean portableName(String value) {
        if (!ArchiveModel.text(value) || value.length() > 255 || value.endsWith(".") || value.endsWith(" ")) return false;
        for (int c : value.codePoints().toArray()) {
            if (c < 32 || c == 127 || "<>:\"/\\|?*".indexOf(c) >= 0) return false;
        }
        return !value.toUpperCase(Locale.ROOT).matches(
            "(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\\$|CONOUT\\$)(?:\\..*)?");
    }

    /** 保守拒绝常见名称等价；不据此改写请求名或声称覆盖所有提供者规则。 */
    static String nameKey(String value) { return Normalizer.normalize(value, Normalizer.Form.NFC).toUpperCase(Locale.ROOT); }
}
