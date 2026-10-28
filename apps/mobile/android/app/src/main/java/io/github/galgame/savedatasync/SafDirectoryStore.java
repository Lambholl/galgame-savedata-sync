package io.github.galgame.savedatasync;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import com.getcapacitor.JSObject;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 只读 SAF 登记表；必须在 I/O 工作线程调用，不得在 UI 线程调用。
 * 仅持久化根目录授权；条目 ID 和元数据只保留在当前实例中。
 * 文件操作始终使用不透明提供者 ID；完整路径与父目录名由独立展示模块生成。
 */
final class SafDirectoryStore {
    static final String PREFERENCES = "saf-directories-v1";
    private static final String[] PROJECTION = {
        Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
        Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS
    };
    private final ContentResolver resolver;
    private final Context context;
    private final SharedPreferences preferences;
    private final List<Root> roots = new ArrayList<>();
    private final Map<String, Entry> entries = new HashMap<>();
    private final Map<String, String> documentIds = new HashMap<>();
    private final Map<String, DirectoryDisplay.Info> display = new HashMap<>();
    private final String deviceId;

    String deviceId() { return deviceId; }

    SafDirectoryStore(Context context) throws SafFailure {
        this(context, PREFERENCES);
    }

    /** 使用单独的偏好设置名称，将仪器测试夹具与用户设置隔离。 */
    SafDirectoryStore(Context context, String preferencesName) throws SafFailure {
        this.context = context.getApplicationContext();
        resolver = this.context.getContentResolver();
        preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE);
        try {
            String saved = preferences.getString("registry", null);
            if (saved == null) {
                deviceId = UUID.randomUUID().toString();
                persist();
                return;
            }
            JSONObject registry = new JSONObject(saved);
            if (registry.length() != 3 || !(registry.get("schemaVersion") instanceof Integer) ||
                registry.getInt("schemaVersion") != 1 || !SafValues.isId(registry.get("deviceId"))) {
                throw new IllegalArgumentException("Unknown registry");
            }
            deviceId = registry.getString("deviceId");
            JSONArray records = registry.getJSONArray("roots");
            Set<String> ids = new HashSet<>();
            Set<String> uris = new HashSet<>();
            for (int index = 0; index < records.length(); index++) {
                JSONObject record = records.getJSONObject(index);
                if (record.length() != 3 || !(record.get("rootId") instanceof String) ||
                    !(record.get("treeUri") instanceof String) || !(record.get("displayName") instanceof String)) {
                    throw new IllegalArgumentException("Invalid root fields");
                }
                String id = record.getString("rootId");
                Uri uri = treeUri(record.getString("treeUri"));
                if (!SafValues.isId(id) || !ids.add(id) || !uris.add(uri.toString())) {
                    throw new IllegalArgumentException("Invalid root reference");
                }
                roots.add(new Root(id, uri, SafValues.text(record.getString("displayName"))));
            }
        } catch (Exception cause) {
            throw new SafFailure("io-failure", "目录配置无法恢复；请保留配置并检查格式", cause);
        }
    }

    private static Uri treeUri(String value) {
        Uri uri = Uri.parse(value);
        if (!"content".equals(uri.getScheme()) || uri.getAuthority() == null || !DocumentsContract.isTreeUri(uri)) {
            throw new IllegalArgumentException("Invalid tree URI");
        }
        DocumentsContract.getTreeDocumentId(uri);
        return uri;
    }

    private void persist() throws Exception {
        JSONArray records = new JSONArray();
        for (Root root : roots) {
            JSONObject record = new JSONObject();
            record.put("rootId", root.id);
            record.put("treeUri", root.uri.toString());
            record.put("displayName", root.name);
            records.put(record);
        }
        JSONObject registry = new JSONObject();
        registry.put("schemaVersion", 1);
        registry.put("deviceId", deviceId);
        registry.put("roots", records);
        if (!preferences.edit().putString("registry", registry.toString()).commit()) {
            throw new IOException("Registry save failed");
        }
    }

    private boolean hasGrant(Root root) {
        for (UriPermission permission : resolver.getPersistedUriPermissions()) {
            if (permission.getUri().equals(root.uri) && permission.isReadPermission()) return true;
        }
        return false;
    }

    private Root requireRoot(String rootId) throws SafFailure {
        for (Root root : roots) {
            if (root.id.equals(rootId)) {
                if (!hasGrant(root)) throw new SafFailure("authorization-expired", "目录授权已失效，请重新选择");
                return root;
            }
        }
        throw new SafFailure("not-found", "目录引用不存在，请重新选择");
    }

    private JSObject describe(Root root, String authorization) {
        JSObject value = new JSObject();
        value.put("rootId", root.id);
        value.put("deviceId", deviceId);
        value.put("displayName", root.name);
        DirectoryDisplay.Info info = display.get(root.id);
        if (info == null) {
            info = DirectoryDisplay.resolve(context, resolver, root.uri, root.name);
            display.put(root.id, info);
        }
        value.put("displayPath", info.path);
        if (info.parentName != null && !info.parentName.trim().isEmpty()) value.put("parentName", info.parentName);
        value.put("authorization", authorization);
        return value;
    }

    /** 仅持久化真实系统选择器结果中的 READ 权限；不会撤销已有授权。 */
    synchronized JSObject register(Uri selected, int flags, CancellationSignal signal) throws SafFailure {
        Root candidate = null;
        boolean hadGrant = false;
        boolean added = false;
        try {
            Uri uri = treeUri(selected.toString());
            if ((flags & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0 ||
                (flags & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) == 0) {
                throw new SafFailure("permission-denied", "提供者未授予可持久化的读取权限");
            }
            candidate = new Root(UUID.randomUUID().toString(), uri, "目录");
            for (Root root : roots) if (root.uri.equals(uri)) candidate = root;
            hadGrant = hasGrant(candidate);
            resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Snapshot snapshot = query(candidate, DocumentsContract.getTreeDocumentId(uri), signal);
            if (!snapshot.isDirectory) throw new SafFailure("not-readable", "所选引用不是目录");
            Root saved = new Root(candidate.id, uri, snapshot.name);
            if (!roots.contains(candidate)) {
                roots.add(saved);
                added = true;
            }
            signal.throwIfCanceled();
            persist();
            display.remove(candidate.id);
            return describe(added ? saved : candidate, "granted");
        } catch (Exception cause) {
            if (added && candidate != null) {
                String id = candidate.id;
                roots.removeIf(root -> root.id.equals(id));
            }
            if (candidate != null && !hadGrant) {
                try {
                    resolver.releasePersistableUriPermission(candidate.uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (SecurityException ignored) {
                    // 获取失败时没有需要释放的新授权；不触碰任何已有授权。
                }
            }
            throw SafFailure.from(cause);
        }
    }

    /** 仅返回已登记根目录；保留已过期或不可用的引用以供恢复。 */
    synchronized JSONArray listRoots(CancellationSignal signal) throws SafFailure {
        JSONArray result = new JSONArray();
        try {
            for (Root root : roots) {
                signal.throwIfCanceled();
                String authorization = "expired";
                if (hasGrant(root)) {
                    try {
                        Snapshot snapshot = query(root, DocumentsContract.getTreeDocumentId(root.uri), signal);
                        authorization = snapshot.isDirectory ? "granted" : "unavailable";
                    } catch (SecurityException cause) {
                        authorization = "expired";
                    } catch (java.io.FileNotFoundException cause) {
                        authorization = "unavailable";
                    }
                }
                result.put(describe(root, authorization));
            }
            return result;
        } catch (Exception cause) {
            throw SafFailure.from(cause);
        }
    }

    /** 仅枚举当前层；未知属性保留为 null，提供者失败不会返回空列表。 */
    synchronized JSObject listDirectory(String rootId, String parentId, CancellationSignal signal) throws SafFailure {
        try {
            Root root = requireRoot(rootId);
            String documentId = DocumentsContract.getTreeDocumentId(root.uri);
            if (parentId != null) {
                Entry parent = requireEntry(rootId, parentId);
                Snapshot current = query(root, parent.documentId, signal);
                if (!current.isDirectory) throw new SafFailure("not-readable", "当前引用不是目录");
                documentId = parent.documentId;
            } else if (!query(root, documentId, signal).isDirectory) {
                throw new SafFailure("not-readable", "根目录已不可用");
            }
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(root.uri, documentId);
            JSONArray values = new JSONArray();
            Set<String> seen = new HashSet<>();
            try (Cursor cursor = resolver.query(children, PROJECTION, null, null, null, signal)) {
                if (cursor == null) throw new IOException("Provider returned no cursor");
                while (cursor.moveToNext()) {
                    signal.throwIfCanceled();
                    Snapshot snapshot = decode(cursor);
                    if (!seen.add(snapshot.documentId) || snapshot.documentId.equals(documentId)) {
                        throw new IOException("Provider returned inconsistent IDs");
                    }
                    String key = rootId + "\n" + snapshot.documentId;
                    String id = documentIds.get(key);
                    if (id == null) {
                        id = UUID.randomUUID().toString();
                        documentIds.put(key, id);
                    }
                    entries.put(id, new Entry(rootId, snapshot.documentId, parentId, snapshot));
                    values.put(metadata(rootId, id, parentId, snapshot));
                }
            }
            signal.throwIfCanceled();
            JSObject result = new JSObject();
            result.put("rootId", rootId);
            result.put("parentId", parentId == null ? JSONObject.NULL : parentId);
            result.put("observedAt", System.currentTimeMillis());
            result.put("entries", values);
            return result;
        } catch (Exception cause) {
            throw SafFailure.from(cause);
        }
    }

    private Entry requireEntry(String rootId, String entryId) throws SafFailure {
        Entry entry = entries.get(entryId);
        if (entry == null || !entry.rootId.equals(rootId)) {
            throw new SafFailure("not-found", "条目引用不存在或已过期，请重新读取目录");
        }
        return entry;
    }

    /** 发布器专用原生定位；只读 JS 桥不调用此入口，也不导出其中的 URI。 */
    static final class PublicationDirectory implements NewFilePublisher.Directory {
        final String rootId, parentId, documentId, name;
        final Uri tree, uri;
        PublicationDirectory(String rootId, String parentId, String documentId, String name, Uri tree) {
            this.rootId = rootId; this.parentId = parentId; this.documentId = documentId; this.name = name;
            this.tree = tree; uri = DocumentsContract.buildDocumentUriUsingTree(tree, documentId);
        }
    }

    synchronized PublicationDirectory publicationDirectory(String rootId, String parentId, CancellationSignal signal) throws SafFailure {
        return publicationDirectory(rootId, parentId, signal, true);
    }
    /** 覆盖已有文件不要求父目录支持新建；目录/文件创建仍显式核实创建能力。 */
    synchronized PublicationDirectory publicationDirectory(String rootId, String parentId, CancellationSignal signal, boolean requireCreate) throws SafFailure {
        try {
            Root root = requireRoot(rootId);
            boolean write = false;
            for (UriPermission permission : resolver.getPersistedUriPermissions()) {
                if (permission.getUri().equals(root.uri) && permission.isWritePermission()) write = true;
            }
            if (!write) throw new SafFailure("permission-denied", "系统尚未授予该目录持久写权限");
            Entry parent = parentId == null ? null : requireEntry(rootId, parentId);
            String id = parent == null ? DocumentsContract.getTreeDocumentId(root.uri) : parent.documentId;
            Snapshot current = query(root, id, signal);
            if (!current.isDirectory || current.isVirtual) throw new SafFailure("unsupported-operation", "目标不是普通目录");
            String expected = parent == null ? root.name : parent.snapshot.name;
            if (!expected.equals(current.name)) throw new SafFailure("source-changed", "目标目录名称已变化");
            if (requireCreate && (current.flags & Document.FLAG_DIR_SUPPORTS_CREATE) == 0) {
                throw new SafFailure("unsupported-operation", "提供者未声明支持新建文件");
            }
            return new PublicationDirectory(rootId, parentId, id, current.name, root.uri);
        } catch (Exception cause) { throw SafFailure.from(cause); }
    }

    synchronized PublicationModel.Entry publicationEntry(PublicationDirectory directory, Snapshot snapshot) throws SafFailure {
        requireRoot(directory.rootId);
        String key = directory.rootId + "\n" + snapshot.documentId;
        String entryId = documentIds.get(key);
        if (entryId == null) { entryId = UUID.randomUUID().toString(); documentIds.put(key, entryId); }
        entries.put(entryId, new Entry(directory.rootId, snapshot.documentId, directory.parentId, snapshot));
        return new PublicationModel.Entry(directory.rootId, directory.parentId, entryId, snapshot.name, snapshot.size, snapshot.modified);
    }

    /**
     * 归档读取前后重新查询授权、身份、类型及可观察属性。只返回原生观察模型；
     * 未知长度保留 null，不能以新查询覆盖枚举时的基线后继续读取已变化的源。
     */
    synchronized ArchiveModel.Observation archiveObservation(String rootId, String entryId,
                                                            CancellationSignal signal) throws SafFailure {
        try {
            Root root = requireRoot(rootId);
            Entry entry = requireEntry(rootId, entryId);
            Snapshot current = query(root, entry.documentId, signal);
            if (current.isDirectory || current.isVirtual) {
                throw new SafFailure("unsupported-operation", "该条目不支持原始文件归档");
            }
            ArchiveModel.Observation baseline = observation(entry, entry.snapshot);
            ArchiveModel.Observation observed = observation(entry, current);
            if (!baseline.same(observed)) throw new SafFailure("source-changed", "源文件属性已变化，请重新读取目录");
            return observed;
        } catch (Exception cause) { throw SafFailure.from(cause); }
    }

    private ArchiveModel.Observation observation(Entry entry, Snapshot snapshot) {
        return new ArchiveModel.Observation(entry.rootId + ":" + snapshot.documentId,
            documentIds.get(entry.rootId + "\n" + entry.documentId), entry.parentId,
            snapshot.name, snapshot.size, snapshot.modified);
    }

    /**
     * 以 r 模式打开当前已枚举的文件；返回流归调用者所有，调用者必须关闭。
     * 每次读取均检查取消状态；生命周期管理方还必须关闭阻塞中的流。
     * 字节不经过 JS 桥；大小和日期检查仅用于发现可观察的源变化，不提供原子快照。
     */
    synchronized InputStream openFile(String rootId, String entryId, CancellationSignal signal) throws SafFailure {
        try {
            Root root = requireRoot(rootId);
            Entry entry = requireEntry(rootId, entryId);
            Snapshot current = query(root, entry.documentId, signal);
            if (current.isDirectory || current.isVirtual) {
                throw new SafFailure("unsupported-operation", "该条目不支持原始文件读取");
            }
            if (!current.name.equals(entry.snapshot.name) ||
                !java.util.Objects.equals(current.size, entry.snapshot.size) ||
                !java.util.Objects.equals(current.modified, entry.snapshot.modified)) {
                throw new SafFailure("source-changed", "源文件属性已变化，请重新读取目录");
            }
            AssetFileDescriptor descriptor = resolver.openAssetFileDescriptor(documentUri(root, entry.documentId), "r", signal);
            if (descriptor == null) throw new IOException("Provider returned no descriptor");
            try {
                InputStream stream = descriptor.createInputStream();
                signal.throwIfCanceled();
                return new FilterInputStream(stream) {
                    @Override public int read() throws IOException {
                        signal.throwIfCanceled();
                        return in.read();
                    }
                    @Override public int read(byte[] buffer, int offset, int length) throws IOException {
                        signal.throwIfCanceled();
                        return in.read(buffer, offset, length);
                    }
                    @Override public void close() throws IOException {
                        try { super.close(); } finally { descriptor.close(); }
                    }
                };
            } catch (Exception cause) {
                descriptor.close();
                throw cause;
            }
        } catch (Exception cause) {
            throw SafFailure.from(cause);
        }
    }

    private Uri documentUri(Root root, String documentId) {
        return DocumentsContract.buildDocumentUriUsingTree(root.uri, documentId);
    }

    private Snapshot query(Root root, String documentId, CancellationSignal signal) throws Exception {
        try (Cursor cursor = resolver.query(documentUri(root, documentId), PROJECTION, null, null, null, signal)) {
            if (cursor == null) throw new IOException("Provider returned no cursor");
            if (!cursor.moveToFirst()) throw new java.io.FileNotFoundException("Document missing");
            Snapshot snapshot = decode(cursor);
            if (!documentId.equals(snapshot.documentId)) throw new IOException("Provider ID mismatch");
            return snapshot;
        }
    }

    private static String requiredString(Cursor cursor, String column) {
        int index = cursor.getColumnIndexOrThrow(column);
        if (cursor.getType(index) != Cursor.FIELD_TYPE_STRING) {
            throw new IllegalArgumentException("Invalid provider text field");
        }
        return cursor.getString(index);
    }

    private static Long optionalLong(Cursor cursor, String column) {
        int index = cursor.getColumnIndex(column);
        if (index < 0 || cursor.isNull(index)) return null;
        if (cursor.getType(index) != Cursor.FIELD_TYPE_INTEGER) {
            throw new IllegalArgumentException("Invalid provider numeric field");
        }
        return cursor.getLong(index);
    }

    static Snapshot decode(Cursor cursor) {
        String documentId = requiredString(cursor, Document.COLUMN_DOCUMENT_ID);
        if (documentId.isEmpty()) throw new IllegalArgumentException("Missing document ID");
        String name = SafValues.text(requiredString(cursor, Document.COLUMN_DISPLAY_NAME));
        String mime = requiredString(cursor, Document.COLUMN_MIME_TYPE);
        if (mime.isEmpty()) throw new IllegalArgumentException("Missing document kind");
        boolean directory = Document.MIME_TYPE_DIR.equals(mime);
        Long flags = optionalLong(cursor, Document.COLUMN_FLAGS);
        return new Snapshot(documentId, name, directory,
            flags != null,
            flags != null && (flags & Document.FLAG_VIRTUAL_DOCUMENT) != 0,
            directory ? null : SafValues.size(optionalLong(cursor, Document.COLUMN_SIZE)),
            SafValues.modified(optionalLong(cursor, Document.COLUMN_LAST_MODIFIED)), flags == null ? 0 : flags);
    }

    static JSObject metadata(String rootId, String entryId, String parentId, Snapshot snapshot) {
        JSObject capabilities = new JSObject();
        capabilities.put("canRead", snapshot.isDirectory || snapshot.isVirtual ? "unsupported" :
            snapshot.hasFlags ? "supported" : "unknown");
        capabilities.put("canList", snapshot.isDirectory ? "supported" : "unsupported");
        capabilities.put("canCreate", "unsupported");
        capabilities.put("canRename", "unsupported");
        capabilities.put("canDelete", "unsupported");
        JSObject value = new JSObject();
        value.put("rootId", rootId);
        value.put("entryId", entryId);
        value.put("parentId", parentId == null ? JSONObject.NULL : parentId);
        value.put("name", snapshot.name);
        value.put("kind", snapshot.isDirectory ? "directory" : "file");
        value.put("sizeBytes", snapshot.size == null ? JSONObject.NULL : snapshot.size);
        value.put("modifiedAt", snapshot.modified == null ? JSONObject.NULL : snapshot.modified);
        value.put("capabilities", capabilities);
        return value;
    }

    private static final class Root {
        final String id;
        final Uri uri;
        final String name;
        Root(String id, Uri uri, String name) { this.id = id; this.uri = uri; this.name = name; }
    }

    private static final class Entry {
        final String rootId;
        final String documentId;
        final String parentId;
        final Snapshot snapshot;
        Entry(String rootId, String documentId, String parentId, Snapshot snapshot) {
            this.rootId = rootId; this.documentId = documentId; this.parentId = parentId; this.snapshot = snapshot;
        }
    }

    static final class Snapshot {
        final String documentId;
        final String name;
        final boolean isDirectory;
        final boolean hasFlags;
        final boolean isVirtual;
        final Long size;
        final Long modified;
        final long flags;
        Snapshot(String documentId, String name, boolean isDirectory, boolean hasFlags, boolean isVirtual, Long size, Long modified) {
            this(documentId, name, isDirectory, hasFlags, isVirtual, size, modified, 0);
        }
        Snapshot(String documentId, String name, boolean isDirectory, boolean hasFlags, boolean isVirtual, Long size, Long modified, long flags) {
            this.documentId = documentId; this.name = name; this.isDirectory = isDirectory;
            this.hasFlags = hasFlags; this.isVirtual = isVirtual; this.size = size; this.modified = modified; this.flags = flags;
        }
    }
}
