package io.github.galgame.savedatasync;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import android.system.StructStatVfs;
import java.io.Closeable;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import static io.github.galgame.savedatasync.PublicationModel.*;

/**
 * 实际 SAF 后端。仅支持可核实为常规文件的描述符，rw 不截断，先比较设备/inode 再写入。
 * 不把文档 ID 转成路径；不遍历清理目录，也不重命名/覆盖。SAF 无比较后删除原语，
 * 元数据与描述符复核只能发现可观察竞争，不能承诺对恶意提供者的原子命名空间隔离。
 */
final class SafPublicationBackend implements NewFilePublisher.Backend {
    private static final String[] COLUMNS = {
        Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
        Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS
    };
    private final ContentResolver resolver;
    private final SafDirectoryStore store;
    SafPublicationBackend(Context context, SafDirectoryStore store) {
        resolver = context.getApplicationContext().getContentResolver(); this.store = store;
    }
    private static final class Signal implements Closeable {
        final CancellationSignal value = new CancellationSignal();
        @Override public void close() { value.cancel(); }
    }
    @Override public NewFilePublisher.Directory locate(String rootId, String parentId, ArchiveControl control) throws Exception {
        Signal signal = control.track(new Signal());
        try { return store.publicationDirectory(rootId, parentId, signal.value); }
        finally { control.untrack(signal); }
    }
    private SafDirectoryStore.PublicationDirectory checked(NewFilePublisher.Directory reference, ArchiveControl control) throws Exception {
        SafDirectoryStore.PublicationDirectory directory = (SafDirectoryStore.PublicationDirectory) reference;
        SafDirectoryStore.PublicationDirectory current = (SafDirectoryStore.PublicationDirectory) locate(directory.rootId, directory.parentId, control);
        if (!directory.tree.equals(current.tree) || !directory.documentId.equals(current.documentId) || !directory.name.equals(current.name)) {
            throw new ArchiveFailure("path-outside-root", "目标目录引用已变化");
        }
        return directory;
    }
    @Override public List<PublicationModel.Document> children(NewFilePublisher.Directory reference, ArchiveControl control) throws Exception {
        SafDirectoryStore.PublicationDirectory directory = checked(reference, control);
        Signal signal = control.track(new Signal());
        List<PublicationModel.Document> result = new ArrayList<>();
        try (Cursor cursor = resolver.query(DocumentsContract.buildChildDocumentsUriUsingTree(directory.tree, directory.documentId),
            COLUMNS, null, null, null, signal.value)) {
            if (cursor == null) throw new java.io.IOException("Missing provider cursor");
            while (cursor.moveToNext()) {
                control.check(); SafDirectoryStore.Snapshot s = SafDirectoryStore.decode(cursor);
                if (result.size() == MAX_DIRECTORY_ENTRIES) throw new ArchiveFailure("resource-limit", "目标当前层条目过多");
                if (s.documentId.equals(directory.documentId)) throw new ArchiveFailure("result-unknown", "提供者返回了父目录自身");
                result.add(new PublicationModel.Document(s.documentId, s.name, s.isDirectory, s.isVirtual, s.size, s.modified));
            }
            return result;
        } finally { control.untrack(signal); }
    }
    @Override public String create(NewFilePublisher.Directory reference, String name) throws Exception {
        SafDirectoryStore.PublicationDirectory directory = checked(reference, new ArchiveControl());
        Uri uri = DocumentsContract.createDocument(resolver, directory.uri, "application/octet-stream", name);
        if (uri == null || !"content".equals(uri.getScheme()) || !directory.tree.getAuthority().equals(uri.getAuthority()) ||
            !DocumentsContract.isTreeUri(uri) || !DocumentsContract.getTreeDocumentId(directory.tree).equals(DocumentsContract.getTreeDocumentId(uri))) {
            throw new ArchiveFailure("result-unknown", "提供者返回了未知创建引用");
        }
        return DocumentsContract.getDocumentId(uri);
    }
    @Override public NewFilePublisher.Owned claim(NewFilePublisher.Directory reference, PublicationModel.Document document) {
        return new SafOwned((SafDirectoryStore.PublicationDirectory) reference, document);
    }

    private final class SafOwned implements NewFilePublisher.Owned {
        private final SafDirectoryStore.PublicationDirectory directory;
        private final String id, name;
        private final Uri uri;
        private ParcelFileDescriptor identity;
        private StructStat baseline;
        private boolean deleted;
        SafOwned(SafDirectoryStore.PublicationDirectory directory, PublicationModel.Document document) {
            this.directory = directory; id = document.id; name = document.name;
            uri = DocumentsContract.buildDocumentUriUsingTree(directory.tree, id);
        }
        private SafDirectoryStore.Snapshot snapshot(ArchiveControl control) throws Exception {
            checked(directory, control);
            Signal signal = control.track(new Signal());
            try (Cursor cursor = resolver.query(uri, COLUMNS, null, null, null, signal.value)) {
                if (cursor == null) throw new java.io.IOException("Missing provider cursor");
                if (!cursor.moveToFirst()) throw new java.io.FileNotFoundException("Created document missing");
                SafDirectoryStore.Snapshot s = SafDirectoryStore.decode(cursor);
                if (!id.equals(s.documentId) || !name.equals(s.name)) throw new ArchiveFailure("result-unknown", "新条目的身份或名称已变化");
                boolean found = false;
                for (PublicationModel.Document child : children(directory, control)) if (child.id.equals(id)) {
                    if (!name.equals(child.name)) throw new ArchiveFailure("result-unknown", "新条目的目录名称不一致");
                    found = true;
                }
                if (!found) throw new ArchiveFailure("result-unknown", "新条目已不在授权父目录");
                return s;
            } finally { control.untrack(signal); }
        }
        private ParcelFileDescriptor descriptor(String mode, ArchiveControl control) throws Exception {
            Signal signal = control.track(new Signal());
            ParcelFileDescriptor descriptor = null;
            try {
                descriptor = resolver.openFileDescriptor(uri, mode, signal.value);
                if (descriptor == null) throw new java.io.IOException("Missing provider descriptor");
                StructStat stat = Os.fstat(descriptor.getFileDescriptor());
                if (!OsConstants.S_ISREG(stat.st_mode)) throw new ArchiveFailure("unsupported-operation", "提供者未返回可核实身份的常规文件");
                if (baseline != null && (baseline.st_dev != stat.st_dev || baseline.st_ino != stat.st_ino)) {
                    throw new ArchiveFailure("result-unknown", "文件描述符身份已变化");
                }
                control.check();
                return descriptor;
            } catch (Exception cause) {
                if (descriptor != null) descriptor.close();
                throw cause;
            } finally { control.untrack(signal); }
        }
        private void establish(ArchiveControl control) throws Exception {
            if (identity != null) return;
            SafDirectoryStore.Snapshot s = snapshot(control);
            if (s.isDirectory || s.isVirtual || (s.flags & Document.FLAG_SUPPORTS_WRITE) == 0 ||
                (s.flags & Document.FLAG_SUPPORTS_DELETE) == 0) {
                throw new ArchiveFailure("unsupported-operation", "提供者不能安全写入及清理新条目");
            }
            ParcelFileDescriptor candidate = descriptor("r", control);
            try {
                StructStat stat = Os.fstat(candidate.getFileDescriptor());
                if (stat.st_size != 0 || (s.size != null && s.size != 0)) {
                    throw new ArchiveFailure("result-unknown", "新条目在写入前已有内容");
                }
                baseline = stat; identity = candidate;
            } finally { if (identity != candidate) candidate.close(); }
        }
        @Override public void verify(ArchiveControl control) throws Exception {
            establish(control);
            SafDirectoryStore.Snapshot s = snapshot(control);
            if (s.isDirectory || s.isVirtual) throw new ArchiveFailure("result-unknown", "文件类型发生变化");
            try (ParcelFileDescriptor current = descriptor("r", control)) {
                // 打开时已核实身份；不读取或改变现有内容。
            }
        }
        @Override public OutputStream openOutput(long size, ArchiveControl control) throws Exception {
            verify(control);
            ParcelFileDescriptor fd = descriptor("rw", control);
            try {
                StructStat stat = Os.fstat(fd.getFileDescriptor());
                if (stat.st_size != 0) throw new ArchiveFailure("result-unknown", "写入前新条目已被其他写入者改变");
                StructStatVfs space = Os.fstatvfs(fd.getFileDescriptor());
                if (space.f_bavail >= 0 && space.f_frsize > 0 && (double) space.f_bavail * space.f_frsize < size) {
                    throw new ArchiveFailure("insufficient-space", "目标目录空间不足");
                }
                return new ParcelFileDescriptor.AutoCloseOutputStream(fd) {
                    private volatile boolean closed;
                    @Override public void write(byte[] bytes, int offset, int length) throws java.io.IOException {
                        try { super.write(bytes, offset, length); }
                        catch (java.io.IOException cause) { throw mapped(cause); }
                    }
                    @Override public void close() throws java.io.IOException {
                        if (closed) return;
                        try { getFD().sync(); }
                        catch (java.io.IOException cause) { throw mapped(cause); }
                        finally { super.close(); closed = true; }
                    }
                };
            } catch (Exception cause) { fd.close(); throw cause; }
        }
        @Override public InputStream openRead(ArchiveControl control) throws Exception {
            verify(control); return new ParcelFileDescriptor.AutoCloseInputStream(descriptor("r", control));
        }
        @Override public Entry entry(ArchiveControl control) throws Exception { return store.publicationEntry(directory, snapshot(control)); }
        @Override public void delete() throws Exception {
            if (deleted) return;
            try { verify(new ArchiveControl()); }
            catch (java.io.FileNotFoundException missing) {
                // 删除回执丢失时，重新查询与完整当前层枚举都确认缺失才完成清理。
                for (PublicationModel.Document d : children(directory, new ArchiveControl())) if (d.id.equals(id)) throw missing;
                deleted = true; return;
            }
            if (!DocumentsContract.deleteDocument(resolver, uri)) throw new java.io.IOException("Provider refused cleanup");
            for (PublicationModel.Document d : children(directory, new ArchiveControl())) if (d.id.equals(id)) {
                throw new ArchiveFailure("result-unknown", "删除后的条目仍存在");
            }
            deleted = true;
        }
        @Override public void close() throws java.io.IOException { if (identity != null) { identity.close(); identity = null; } }
    }
    private static java.io.IOException mapped(java.io.IOException cause) {
        for (Throwable item = cause; item != null; item = item.getCause()) {
            if (item instanceof ErrnoException && (((ErrnoException) item).errno == OsConstants.ENOSPC ||
                ((ErrnoException) item).errno == OsConstants.EDQUOT)) {
                return new ArchiveFailure("insufficient-space", "目标文件系统空间不足", false, cause);
            }
        }
        return cause;
    }
}
