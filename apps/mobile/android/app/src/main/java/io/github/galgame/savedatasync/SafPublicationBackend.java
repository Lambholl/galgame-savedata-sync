package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.PublicationModel.Entry;
import static io.github.galgame.savedatasync.PublicationModel.MAX_DIRECTORY_ENTRIES;

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

/**
 * SAF 的发布后端，只写能核实为常规文件的描述符：以 rw 打开，比较设备号和 inode 后再写入。
 *
 * <p>SAF 没有比较后删除的操作，元数据和描述符复核只能发现可观察的竞争，提供者仍可能在两次检查之间替换文件。
 */
final class SafPublicationBackend implements NewFilePublisher.Backend {

  private static final String[] COLUMNS = {
    Document.COLUMN_DOCUMENT_ID,
    Document.COLUMN_DISPLAY_NAME,
    Document.COLUMN_MIME_TYPE,
    Document.COLUMN_SIZE,
    Document.COLUMN_LAST_MODIFIED,
    Document.COLUMN_FLAGS,
  };
  private final ContentResolver resolver;
  private final SafDirectoryStore store;

  SafPublicationBackend(Context context, SafDirectoryStore store) {
    resolver = context.getApplicationContext().getContentResolver();
    this.store = store;
  }

  private static final class Signal implements Closeable {

    final CancellationSignal value = new CancellationSignal();

    @Override
    public void close() {
      value.cancel();
    }
  }

  @Override
  public NewFilePublisher.Directory locate(String rootId, String parentId, ArchiveControl control)
    throws Exception {
    Signal signal = control.track(new Signal());
    try {
      return store.publicationDirectory(rootId, parentId, signal.value);
    } finally {
      control.untrack(signal);
    }
  }

  private SafDirectoryStore.PublicationDirectory checked(
    NewFilePublisher.Directory reference,
    ArchiveControl control
  ) throws Exception {
    SafDirectoryStore.PublicationDirectory directory =
      (SafDirectoryStore.PublicationDirectory) reference;
    SafDirectoryStore.PublicationDirectory current =
      (SafDirectoryStore.PublicationDirectory) locate(
        directory.rootId,
        directory.parentId,
        control
      );
    if (
      !directory.tree.equals(current.tree) ||
      !directory.documentId.equals(current.documentId) ||
      !directory.name.equals(current.name)
    ) {
      throw new ArchiveFailure("path-outside-root", "The target directory reference changed.");
    }
    return directory;
  }

  /** 通过提供者根和子文档关系查询可用容量；未知时返回 null。 */
  @Override
  public Long availableBytes(NewFilePublisher.Directory reference, ArchiveControl control)
    throws Exception {
    SafDirectoryStore.PublicationDirectory directory = checked(reference, control);
    Signal signal = control.track(new Signal());
    Long available = null;
    try (
      Cursor cursor = resolver.query(
        DocumentsContract.buildRootsUri(directory.tree.getAuthority()),
        new String[] {
          DocumentsContract.Root.COLUMN_DOCUMENT_ID,
          DocumentsContract.Root.COLUMN_AVAILABLE_BYTES,
        },
        null,
        null,
        null,
        signal.value
      )
    ) {
      while (cursor != null && cursor.moveToNext()) {
        control.check();
        if (cursor.isNull(0) || cursor.isNull(1) || cursor.getLong(1) < 0) {
          continue;
        }
        String documentId = cursor.getString(0);
        Uri root = DocumentsContract.buildDocumentUri(directory.tree.getAuthority(), documentId);
        if (
          documentId.equals(directory.documentId) ||
          DocumentsContract.isChildDocument(resolver, root, directory.uri)
        ) {
          available = cursor.getLong(1);
          break;
        }
      }
    } catch (
      java.lang.SecurityException
      | java.lang.UnsupportedOperationException
      | java.lang.IllegalArgumentException
      | java.io.FileNotFoundException cause
    ) {
      // 有些提供者只开放树授权，或没有容量和子文档查询；此时依靠写入时的 FD 检查。
      available = null;
    } finally {
      control.untrack(signal);
    }
    control.check();
    return available;
  }

  @Override
  public List<PublicationModel.Document> children(
    NewFilePublisher.Directory reference,
    ArchiveControl control
  ) throws Exception {
    SafDirectoryStore.PublicationDirectory directory = checked(reference, control);
    Signal signal = control.track(new Signal());
    List<PublicationModel.Document> result = new ArrayList<>();
    try (
      Cursor cursor = resolver.query(
        DocumentsContract.buildChildDocumentsUriUsingTree(directory.tree, directory.documentId),
        COLUMNS,
        null,
        null,
        null,
        signal.value
      )
    ) {
      if (cursor == null) {
        throw new java.io.IOException("Missing provider cursor");
      }
      while (cursor.moveToNext()) {
        control.check();
        SafDirectoryStore.Snapshot s = SafDirectoryStore.decode(cursor);
        if (result.size() == MAX_DIRECTORY_ENTRIES) {
          throw new ArchiveFailure(
            "resource-limit",
            "The current target directory level has too many entries."
          );
        }
        if (s.documentId.equals(directory.documentId)) {
          throw new ArchiveFailure(
            "result-unknown",
            "The provider returned the parent directory itself."
          );
        }
        result.add(
          new PublicationModel.Document(
            s.documentId,
            s.name,
            s.isDirectory,
            s.isVirtual,
            s.size,
            s.modified
          )
        );
      }
      return result;
    } finally {
      control.untrack(signal);
    }
  }

  @Override
  public String create(NewFilePublisher.Directory reference, String name) throws Exception {
    SafDirectoryStore.PublicationDirectory directory = checked(reference, new ArchiveControl());
    Uri uri = DocumentsContract.createDocument(
      resolver,
      directory.uri,
      "application/octet-stream",
      name
    );
    if (
      uri == null ||
      !"content".equals(uri.getScheme()) ||
      !directory.tree.getAuthority().equals(uri.getAuthority()) ||
      !DocumentsContract.isTreeUri(uri) ||
      !DocumentsContract.getTreeDocumentId(directory.tree).equals(
        DocumentsContract.getTreeDocumentId(uri)
      )
    ) {
      throw new ArchiveFailure(
        "result-unknown",
        "The provider returned an unknown creation reference."
      );
    }
    return DocumentsContract.getDocumentId(uri);
  }

  @Override
  public NewFilePublisher.Owned claim(
    NewFilePublisher.Directory reference,
    PublicationModel.Document document
  ) {
    return new SafOwned((SafDirectoryStore.PublicationDirectory) reference, document);
  }

  private final class SafOwned implements NewFilePublisher.Owned {

    private final SafDirectoryStore.PublicationDirectory directory;
    private final String id;
    private final String name;
    private final Uri uri;
    private ParcelFileDescriptor identity;
    private StructStat baseline;
    private boolean isDeleted;

    SafOwned(SafDirectoryStore.PublicationDirectory directory, PublicationModel.Document document) {
      this.directory = directory;
      id = document.id;
      name = document.name;
      uri = DocumentsContract.buildDocumentUriUsingTree(directory.tree, id);
    }

    private SafDirectoryStore.Snapshot snapshot(ArchiveControl control) throws Exception {
      checked(directory, control);
      Signal signal = control.track(new Signal());
      try (Cursor cursor = resolver.query(uri, COLUMNS, null, null, null, signal.value)) {
        if (cursor == null) {
          throw new java.io.IOException("Missing provider cursor");
        }
        if (!cursor.moveToFirst()) {
          throw new java.io.FileNotFoundException("Created document missing");
        }
        SafDirectoryStore.Snapshot s = SafDirectoryStore.decode(cursor);
        if (!id.equals(s.documentId) || !name.equals(s.name)) {
          throw new ArchiveFailure("result-unknown", "The new entry identity or name changed.");
        }
        boolean wasFound = false;
        for (PublicationModel.Document child : children(directory, control)) {
          if (child.id.equals(id)) {
            if (!name.equals(child.name)) {
              throw new ArchiveFailure(
                "result-unknown",
                "The new entry directory name does not match."
              );
            }
            wasFound = true;
          }
        }
        if (!wasFound) {
          throw new ArchiveFailure(
            "result-unknown",
            "The new entry is no longer in the authorized parent directory."
          );
        }
        return s;
      } finally {
        control.untrack(signal);
      }
    }

    private ParcelFileDescriptor descriptor(String mode, ArchiveControl control) throws Exception {
      Signal signal = control.track(new Signal());
      ParcelFileDescriptor descriptor = null;
      try {
        descriptor = resolver.openFileDescriptor(uri, mode, signal.value);
        if (descriptor == null) {
          throw new java.io.IOException("Missing provider descriptor");
        }
        StructStat stat = Os.fstat(descriptor.getFileDescriptor());
        if (!OsConstants.S_ISREG(stat.st_mode)) {
          throw new ArchiveFailure(
            "unsupported-operation",
            "The provider did not return a regular file with a verifiable identity."
          );
        }
        if (
          baseline != null && (baseline.st_dev != stat.st_dev || baseline.st_ino != stat.st_ino)
        ) {
          throw new ArchiveFailure("result-unknown", "The file descriptor identity changed.");
        }
        control.check();
        return descriptor;
      } catch (Exception cause) {
        if (descriptor != null) {
          descriptor.close();
        }
        throw cause;
      } finally {
        control.untrack(signal);
      }
    }

    private void establish(ArchiveControl control) throws Exception {
      if (identity != null) {
        return;
      }
      SafDirectoryStore.Snapshot s = snapshot(control);
      if (
        s.isDirectory ||
        s.isVirtual ||
        (s.flags & Document.FLAG_SUPPORTS_WRITE) == 0 ||
        (s.flags & Document.FLAG_SUPPORTS_DELETE) == 0
      ) {
        throw new ArchiveFailure(
          "unsupported-operation",
          "The provider cannot safely write and clean up new entries."
        );
      }
      ParcelFileDescriptor candidate = descriptor("r", control);
      try {
        StructStat stat = Os.fstat(candidate.getFileDescriptor());
        if (stat.st_size != 0 || (s.size != null && s.size != 0)) {
          throw new ArchiveFailure(
            "result-unknown",
            "The new entry already contained data before writing."
          );
        }
        baseline = stat;
        identity = candidate;
      } finally {
        if (identity != candidate) {
          candidate.close();
        }
      }
    }

    @Override
    public void verify(ArchiveControl control) throws Exception {
      establish(control);
      SafDirectoryStore.Snapshot s = snapshot(control);
      if (s.isDirectory || s.isVirtual) {
        throw new ArchiveFailure("result-unknown", "The file type changed.");
      }
      try (ParcelFileDescriptor current = descriptor("r", control)) {
        // 打开时已核实身份；现有内容不读取也不改变。
      }
    }

    @Override
    public OutputStream openOutput(long size, ArchiveControl control) throws Exception {
      verify(control);
      ParcelFileDescriptor fd = descriptor("rw", control);
      try {
        StructStat stat = Os.fstat(fd.getFileDescriptor());
        if (stat.st_size != 0) {
          throw new ArchiveFailure(
            "result-unknown",
            "Another writer changed the new entry before writing."
          );
        }
        StructStatVfs space = Os.fstatvfs(fd.getFileDescriptor());
        if (
          space.f_bavail >= 0 &&
          space.f_frsize > 0 &&
          (double) space.f_bavail * space.f_frsize < size
        ) {
          throw new ArchiveFailure(
            "insufficient-space",
            "The target directory has insufficient space."
          );
        }
        return new ParcelFileDescriptor.AutoCloseOutputStream(fd) {
          private volatile boolean isClosed;

          @Override
          public void write(byte[] bytes, int offset, int length) throws java.io.IOException {
            try {
              super.write(bytes, offset, length);
            } catch (java.io.IOException cause) {
              throw mapped(cause);
            }
          }

          @Override
          public void close() throws java.io.IOException {
            if (isClosed) {
              return;
            }
            try {
              getFD().sync();
            } catch (java.io.IOException cause) {
              throw mapped(cause);
            } finally {
              super.close();
              isClosed = true;
            }
          }
        };
      } catch (Exception cause) {
        fd.close();
        throw cause;
      }
    }

    @Override
    public InputStream openRead(ArchiveControl control) throws Exception {
      verify(control);
      return new ParcelFileDescriptor.AutoCloseInputStream(descriptor("r", control));
    }

    @Override
    public Entry entry(ArchiveControl control) throws Exception {
      return store.publicationEntry(directory, snapshot(control));
    }

    @Override
    public void delete() throws Exception {
      if (isDeleted) {
        return;
      }
      try {
        verify(new ArchiveControl());
      } catch (java.io.FileNotFoundException missing) {
        // 删除回执丢失时，重新查询与完整当前层枚举都确认缺失才完成清理。
        for (PublicationModel.Document d : children(directory, new ArchiveControl())) {
          if (d.id.equals(id)) {
            throw missing;
          }
        }
        isDeleted = true;
        return;
      }
      if (!DocumentsContract.deleteDocument(resolver, uri)) {
        throw new java.io.IOException("Provider refused cleanup");
      }
      for (PublicationModel.Document d : children(directory, new ArchiveControl())) {
        if (d.id.equals(id)) {
          throw new ArchiveFailure("result-unknown", "The entry still exists after deletion.");
        }
      }
      isDeleted = true;
    }

    @Override
    public void close() throws java.io.IOException {
      if (identity != null) {
        identity.close();
        identity = null;
      }
    }
  }

  private static java.io.IOException mapped(java.io.IOException cause) {
    for (Throwable item = cause; item != null; item = item.getCause()) {
      if (
        item instanceof ErrnoException &&
        (((ErrnoException) item).errno == OsConstants.ENOSPC ||
          ((ErrnoException) item).errno == OsConstants.EDQUOT)
      ) {
        return new ArchiveFailure(
          "insufficient-space",
          "The target file system has insufficient space.",
          false,
          cause
        );
      }
    }
    return cause;
  }
}
