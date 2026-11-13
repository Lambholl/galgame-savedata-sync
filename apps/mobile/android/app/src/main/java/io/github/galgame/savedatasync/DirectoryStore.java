package io.github.galgame.savedatasync;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.OperationCanceledException;
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
 * 已授权目录的登记表，必须在 I/O 工作线程调用。
 *
 * <p>根目录经系统选择器选择，SAF 授权持久保存；条目 ID 和元数据只在当前实例中有效，文件操作都用文档 ID，经 {@link #access} 选定的实现读写。
 */
final class DirectoryStore {

  // 已保存的目录配置在这个文件里，改名会读不到。
  static final String PREFERENCES = "saf-directories-v1";
  private final ContentResolver resolver;
  private final SafDocumentAccess saf;
  private final FileDocumentAccess files;
  private final Context context;
  private final SharedPreferences preferences;
  private final List<Root> roots = new ArrayList<>();
  private final Map<String, Entry> entries = new HashMap<>();
  private final Map<String, String> documentIds = new HashMap<>();
  private final Map<String, DirectoryDisplay.Info> display = new HashMap<>();
  private final String deviceId;

  String deviceId() {
    return deviceId;
  }

  DirectoryStore(Context context) throws DirectoryFailure {
    this(context, PREFERENCES);
  }

  /** 创建登记表，根目录授权保存在名为 preferencesName 的 SharedPreferences。 */
  DirectoryStore(Context context, String preferencesName) throws DirectoryFailure {
    this.context = context.getApplicationContext();
    resolver = this.context.getContentResolver();
    saf = new SafDocumentAccess(this.context);
    files = new FileDocumentAccess(this.context);
    preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE);
    try {
      String saved = preferences.getString("registry", null);
      if (saved == null) {
        deviceId = UUID.randomUUID().toString();
        persist();
        return;
      }
      JSONObject registry = new JSONObject(saved);
      if (
        registry.length() != 3 ||
        !(registry.get("schemaVersion") instanceof Integer) ||
        registry.getInt("schemaVersion") != 1 ||
        !DocumentValues.isId(registry.get("deviceId"))
      ) {
        throw new IllegalArgumentException("Unknown registry");
      }
      deviceId = registry.getString("deviceId");
      JSONArray records = registry.getJSONArray("roots");
      Set<String> ids = new HashSet<>();
      Set<String> uris = new HashSet<>();
      for (int index = 0; index < records.length(); index++) {
        JSONObject record = records.getJSONObject(index);
        if (
          record.length() != 3 ||
          !(record.get("rootId") instanceof String) ||
          !(record.get("treeUri") instanceof String) ||
          !(record.get("displayName") instanceof String)
        ) {
          throw new IllegalArgumentException("Invalid root fields");
        }
        String id = record.getString("rootId");
        Uri uri = treeUri(record.getString("treeUri"));
        if (!DocumentValues.isId(id) || !ids.add(id) || !uris.add(uri.toString())) {
          throw new IllegalArgumentException("Invalid root reference");
        }
        roots.add(new Root(id, uri, DocumentValues.text(record.getString("displayName"))));
      }
    } catch (Exception cause) {
      throw new DirectoryFailure(
        "io-failure",
        "The directory configuration cannot be restored. Preserve it and inspect its format.",
        cause
      );
    }
  }

  private static Uri treeUri(String value) {
    Uri uri = Uri.parse(value);
    if (
      !"content".equals(uri.getScheme()) ||
      uri.getAuthority() == null ||
      !DocumentsContract.isTreeUri(uri)
    ) {
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
      if (permission.getUri().equals(root.uri) && permission.isReadPermission()) {
        return true;
      }
    }
    return false;
  }

  private Root requireRoot(String rootId) throws DirectoryFailure {
    Root root = findRoot(rootId);
    requireGrant(root);
    return root;
  }

  private Root findRoot(String rootId) throws DirectoryFailure {
    for (Root root : roots) {
      if (root.id.equals(rootId)) {
        return root;
      }
    }
    throw new DirectoryFailure(
      "not-found",
      "The directory reference does not exist. Select the directory again."
    );
  }

  private void requireGrant(Root root) throws DirectoryFailure {
    if (!hasGrant(root)) {
      throw new DirectoryFailure(
        "authorization-expired",
        "Directory authorization expired. Select the directory again."
      );
    }
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
    if (info.parentName != null && !info.parentName.trim().isEmpty()) {
      value.put("parentName", info.parentName);
    }
    value.put("authorization", authorization);
    return value;
  }

  /** 登记系统选择器选中的目录，持久化其中的 READ 权限；已有授权保持不变。 */
  synchronized JSObject register(Uri selected, int flags, CancellationSignal signal)
    throws DirectoryFailure {
    Root candidate = null;
    boolean hasExistingGrant = false;
    boolean wasAdded = false;
    try {
      Uri uri = treeUri(selected.toString());
      if (
        (flags & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0 ||
        (flags & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) == 0
      ) {
        throw new DirectoryFailure(
          "permission-denied",
          "The provider did not grant persistable read permission."
        );
      }
      candidate = new Root(UUID.randomUUID().toString(), uri, "Directory");
      for (Root root : roots) {
        if (root.uri.equals(uri)) {
          candidate = root;
        }
      }
      hasExistingGrant = hasGrant(candidate);
      resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
      Snapshot snapshot = query(candidate, DocumentsContract.getTreeDocumentId(uri), signal);
      if (!snapshot.isDirectory) {
        throw new DirectoryFailure("not-readable", "The selected reference is not a directory.");
      }
      Root saved = new Root(candidate.id, uri, snapshot.name);
      if (!roots.contains(candidate)) {
        roots.add(saved);
        wasAdded = true;
      }
      signal.throwIfCanceled();
      persist();
      display.remove(candidate.id);
      return describe(wasAdded ? saved : candidate, "granted");
    } catch (Exception cause) {
      if (wasAdded && candidate != null) {
        String id = candidate.id;
        roots.removeIf(root -> root.id.equals(id));
      }
      if (candidate != null && !hasExistingGrant) {
        try {
          resolver.releasePersistableUriPermission(
            candidate.uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION
          );
        } catch (SecurityException ignored) {
          // 获取失败时没有需要释放的新授权；不触碰任何已有授权。
        }
      }
      throw DirectoryFailure.from(cause);
    }
  }

  /** 返回已登记的根目录；已过期或不可用的引用也保留，供重新授权。 */
  synchronized JSONArray listRoots(CancellationSignal signal) throws DirectoryFailure {
    JSONArray result = new JSONArray();
    try {
      for (Root root : roots) {
        signal.throwIfCanceled();
        String authorization = "expired";
        if (hasGrant(root)) {
          try {
            Snapshot snapshot = query(root, DocumentsContract.getTreeDocumentId(root.uri), signal);
            authorization = snapshot.isDirectory ? "granted" : "unavailable";
          } catch (OperationCanceledException cause) {
            throw cause;
          } catch (SecurityException cause) {
            authorization = "expired";
          } catch (Exception cause) {
            // 一个目录读不了只标记它自己；整体失败会连累其他游戏，也存不了重新选择的目录。
            authorization = "unavailable";
          }
        }
        result.put(describe(root, authorization));
      }
      return result;
    } catch (Exception cause) {
      throw DirectoryFailure.from(cause);
    }
  }

  /**
   * 列出一层目录；提供者没有报告的属性为 null。
   *
   * @throws DirectoryFailure 提供者查询失败。
   */
  synchronized JSObject listDirectory(String rootId, String parentId, CancellationSignal signal)
    throws DirectoryFailure {
    try {
      Root root = requireRoot(rootId);
      String documentId = DocumentsContract.getTreeDocumentId(root.uri);
      if (parentId != null) {
        Entry parent = requireEntry(rootId, parentId);
        Snapshot current = query(root, parent.documentId, signal);
        if (!current.isDirectory) {
          throw new DirectoryFailure("not-readable", "The current reference is not a directory.");
        }
        documentId = parent.documentId;
      } else if (!query(root, documentId, signal).isDirectory) {
        throw new DirectoryFailure("not-readable", "The root directory is no longer available.");
      }
      JSONArray values = new JSONArray();
      Set<String> seen = new HashSet<>();
      for (Snapshot snapshot : access(root.uri).children(root.uri, documentId, signal)) {
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
      signal.throwIfCanceled();
      JSObject result = new JSObject();
      result.put("rootId", rootId);
      result.put("parentId", parentId == null ? JSONObject.NULL : parentId);
      result.put("observedAt", System.currentTimeMillis());
      result.put("entries", values);
      return result;
    } catch (Exception cause) {
      throw DirectoryFailure.from(cause);
    }
  }

  private Entry requireEntry(String rootId, String entryId) throws DirectoryFailure {
    Entry entry = entries.get(entryId);
    if (entry == null || !entry.rootId.equals(rootId)) {
      throw new DirectoryFailure(
        "not-found",
        "The entry reference does not exist or expired. Read the directory again."
      );
    }
    return entry;
  }

  /** 发布目录的位置，含提供者 URI，只在原生层使用。 */
  static final class PublicationDirectory implements NewFilePublisher.Directory {

    final String rootId;
    final String parentId;
    final String documentId;
    final String name;
    final Uri tree;
    final Uri uri;

    PublicationDirectory(String rootId, String parentId, String documentId, String name, Uri tree) {
      this.rootId = rootId;
      this.parentId = parentId;
      this.documentId = documentId;
      this.name = name;
      this.tree = tree;
      uri = DocumentsContract.buildDocumentUriUsingTree(tree, documentId);
    }
  }

  synchronized PublicationDirectory publicationDirectory(
    String rootId,
    String parentId,
    CancellationSignal signal
  ) throws DirectoryFailure {
    return publicationDirectory(rootId, parentId, signal, true);
  }

  /** 定位发布目录；requireCreate 为 true 时同时核实父目录支持新建。 */
  synchronized PublicationDirectory publicationDirectory(
    String rootId,
    String parentId,
    CancellationSignal signal,
    boolean requireCreate
  ) throws DirectoryFailure {
    try {
      Root root = requireRoot(rootId);
      boolean hasWritePermission = false;
      for (UriPermission permission : resolver.getPersistedUriPermissions()) {
        if (permission.getUri().equals(root.uri) && permission.isWritePermission()) {
          hasWritePermission = true;
        }
      }
      if (!hasWritePermission) {
        throw new DirectoryFailure(
          "permission-denied",
          "The system has not granted persistent write permission for this directory."
        );
      }
      Entry parent = parentId == null ? null : requireEntry(rootId, parentId);
      String id =
        parent == null ? DocumentsContract.getTreeDocumentId(root.uri) : parent.documentId;
      Snapshot current = query(root, id, signal);
      if (!current.isDirectory || current.isVirtual) {
        throw new DirectoryFailure(
          "unsupported-operation",
          "The target is not a regular directory."
        );
      }
      String expected = parent == null ? root.name : parent.snapshot.name;
      if (!expected.equals(current.name)) {
        throw new DirectoryFailure("source-changed", "The target directory name changed.");
      }
      if (requireCreate && (current.flags & Document.FLAG_DIR_SUPPORTS_CREATE) == 0) {
        throw new DirectoryFailure(
          "unsupported-operation",
          "The provider does not declare support for creating files."
        );
      }
      return new PublicationDirectory(rootId, parentId, id, current.name, root.uri);
    } catch (Exception cause) {
      throw DirectoryFailure.from(cause);
    }
  }

  synchronized PublicationModel.Entry publicationEntry(
    PublicationDirectory directory,
    Snapshot snapshot
  ) throws DirectoryFailure {
    requireRoot(directory.rootId);
    String key = directory.rootId + "\n" + snapshot.documentId;
    String entryId = documentIds.get(key);
    if (entryId == null) {
      entryId = UUID.randomUUID().toString();
      documentIds.put(key, entryId);
    }
    entries.put(
      entryId,
      new Entry(directory.rootId, snapshot.documentId, directory.parentId, snapshot)
    );
    return new PublicationModel.Entry(
      directory.rootId,
      directory.parentId,
      entryId,
      snapshot.name,
      snapshot.size,
      snapshot.modified
    );
  }

  /**
   * 重新查询条目的授权、身份、类型和可观察属性，返回当前的观测结果；未知长度为 null。
   *
   * @throws DirectoryFailure 条目不是常规文件，或属性与枚举时不同（source-changed）。
   */
  ArchiveModel.Observation archiveObservation(
    String rootId,
    String entryId,
    CancellationSignal signal
  ) throws DirectoryFailure {
    try {
      Root root;
      Entry entry;
      // 查询要等提供者，持锁会让同时打包的文件排队，所以只在读登记时持锁。
      synchronized (this) {
        root = findRoot(rootId);
        entry = requireEntry(rootId, entryId);
      }
      requireGrant(root);
      Snapshot current = query(root, entry.documentId, signal);
      if (current.isDirectory || current.isVirtual) {
        throw new DirectoryFailure(
          "unsupported-operation",
          "This entry does not support raw file archiving."
        );
      }
      ArchiveModel.Observation baseline;
      ArchiveModel.Observation observed;
      synchronized (this) {
        baseline = observation(entry, entry.snapshot);
        observed = observation(entry, current);
      }
      if (!baseline.same(observed)) {
        throw new DirectoryFailure(
          "source-changed",
          "Source file attributes changed. Read the directory again."
        );
      }
      return observed;
    } catch (Exception cause) {
      throw DirectoryFailure.from(cause);
    }
  }

  private ArchiveModel.Observation observation(Entry entry, Snapshot snapshot) {
    return new ArchiveModel.Observation(
      entry.rootId + ":" + snapshot.documentId,
      documentIds.get(entry.rootId + "\n" + entry.documentId),
      entry.parentId,
      snapshot.name,
      snapshot.size,
      snapshot.modified
    );
  }

  /**
   * 以 r 模式打开已枚举的文件，打开前确认名称、大小和修改时间与枚举时相同。
   *
   * <p>每次读取前检查取消状态，阻塞中的读取要关闭流才能结束。打开前的检查只能发现可观察的变化，读取期间文件仍可能被替换。
   * 可以在多个线程同时调用。
   *
   * @return 文件的读流，由调用者关闭。
   * @throws DirectoryFailure 条目不是常规文件，或属性与枚举时不同（source-changed）。
   */
  InputStream openFile(String rootId, String entryId, CancellationSignal signal)
    throws DirectoryFailure {
    try {
      Root root;
      Entry entry;
      // 只在查登记时持锁：查询和打开要等提供者，持锁会让同时打开的文件排队。
      synchronized (this) {
        root = findRoot(rootId);
        entry = requireEntry(rootId, entryId);
      }
      requireGrant(root);
      Snapshot current = query(root, entry.documentId, signal);
      if (current.isDirectory || current.isVirtual) {
        throw new DirectoryFailure(
          "unsupported-operation",
          "This entry does not support raw file reading."
        );
      }
      if (
        !current.name.equals(entry.snapshot.name) ||
        !java.util.Objects.equals(current.size, entry.snapshot.size) ||
        !java.util.Objects.equals(current.modified, entry.snapshot.modified)
      ) {
        throw new DirectoryFailure(
          "source-changed",
          "Source file attributes changed. Read the directory again."
        );
      }
      InputStream stream = access(root.uri).read(root.uri, entry.documentId, signal);
      try {
        signal.throwIfCanceled();
        return new FilterInputStream(stream) {
          @Override
          public int read() throws IOException {
            signal.throwIfCanceled();
            return in.read();
          }

          @Override
          public int read(byte[] buffer, int offset, int length) throws IOException {
            signal.throwIfCanceled();
            return in.read(buffer, offset, length);
          }
        };
      } catch (Exception cause) {
        stream.close();
        throw cause;
      }
    } catch (Exception cause) {
      throw DirectoryFailure.from(cause);
    }
  }

  /**
   * 返回访问这棵树要用的实现：有所有文件访问权限且树能按路径读写时按路径读写，否则走 SAF。
   *
   * <p>结果只取决于权限和树本身，不取决于某个文件当时能否读写，所以权限不变时同一棵树总得到同一种实现。
   */
  DocumentAccess access(Uri tree) {
    return files.supports(tree) ? files : saf;
  }

  private Snapshot query(Root root, String documentId, CancellationSignal signal) throws Exception {
    return access(root.uri).query(root.uri, documentId, signal);
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
    if (index < 0 || cursor.isNull(index)) {
      return null;
    }
    if (cursor.getType(index) != Cursor.FIELD_TYPE_INTEGER) {
      throw new IllegalArgumentException("Invalid provider numeric field");
    }
    return cursor.getLong(index);
  }

  static Snapshot decode(Cursor cursor) {
    String documentId = requiredString(cursor, Document.COLUMN_DOCUMENT_ID);
    if (documentId.isEmpty()) {
      throw new IllegalArgumentException("Missing document ID");
    }
    String name = DocumentValues.text(requiredString(cursor, Document.COLUMN_DISPLAY_NAME));
    String mime = requiredString(cursor, Document.COLUMN_MIME_TYPE);
    if (mime.isEmpty()) {
      throw new IllegalArgumentException("Missing document kind");
    }
    boolean isDirectory = Document.MIME_TYPE_DIR.equals(mime);
    Long flags = optionalLong(cursor, Document.COLUMN_FLAGS);
    return new Snapshot(
      documentId,
      name,
      isDirectory,
      flags != null,
      flags != null && (flags & Document.FLAG_VIRTUAL_DOCUMENT) != 0,
      isDirectory ? null : DocumentValues.size(optionalLong(cursor, Document.COLUMN_SIZE)),
      DocumentValues.modified(optionalLong(cursor, Document.COLUMN_LAST_MODIFIED)),
      flags == null ? 0 : flags
    );
  }

  static JSObject metadata(String rootId, String entryId, String parentId, Snapshot snapshot) {
    JSObject capabilities = new JSObject();
    capabilities.put(
      "canRead",
      snapshot.isDirectory || snapshot.isVirtual
        ? "unsupported"
        : snapshot.hasFlags
          ? "supported"
          : "unknown"
    );
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

    Root(String id, Uri uri, String name) {
      this.id = id;
      this.uri = uri;
      this.name = name;
    }
  }

  private static final class Entry {

    final String rootId;
    final String documentId;
    final String parentId;
    final Snapshot snapshot;

    Entry(String rootId, String documentId, String parentId, Snapshot snapshot) {
      this.rootId = rootId;
      this.documentId = documentId;
      this.parentId = parentId;
      this.snapshot = snapshot;
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

    Snapshot(
      String documentId,
      String name,
      boolean isDirectory,
      boolean hasFlags,
      boolean isVirtual,
      Long size,
      Long modified
    ) {
      this(documentId, name, isDirectory, hasFlags, isVirtual, size, modified, 0);
    }

    Snapshot(
      String documentId,
      String name,
      boolean isDirectory,
      boolean hasFlags,
      boolean isVirtual,
      Long size,
      Long modified,
      long flags
    ) {
      this.documentId = documentId;
      this.name = name;
      this.isDirectory = isDirectory;
      this.hasFlags = hasFlags;
      this.isVirtual = isVirtual;
      this.size = size;
      this.modified = modified;
      this.flags = flags;
    }
  }
}
