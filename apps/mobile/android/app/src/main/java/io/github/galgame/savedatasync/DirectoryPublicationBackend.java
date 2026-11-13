package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.PublicationModel.Entry;
import static io.github.galgame.savedatasync.PublicationModel.MAX_DIRECTORY_ENTRIES;

import android.content.Context;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract.Document;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import android.system.StructStatVfs;
import java.io.Closeable;
import java.io.FileNotFoundException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 新文件的发布后端，只写能核实为常规文件的描述符：以 rw 打开，比较设备号和 inode 后再写入。
 *
 * <p>没有比较后删除的操作，元数据和描述符复核只能发现可观察的竞争，文件仍可能在两次检查之间被替换。
 */
final class DirectoryPublicationBackend implements NewFilePublisher.Backend {

  private final DirectoryStore store;

  DirectoryPublicationBackend(Context context, DirectoryStore store) {
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

  private DirectoryStore.PublicationDirectory checked(
    NewFilePublisher.Directory reference,
    ArchiveControl control
  ) throws Exception {
    DirectoryStore.PublicationDirectory directory = (DirectoryStore.PublicationDirectory) reference;
    DirectoryStore.PublicationDirectory current = (DirectoryStore.PublicationDirectory) locate(
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

  private static PublicationModel.Document publicationDocument(DirectoryStore.Snapshot s) {
    return new PublicationModel.Document(
      s.documentId,
      s.name,
      s.isDirectory,
      s.isVirtual,
      s.size,
      s.modified
    );
  }

  /** 查询目标目录所在存储的可用容量；未知时返回 null。 */
  @Override
  public Long availableBytes(NewFilePublisher.Directory reference, ArchiveControl control)
    throws Exception {
    DirectoryStore.PublicationDirectory directory = checked(reference, control);
    Signal signal = control.track(new Signal());
    Long available;
    try {
      available = store
        .access(directory.tree)
        .availableBytes(directory.tree, directory.documentId, signal.value);
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
    DirectoryStore.PublicationDirectory directory = checked(reference, control);
    Signal signal = control.track(new Signal());
    List<PublicationModel.Document> result = new ArrayList<>();
    try {
      for (DirectoryStore.Snapshot s : store
        .access(directory.tree)
        .children(directory.tree, directory.documentId, signal.value)) {
        control.check();
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
        result.add(publicationDocument(s));
      }
      return result;
    } finally {
      control.untrack(signal);
    }
  }

  @Override
  public String create(NewFilePublisher.Directory reference, String name) throws Exception {
    DirectoryStore.PublicationDirectory directory = checked(reference, new ArchiveControl());
    return store
      .access(directory.tree)
      .create(directory.tree, directory.documentId, "application/octet-stream", name);
  }

  @Override
  public PublicationModel.Document document(
    NewFilePublisher.Directory reference,
    String id,
    ArchiveControl control
  ) throws Exception {
    DirectoryStore.PublicationDirectory directory = (DirectoryStore.PublicationDirectory) reference;
    Signal signal = control.track(new Signal());
    try {
      return publicationDocument(
        store.access(directory.tree).query(directory.tree, id, signal.value)
      );
    } catch (FileNotFoundException missing) {
      return null;
    } finally {
      control.untrack(signal);
    }
  }

  @Override
  public NewFilePublisher.Owned claim(
    NewFilePublisher.Directory reference,
    PublicationModel.Document document
  ) {
    return new OwnedFile((DirectoryStore.PublicationDirectory) reference, document);
  }

  private final class OwnedFile implements NewFilePublisher.Owned {

    private final DirectoryStore.PublicationDirectory directory;
    private final String id;
    private final String name;
    private final DocumentAccess access;
    private ParcelFileDescriptor identity;
    private StructStat baseline;
    private boolean isDeleted;

    OwnedFile(DirectoryStore.PublicationDirectory directory, PublicationModel.Document document) {
      this.directory = directory;
      id = document.id;
      name = document.name;
      access = store.access(directory.tree);
    }

    private DirectoryStore.Snapshot snapshot(ArchiveControl control) throws Exception {
      Signal signal = control.track(new Signal());
      try {
        DirectoryStore.Snapshot s = access.query(directory.tree, id, signal.value);
        if (!name.equals(s.name)) {
          throw new ArchiveFailure("result-unknown", "The new entry identity or name changed.");
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
        descriptor = access.open(directory.tree, id, mode, signal.value);
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
      DirectoryStore.Snapshot s = snapshot(control);
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
      DirectoryStore.Snapshot s = snapshot(control);
      if (s.isDirectory || s.isVirtual) {
        throw new ArchiveFailure("result-unknown", "The file type changed.");
      }
      try (ParcelFileDescriptor current = descriptor("r", control)) {
        // 打开时已核实身份；现有内容不读取也不改变。
      }
    }

    @Override
    public OutputStream openOutput(long size, ArchiveControl control) throws Exception {
      establish(control);
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
              super.close();
            } catch (java.io.IOException cause) {
              throw mapped(cause);
            } finally {
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
      } catch (FileNotFoundException missing) {
        // 删除回执丢失时，重新查询与完整当前层枚举都确认缺失才完成清理。
        for (PublicationModel.Document d : children(directory, new ArchiveControl())) {
          if (d.id.equals(id)) {
            throw missing;
          }
        }
        isDeleted = true;
        return;
      }
      if (!access.delete(directory.tree, id)) {
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
