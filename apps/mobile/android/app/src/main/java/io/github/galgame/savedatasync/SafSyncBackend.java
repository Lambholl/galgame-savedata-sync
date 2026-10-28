package io.github.galgame.savedatasync;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import java.io.Closeable;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import static io.github.galgame.savedatasync.TransferJson.*;
import static io.github.galgame.savedatasync.TransferSchema.*;

/** SAF 受保护写入后端；URI 留原生层，rw 打开不截断，文件写入前后比较常规 FD 身份。 */
final class SafSyncBackend implements SyncWriter.Backend {
    interface Authorization { void check(String projectId, String rootId) throws Exception; }
    private static final String[] COLUMNS = { Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME,
        Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS };
    private final ContentResolver resolver;
    private final SafDirectoryStore store;
    private final SafSyncSource source;
    private final SafPublicationBackend publication;
    private final NewFilePublisher publisher;
    private final Authorization authorization;
    SafSyncBackend(Context context, SafDirectoryStore store, Authorization authorization) {
        resolver = context.getApplicationContext().getContentResolver(); this.store = store; this.authorization = authorization;
        source = new SafSyncSource(store); publication = new SafPublicationBackend(context, store); publisher = new NewFilePublisher(publication);
    }
    @Override public SyncScanner.Source source() { return source; }
    @Override public NewFilePublisher publisher() { return publisher; }
    @Override public void authorizeProject(String projectId, String rootId, ArchiveControl control) throws Exception {
        control.check(); authorization.check(projectId, rootId); locate(rootId, null, false, control);
    }
    private static final class Signal implements Closeable {
        final CancellationSignal value = new CancellationSignal();
        @Override public void close() { value.cancel(); }
    }
    private SafDirectoryStore.PublicationDirectory locate(String rootId, String parentId, boolean create, ArchiveControl control) throws Exception {
        Signal signal = control.track(new Signal());
        try { return store.publicationDirectory(rootId, parentId, signal.value, create); }
        finally { control.untrack(signal); }
    }
    private void checked(SafDirectoryStore.PublicationDirectory directory, ArchiveControl control) throws Exception {
        SafDirectoryStore.PublicationDirectory current = locate(directory.rootId, directory.parentId, false, control);
        if (!current.tree.equals(directory.tree) || !current.documentId.equals(directory.documentId) || !current.name.equals(directory.name)) throw new ArchiveFailure("source-changed", "目标父目录引用已变化");
    }
    private List<SafDirectoryStore.Snapshot> children(SafDirectoryStore.PublicationDirectory directory, ArchiveControl control) throws Exception {
        checked(directory, control); Signal signal = control.track(new Signal()); List<SafDirectoryStore.Snapshot> result = new ArrayList<>(); Set<String> ids = new HashSet<>();
        try (Cursor cursor = resolver.query(DocumentsContract.buildChildDocumentsUriUsingTree(directory.tree, directory.documentId), COLUMNS, null, null, null, signal.value)) {
            if (cursor == null) throw new java.io.IOException("Missing provider cursor");
            while (cursor.moveToNext()) {
                control.check(); SafDirectoryStore.Snapshot value = SafDirectoryStore.decode(cursor);
                if (result.size() >= 32768) throw new ArchiveFailure("resource-limit", "目标目录条目超过限制");
                if (value.documentId.equals(directory.documentId) || !ids.add(value.documentId)) throw new ArchiveFailure("result-unknown", "提供者返回了重复或无效文档身份");
                result.add(value);
            }
        } finally { control.untrack(signal); }
        return result;
    }
    private SafDirectoryStore.Snapshot named(SafDirectoryStore.PublicationDirectory directory, String name, String expectedId, ArchiveControl control) throws Exception {
        SafDirectoryStore.Snapshot selected = null;
        for (SafDirectoryStore.Snapshot child : children(directory, control)) if (BackupModel.key(java.util.Collections.singletonList(child.name)).equals(BackupModel.key(java.util.Collections.singletonList(name)))) {
            if (selected != null || !child.name.equals(name) || expectedId == null || !child.documentId.equals(expectedId)) throw new ArchiveFailure("source-changed", "目标名称、文档身份或等价名称已变化");
            selected = child;
        }
        if (expectedId != null && selected == null) throw new ArchiveFailure("source-changed", "目标文件已经不在确认的父目录");
        return selected;
    }
    @Override public Long available(String rootId, String parentId, ArchiveControl control) throws Exception {
        // 复用根查询，未知容量保持 null；它的创建能力检查只用于此可选查询。
        try { return publication.availableBytes(locate(rootId, parentId, false, control), control); }
        catch (SafFailure failure) { if (failure.code.equals("unsupported-operation")) return null; throw failure; }
    }
    @Override public String createDirectory(String rootId, String parentId, String name, ArchiveControl control) throws Exception {
        SafDirectoryStore.PublicationDirectory directory = locate(rootId, parentId, true, control);
        List<SafDirectoryStore.Snapshot> before = children(directory, control); Set<String> ids = new HashSet<>();
        for (SafDirectoryStore.Snapshot child : before) {
            ids.add(child.documentId);
            if (BackupModel.key(java.util.Collections.singletonList(child.name)).equals(BackupModel.key(java.util.Collections.singletonList(name)))) throw new ArchiveFailure("source-changed", "计划创建的目录名称已存在");
        }
        control.check(); boolean attempted = false;
        try {
            attempted = true;
            Uri created = DocumentsContract.createDocument(resolver, directory.uri, Document.MIME_TYPE_DIR, name);
            if (created == null || !"content".equals(created.getScheme()) || !Objects.equals(created.getAuthority(), directory.tree.getAuthority()) ||
                !DocumentsContract.isTreeUri(created) || !DocumentsContract.getTreeDocumentId(created).equals(DocumentsContract.getTreeDocumentId(directory.tree))) throw new ArchiveFailure("result-unknown", "创建目录返回了未知引用");
            String id = DocumentsContract.getDocumentId(created);
            if (ids.contains(id)) throw new ArchiveFailure("result-unknown", "创建目录返回了原有文档");
            SafDirectoryStore.Snapshot value = named(directory, name, id, new ArchiveControl());
            if (value == null || !value.isDirectory || value.isVirtual) throw new ArchiveFailure("result-unknown", "新目录的名称或类型无法核实");
            return store.publicationEntry(directory, value).entryId;
        } catch (Exception cause) {
            if (attempted) throw new ArchiveFailure("result-unknown", "目录创建已开始，结果需要重新读取目标确认", false, cause);
            throw cause;
        }
    }
    @Override public SyncWriter.Replacement replacement(String rootId, String parentId, Map<String, Object> expected, ArchiveControl control) throws Exception {
        SafDirectoryStore.PublicationDirectory directory = locate(rootId, parentId, false, control);
        List<String> path = BackupModel.path(expected.get("path")); String name = path.get(path.size() - 1);
        SafDirectoryStore.Snapshot value = null;
        for (SafDirectoryStore.Snapshot child : children(directory, control)) if (child.name.equals(name)) {
            if (value != null) throw new ArchiveFailure("name-conflict", "目标有重复名称"); value = child;
        }
        if (value == null) throw new ArchiveFailure("source-changed", "被覆盖文件已不存在");
        named(directory, name, value.documentId, control);
        if (!store.publicationEntry(directory, value).entryId.equals(expected.get("entryId")) || value.isDirectory || value.isVirtual ||
            (value.flags & Document.FLAG_SUPPORTS_WRITE) == 0 || !Objects.equals(value.modified, nullable(expected.get("modifiedAt"), -BackupModel.MAX_DATE, BackupModel.MAX_DATE)) ||
            (value.size != null && value.size.longValue() != number(expected.get("sizeBytes"), 0, 9007199254740991L))) throw new ArchiveFailure("source-changed", "目标身份、类型、写权限或属性已变化");
        return new Existing(directory, value, control);
    }
    private final class Existing implements SyncWriter.Replacement {
        final SafDirectoryStore.PublicationDirectory directory;
        final String id, name;
        final Uri uri;
        final SafDirectoryStore.Snapshot original;
        final ParcelFileDescriptor identity;
        final StructStat baseline;
        ParcelFileDescriptor writable;
        boolean writing;
        Existing(SafDirectoryStore.PublicationDirectory directory, SafDirectoryStore.Snapshot value, ArchiveControl control) throws Exception {
            this.directory = directory; id = value.documentId; name = value.name; original = value;
            uri = DocumentsContract.buildDocumentUriUsingTree(directory.tree, id);
            identity = descriptor("r", control, null);
            try { baseline = Os.fstat(identity.getFileDescriptor()); }
            catch (Exception cause) { identity.close(); throw cause; }
        }
        private ParcelFileDescriptor descriptor(String mode, ArchiveControl control, StructStat expected) throws Exception {
            Signal signal = control.track(new Signal()); ParcelFileDescriptor fd = null;
            try {
                fd = resolver.openFileDescriptor(uri, mode, signal.value);
                if (fd == null) throw new java.io.IOException("Missing provider descriptor");
                StructStat value = Os.fstat(fd.getFileDescriptor());
                if (!OsConstants.S_ISREG(value.st_mode) || value.st_nlink != 1) throw new ArchiveFailure("unsupported-operation", "提供者未返回独立常规文件");
                if (expected != null && (value.st_dev != expected.st_dev || value.st_ino != expected.st_ino)) throw new ArchiveFailure("source-changed", "目标文件描述符身份已变化");
                control.check(); return fd;
            } catch (Exception cause) { if (fd != null) fd.close(); throw cause; }
            finally { control.untrack(signal); }
        }
        @Override public void verify(ArchiveControl control) throws Exception {
            SafDirectoryStore.Snapshot current = named(directory, name, id, control);
            if (current.isDirectory || current.isVirtual || (current.flags & Document.FLAG_SUPPORTS_WRITE) == 0) throw new ArchiveFailure("unsupported-operation", "目标类型或写入能力已变化");
            try (ParcelFileDescriptor fd = descriptor("r", control, baseline)) {
                StructStat stat = Os.fstat(fd.getFileDescriptor());
                if (!writing && (stat.st_size != baseline.st_size || stat.st_mtime != baseline.st_mtime || stat.st_ctime != baseline.st_ctime ||
                    !Objects.equals(current.size, original.size) || !Objects.equals(current.modified, original.modified))) throw new ArchiveFailure("source-changed", "目标内容属性已变化");
            }
        }
        @Override public InputStream read(ArchiveControl control) throws Exception {
            verify(control); return new ParcelFileDescriptor.AutoCloseInputStream(descriptor("r", control, baseline));
        }
        @Override public OutputStream output(ArchiveControl control) throws Exception {
            verify(control); ParcelFileDescriptor fd = descriptor("rw", control, baseline);
            try {
                StructStat stat = Os.fstat(fd.getFileDescriptor());
                if (stat.st_size != baseline.st_size || stat.st_mtime != baseline.st_mtime || stat.st_ctime != baseline.st_ctime) throw new ArchiveFailure("source-changed", "目标在 rw 打开时已变化");
                Os.lseek(fd.getFileDescriptor(), 0, OsConstants.SEEK_SET); writable = fd; writing = true;
                return new ParcelFileDescriptor.AutoCloseOutputStream(fd);
            } catch (Exception cause) { fd.close(); throw cause; }
        }
        @Override public void finish(long size, ArchiveControl control) throws Exception {
            control.check(); verify(control);
            if (writable == null) throw new ArchiveFailure("io-failure", "目标写句柄已关闭");
            Os.ftruncate(writable.getFileDescriptor(), size); Os.fsync(writable.getFileDescriptor());
        }
        @Override public Boolean sharesVolume(Path privateDirectory) throws Exception { return baseline.st_dev == Os.stat(privateDirectory.toString()).st_dev; }
        @Override public void close() throws java.io.IOException {
            if (writable != null) { writable.close(); writable = null; }
            identity.close();
        }
    }
}
