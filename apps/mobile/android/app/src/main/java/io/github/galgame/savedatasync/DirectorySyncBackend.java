package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferSchema.directory;
import static io.github.galgame.savedatasync.TransferSchema.id;
import static io.github.galgame.savedatasync.TransferSchema.nullable;
import static io.github.galgame.savedatasync.TransferSchema.number;
import static io.github.galgame.savedatasync.TransferSchema.string;

import android.content.Context;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract.Document;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import java.io.Closeable;
import java.io.OutputStream;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** 复制和恢复写入用的目录后端：以 rw 原地覆盖，写入前后比较常规文件描述符的身份。 */
final class DirectorySyncBackend implements SyncWriter.Backend {

  interface Authorization {
    void check(String projectId, String rootId) throws Exception;
  }

  private final DirectoryStore store;
  private final DirectorySyncSource source;
  private final DirectoryPublicationBackend publication;
  private final NewFilePublisher publisher;
  private final Authorization authorization;
  private final InterruptedWrites interrupted;

  DirectorySyncBackend(Context context, DirectoryStore store, Authorization authorization) {
    this.store = store;
    this.authorization = authorization;
    interrupted = new InterruptedWrites(context);
    source = new DirectorySyncSource(store);
    publication = new DirectoryPublicationBackend(context, store);
    publisher = new NewFilePublisher(publication);
  }

  @Override
  public SyncScanner.Source source() {
    return source;
  }

  @Override
  public NewFilePublisher publisher() {
    return publisher;
  }

  @Override
  public void writeStarted(SyncPlanModel.Plan plan, Object backupId) throws Exception {
    interrupted.begin(plan.id, plan.project, plan.target.root, backupId);
  }

  @Override
  public void writeEnded(SyncPlanModel.Plan plan) {
    interrupted.end(plan.id);
  }

  @Override
  public Boolean sharesPrivateVolume(Path left, Path right) throws Exception {
    StructStat first = Os.lstat(left.toString());
    StructStat second = Os.lstat(right.toString());
    if (!OsConstants.S_ISDIR(first.st_mode) || !OsConstants.S_ISDIR(second.st_mode)) {
      throw new ArchiveFailure("source-changed", "The private storage directory type changed.");
    }
    return first.st_dev == second.st_dev;
  }

  @Override
  public void authorizeProject(String projectId, String rootId, ArchiveControl control)
    throws Exception {
    control.check();
    authorization.check(projectId, rootId);
    locate(rootId, null, false, control);
  }

  private static final class Signal implements Closeable {

    final CancellationSignal value = new CancellationSignal();

    @Override
    public void close() {
      value.cancel();
    }
  }

  private DirectoryStore.PublicationDirectory locate(
    String rootId,
    String parentId,
    boolean shouldCreate,
    ArchiveControl control
  ) throws Exception {
    Signal signal = control.track(new Signal());
    try {
      return store.publicationDirectory(rootId, parentId, signal.value, shouldCreate);
    } finally {
      control.untrack(signal);
    }
  }

  private void checked(DirectoryStore.PublicationDirectory directory, ArchiveControl control)
    throws Exception {
    DirectoryStore.PublicationDirectory current = locate(
      directory.rootId,
      directory.parentId,
      false,
      control
    );
    if (
      !current.tree.equals(directory.tree) ||
      !current.documentId.equals(directory.documentId) ||
      !current.name.equals(directory.name)
    ) {
      throw new ArchiveFailure("source-changed", "The target parent directory reference changed.");
    }
  }

  private List<DirectoryStore.Snapshot> children(
    DirectoryStore.PublicationDirectory directory,
    ArchiveControl control
  ) throws Exception {
    checked(directory, control);
    Signal signal = control.track(new Signal());
    List<DirectoryStore.Snapshot> result = new ArrayList<>();
    Set<String> ids = new HashSet<>();
    try {
      for (DirectoryStore.Snapshot value : store
        .access(directory.tree)
        .children(directory.tree, directory.documentId, signal.value)) {
        control.check();
        if (result.size() >= 32768) {
          throw new ArchiveFailure("resource-limit", "Target directory entries exceed the limit.");
        }
        if (value.documentId.equals(directory.documentId) || !ids.add(value.documentId)) {
          throw new ArchiveFailure(
            "result-unknown",
            "The provider returned duplicate or invalid document identities."
          );
        }
        result.add(value);
      }
    } finally {
      control.untrack(signal);
    }
    return result;
  }

  /**
   * 在子项里核对与 name 等价的条目只有 name 本身且文档 ID 是 expectedId，返回这个条目。
   *
   * <p>expectedId 为 null 时要求没有等价的条目，返回 null。核对不通过时抛出 source-changed。
   */
  private static DirectoryStore.Snapshot named(
    List<DirectoryStore.Snapshot> children,
    String name,
    String expectedId
  ) throws Exception {
    DirectoryStore.Snapshot selected = null;
    for (DirectoryStore.Snapshot child : children) {
      if (
        BackupModel.key(java.util.Collections.singletonList(child.name)).equals(
          BackupModel.key(java.util.Collections.singletonList(name))
        )
      ) {
        if (
          selected != null ||
          !child.name.equals(name) ||
          expectedId == null ||
          !child.documentId.equals(expectedId)
        ) {
          throw new ArchiveFailure(
            "source-changed",
            "The target name, document identity, or equivalent name changed."
          );
        }
        selected = child;
      }
    }
    if (expectedId != null && selected == null) {
      throw new ArchiveFailure(
        "source-changed",
        "The target file is no longer in the confirmed parent directory."
      );
    }
    return selected;
  }

  /** 返回 expected 引用的条目的文档 ID；条目不是在 directory 下枚举到的时抛出 source-changed。 */
  private String documentId(
    DirectoryStore.PublicationDirectory directory,
    Map<String, Object> expected
  ) throws Exception {
    return store.documentId(directory.rootId, directory.parentId, string(expected.get("entryId")));
  }

  /**
   * 查询 directory 里一个文档当前的属性。
   *
   * @throws ArchiveFailure 文档已不存在或名称不再是 name（source-changed）。
   */
  private DirectoryStore.Snapshot observe(
    DirectoryStore.PublicationDirectory directory,
    String documentId,
    String name,
    ArchiveControl control
  ) throws Exception {
    // 只查这一个文档，不列父目录：父目录有几百个文件时，每个文件列一次会让耗时随文件数平方增长。
    // 写入期间同一目录新出现的等价名称留给下次比较发现。
    Signal signal = control.track(new Signal());
    DirectoryStore.Snapshot value;
    try {
      value = store.access(directory.tree).query(directory.tree, documentId, signal.value);
    } catch (java.io.FileNotFoundException missing) {
      throw new ArchiveFailure(
        "source-changed",
        "The target entry no longer exists.",
        false,
        missing
      );
    } finally {
      control.untrack(signal);
    }
    control.check();
    if (!value.name.equals(name)) {
      throw new ArchiveFailure("source-changed", "The target name changed.");
    }
    return value;
  }

  @Override
  public Long available(String rootId, String parentId, ArchiveControl control) throws Exception {
    // 复用根查询，未知容量保持 null；它的创建能力检查只用于此可选查询。
    try {
      return publication.availableBytes(locate(rootId, parentId, false, control), control);
    } catch (DirectoryFailure failure) {
      if (failure.code.equals("unsupported-operation")) {
        return null;
      }
      throw failure;
    }
  }

  @Override
  public String createDirectory(String rootId, String parentId, String name, ArchiveControl control)
    throws Exception {
    DirectoryStore.PublicationDirectory directory = locate(rootId, parentId, true, control);
    List<DirectoryStore.Snapshot> before = children(directory, control);
    Set<String> ids = new HashSet<>();
    for (DirectoryStore.Snapshot child : before) {
      ids.add(child.documentId);
      if (
        BackupModel.key(java.util.Collections.singletonList(child.name)).equals(
          BackupModel.key(java.util.Collections.singletonList(name))
        )
      ) {
        throw new ArchiveFailure(
          "source-changed",
          "The name of the directory to be created already exists."
        );
      }
    }
    control.check();
    boolean wasAttempted = false;
    try {
      wasAttempted = true;
      String id = store
        .access(directory.tree)
        .create(directory.tree, directory.documentId, Document.MIME_TYPE_DIR, name);
      if (ids.contains(id)) {
        throw new ArchiveFailure(
          "result-unknown",
          "Directory creation returned an existing document."
        );
      }
      DirectoryStore.Snapshot value = named(children(directory, new ArchiveControl()), name, id);
      if (value == null || !value.isDirectory || value.isVirtual) {
        throw new ArchiveFailure(
          "result-unknown",
          "The new directory name or type cannot be verified."
        );
      }
      return store.publicationEntry(directory, value).entryId;
    } catch (Exception cause) {
      if (wasAttempted) {
        throw new ArchiveFailure(
          "result-unknown",
          "Directory creation started. Read the target again to confirm the result.",
          false,
          cause
        );
      }
      throw cause;
    }
  }

  @Override
  public void delete(
    String rootId,
    String parentId,
    Map<String, Object> expected,
    ArchiveControl control
  ) throws Exception {
    DirectoryStore.PublicationDirectory directory = store.registeredDirectory(rootId, parentId);
    List<String> path = BackupModel.path(expected.get("path"));
    String name = path.get(path.size() - 1);
    final boolean isDirectory = expected.get("kind").equals("directory");
    DirectoryStore.Snapshot value = observe(
      directory,
      documentId(directory, expected),
      name,
      control
    );
    // 文件夹里的子项刚被删过，它的修改时间已经变了，只核对身份和类型。
    if (
      value.isDirectory != isDirectory ||
      value.isVirtual ||
      (!isDirectory &&
        (!Objects.equals(
          value.modified,
          nullable(expected.get("modifiedAt"), -BackupModel.MAX_DATE, BackupModel.MAX_DATE)
        ) ||
          (value.size != null &&
            value.size.longValue() != number(expected.get("sizeBytes"), 0, 9007199254740991L))))
    ) {
      throw new ArchiveFailure(
        "source-changed",
        "The target identity, type, or attributes changed."
      );
    }
    if ((value.flags & Document.FLAG_SUPPORTS_DELETE) == 0) {
      throw new ArchiveFailure(
        "unsupported-operation",
        "The provider does not allow deleting this entry."
      );
    }
    // SAF 的 deleteDocument 会递归删除文件夹，这里先确认文件夹是空的，只删计划列出的条目。
    if (
      isDirectory &&
      !children(locate(rootId, string(expected.get("entryId")), false, control), control).isEmpty()
    ) {
      throw new ArchiveFailure("source-changed", "The directory to delete is no longer empty.");
    }
    control.check();
    try {
      if (!store.access(directory.tree).delete(directory.tree, value.documentId)) {
        throw new java.io.IOException("The provider did not delete the document");
      }
    } catch (Exception cause) {
      if (Boolean.TRUE.equals(stillExists(directory, name, value.documentId))) {
        throw new ArchiveFailure(
          "io-failure",
          "The provider refused to delete this entry.",
          false,
          cause
        );
      }
      throw new ArchiveFailure(
        "result-unknown",
        "Deletion started but the result could not be verified. Read the target again.",
        false,
        cause
      );
    }
    if (!Boolean.FALSE.equals(stillExists(directory, name, value.documentId))) {
      throw new ArchiveFailure(
        "result-unknown",
        "Deletion finished but the entry could not be confirmed gone. Read the target again."
      );
    }
  }

  /** 用独立的取消信号回读名为 name 的文档是否还在，晚到的取消不影响结果；读不到时返回 null。 */
  private Boolean stillExists(
    DirectoryStore.PublicationDirectory directory,
    String name,
    String documentId
  ) {
    try {
      return store
        .access(directory.tree)
        .query(directory.tree, documentId, new CancellationSignal())
        .name.equals(name);
    } catch (java.io.FileNotFoundException gone) {
      return false;
    } catch (Exception unreadable) {
      return null;
    }
  }

  @Override
  public SyncWriter.Replacement replacement(
    String rootId,
    String parentId,
    Map<String, Object> expected,
    ArchiveControl control
  ) throws Exception {
    return existing(rootId, parentId, expected, control, true);
  }

  @Override
  public SyncWriter.Replacement volumeFile(
    String rootId,
    String parentId,
    Map<String, Object> expected,
    ArchiveControl control
  ) throws Exception {
    try {
      return existing(rootId, parentId, expected, control, false);
    } catch (ArchiveFailure failure) {
      if (failure.code.equals("unsupported-operation")) {
        return null;
      }
      throw failure;
    }
  }

  private SyncWriter.Replacement existing(
    String rootId,
    String parentId,
    Map<String, Object> expected,
    ArchiveControl control,
    boolean requireWrite
  ) throws Exception {
    // 用扫描时登记的父目录引用，不向提供者重新查询父目录；按路径的文档 ID 在父目录被改名或移走后打开会失败。
    DirectoryStore.PublicationDirectory directory = store.registeredDirectory(rootId, parentId);
    List<String> path = BackupModel.path(expected.get("path"));
    String name = path.get(path.size() - 1);
    String id = documentId(directory, expected);
    Existing result;
    try {
      result = new Existing(directory, id, requireWrite ? "rw" : "r", control);
    } catch (java.io.FileNotFoundException missing) {
      throw new ArchiveFailure(
        "source-changed",
        "The target entry no longer exists.",
        false,
        missing
      );
    }
    try {
      DirectoryStore.Snapshot value = result.access.describe(id, result.baseline);
      if (value == null) {
        // 经 SAF 打开时 fstat 给不出提供者报告的名称和修改时间，要另外查询这个文档。
        value = observe(directory, id, name, control);
      }
      if (
        !value.name.equals(name) ||
        value.isDirectory ||
        value.isVirtual ||
        (requireWrite && (value.flags & Document.FLAG_SUPPORTS_WRITE) == 0) ||
        !Objects.equals(
          value.modified,
          nullable(expected.get("modifiedAt"), -BackupModel.MAX_DATE, BackupModel.MAX_DATE)
        ) ||
        (value.size != null &&
          value.size.longValue() != number(expected.get("sizeBytes"), 0, 9007199254740991L))
      ) {
        throw new ArchiveFailure(
          "source-changed",
          "The target identity, type, write permission, or attributes changed."
        );
      }
      return result;
    } catch (Exception cause) {
      result.close();
      throw cause;
    }
  }

  private final class Existing implements SyncWriter.Replacement {

    final DirectoryStore.PublicationDirectory directory;
    final String id;
    final DocumentAccess access;
    final ParcelFileDescriptor identity;
    final StructStat baseline;
    ParcelFileDescriptor writable;

    /**
     * 以 mode 打开文档 id 作为身份句柄；只有以 rw 打开时才能调用 {@link #output}。
     *
     * @throws ArchiveFailure 打开的不是独立的常规文件（unsupported-operation）。
     */
    Existing(
      DirectoryStore.PublicationDirectory directory,
      String id,
      String mode,
      ArchiveControl control
    ) throws Exception {
      this.directory = directory;
      this.id = id;
      access = store.access(directory.tree);
      Signal signal = control.track(new Signal());
      ParcelFileDescriptor fd = null;
      try {
        fd = access.open(directory.tree, id, mode, signal.value);
        baseline = Os.fstat(fd.getFileDescriptor());
        if (!OsConstants.S_ISREG(baseline.st_mode) || baseline.st_nlink != 1) {
          throw new ArchiveFailure(
            "unsupported-operation",
            "The provider did not return an independent regular file."
          );
        }
        control.check();
        identity = fd;
      } catch (Exception cause) {
        if (fd != null) {
          fd.close();
        }
        throw cause;
      } finally {
        control.untrack(signal);
      }
    }

    @Override
    public OutputStream output(ArchiveControl control) throws Exception {
      // 直接写 replacement 时以 rw 打开的 identity，不再查询提供者或重新打开：经 SAF 每次要 10～20 毫秒。
      // 这段时间里同一路径的文件被换掉时，内容写进旧文件，靠 fstat 只能发现旧文件本身被改过。
      control.check();
      StructStat stat = Os.fstat(identity.getFileDescriptor());
      if (
        stat.st_size != baseline.st_size ||
        stat.st_mtime != baseline.st_mtime ||
        stat.st_ctime != baseline.st_ctime
      ) {
        throw new ArchiveFailure("source-changed", "The target changed before writing.");
      }
      Os.lseek(identity.getFileDescriptor(), 0, OsConstants.SEEK_SET);
      writable = identity;
      return new ParcelFileDescriptor.AutoCloseOutputStream(identity);
    }

    @Override
    public void finish(long size, ArchiveControl control) throws Exception {
      control.check();
      if (writable == null) {
        throw new ArchiveFailure("io-failure", "The target write handle is closed.");
      }
      Os.ftruncate(writable.getFileDescriptor(), size);
    }

    @Override
    public void setModified(long modifiedAt, ArchiveControl control) throws Exception {
      control.check();
      access.setModified(directory.tree, id, modifiedAt);
    }

    @Override
    public Boolean sharesVolume(Path privateDirectory) throws Exception {
      return baseline.st_dev == Os.stat(privateDirectory.toString()).st_dev;
    }

    @Override
    public void close() throws java.io.IOException {
      if (writable != null) {
        writable.close();
        writable = null;
      }
      identity.close();
    }
  }
}
