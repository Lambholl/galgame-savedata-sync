package io.github.galgame.savedatasync;

import android.content.Context;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.os.StatFs;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.FileAlreadyExistsException;
import java.util.ArrayList;
import java.util.List;

/**
 * 有所有文件访问权限时，按实际路径读写系统存储提供者的目录树。
 *
 * <p>文档 ID 和属性与系统存储提供者经 SAF 返回的相同，见 {@link DocumentAccess}；能力标志只给出写入、删除、改名、移动和新建子项。
 */
final class FileDocumentAccess implements DocumentAccess {

  private static final int FILE_FLAGS =
    Document.FLAG_SUPPORTS_WRITE |
    Document.FLAG_SUPPORTS_DELETE |
    Document.FLAG_SUPPORTS_RENAME |
    Document.FLAG_SUPPORTS_MOVE;
  private static final int DIRECTORY_FLAGS =
    Document.FLAG_DIR_SUPPORTS_CREATE |
    Document.FLAG_SUPPORTS_DELETE |
    Document.FLAG_SUPPORTS_RENAME |
    Document.FLAG_SUPPORTS_MOVE;
  private final Context context;

  FileDocumentAccess(Context context) {
    this.context = context.getApplicationContext();
  }

  /** 判断应用是否有所有文件访问权限。 */
  static boolean isGranted() {
    return Environment.isExternalStorageManager();
  }

  /**
   * 判断这棵树现在能否按路径读写：要有所有文件访问权限，树属于系统存储提供者，卷能换算出实际位置，且树不是卷的根。
   *
   * <p>卷的根经 SAF 显示的是卷的名称而不是目录名，按路径给不出相同的名称，所以留给 SAF。不检查目录是否存在或可读。
   */
  boolean supports(Uri tree) {
    if (!isGranted() || !DirectoryDisplay.EXTERNAL_STORAGE.equals(tree.getAuthority())) {
      return false;
    }
    String treeId = DocumentsContract.getTreeDocumentId(tree);
    return (
      !treeId.endsWith(":") &&
      DirectoryDisplay.location(context, tree.getAuthority(), treeId) != null
    );
  }

  /** 换算树内文档的实际位置；文档不在这棵树内或 ID 含有 . 和 .. 段时抛出 FileNotFoundException。 */
  private File file(Uri tree, String documentId) throws FileNotFoundException {
    String treeId = DocumentsContract.getTreeDocumentId(tree);
    boolean isInside =
      documentId.equals(treeId) ||
      documentId.startsWith(treeId.endsWith(":") ? treeId : treeId + "/");
    String[] parts = documentId.split(":", 2);
    if (!isInside || parts.length != 2) {
      throw new FileNotFoundException("Document outside the tree");
    }
    if (!parts[1].isEmpty()) {
      for (String segment : parts[1].split("/", -1)) {
        if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) {
          throw new FileNotFoundException("Invalid document path");
        }
      }
    }
    File location = DirectoryDisplay.location(context, tree.getAuthority(), documentId);
    if (location == null) {
      throw new FileNotFoundException("Storage volume unavailable");
    }
    return location;
  }

  private static String child(String parentId, String name) {
    return parentId.endsWith(":") ? parentId + name : parentId + "/" + name;
  }

  private static void requireName(String name) {
    if (name.isEmpty() || name.equals(".") || name.equals("..") || name.indexOf('/') >= 0) {
      throw new IllegalArgumentException("Invalid entry name");
    }
  }

  /** 把 stat 的失败换成与 SAF 相同的异常：不存在为 FileNotFoundException，被拒为 SecurityException。 */
  private static IOException mapped(ErrnoException cause, String message) {
    if (cause.errno == OsConstants.ENOENT || cause.errno == OsConstants.ENOTDIR) {
      FileNotFoundException missing = new FileNotFoundException(message);
      missing.initCause(cause);
      return missing;
    }
    if (cause.errno == OsConstants.EACCES || cause.errno == OsConstants.EPERM) {
      throw new SecurityException(message, cause);
    }
    return new IOException(message, cause);
  }

  private static DirectoryStore.Snapshot snapshot(String documentId, File file) throws IOException {
    StructStat stat;
    try {
      stat = Os.stat(file.getPath());
    } catch (ErrnoException cause) {
      throw mapped(cause, "Cannot read file attributes");
    }
    boolean isDirectory = OsConstants.S_ISDIR(stat.st_mode);
    boolean canWrite;
    try {
      canWrite = Os.access(file.getPath(), OsConstants.W_OK);
    } catch (ErrnoException denied) {
      canWrite = false;
    }
    // 系统存储提供者经 SAF 报告 File.lastModified()，只精确到秒；这里同样截到秒，两种实现的修改时间才相同。
    long modified = stat.st_mtime * 1000;
    return new DirectoryStore.Snapshot(
      documentId,
      DocumentValues.text(file.getName()),
      isDirectory,
      true,
      false,
      isDirectory ? null : DocumentValues.size(stat.st_size),
      DocumentValues.modified(modified),
      canWrite ? (isDirectory ? DIRECTORY_FLAGS : FILE_FLAGS) : 0
    );
  }

  @Override
  public DirectoryStore.Snapshot query(Uri tree, String documentId, CancellationSignal signal)
    throws Exception {
    signal.throwIfCanceled();
    return snapshot(documentId, file(tree, documentId));
  }

  @Override
  public List<DirectoryStore.Snapshot> children(
    Uri tree,
    String documentId,
    CancellationSignal signal
  ) throws Exception {
    File directory = file(tree, documentId);
    String[] names = directory.list();
    if (names == null) {
      // list() 失败时不给原因，用 stat 区分目录不存在、不是目录和读不了。
      DirectoryStore.Snapshot current = snapshot(documentId, directory);
      if (!current.isDirectory) {
        throw new FileNotFoundException("Not a directory");
      }
      throw new IOException("Cannot list the directory");
    }
    List<DirectoryStore.Snapshot> result = new ArrayList<>(names.length);
    for (String name : names) {
      signal.throwIfCanceled();
      result.add(snapshot(child(documentId, name), new File(directory, name)));
    }
    return result;
  }

  @Override
  public InputStream read(Uri tree, String documentId, CancellationSignal signal) throws Exception {
    signal.throwIfCanceled();
    return new FileInputStream(file(tree, documentId));
  }

  @Override
  public ParcelFileDescriptor open(
    Uri tree,
    String documentId,
    String mode,
    CancellationSignal signal
  ) throws Exception {
    // 不用 ParcelFileDescriptor.parseMode：它把 rw 解析成带 MODE_CREATE，文件不在时会新建。
    int flags;
    if ("r".equals(mode)) {
      flags = ParcelFileDescriptor.MODE_READ_ONLY;
    } else if ("rw".equals(mode)) {
      flags = ParcelFileDescriptor.MODE_READ_WRITE;
    } else {
      throw new IllegalArgumentException("Unsupported open mode");
    }
    signal.throwIfCanceled();
    return ParcelFileDescriptor.open(file(tree, documentId), flags);
  }

  @Override
  public String create(Uri tree, String parentDocumentId, String mimeType, String name)
    throws Exception {
    requireName(name);
    File target = new File(file(tree, parentDocumentId), name);
    boolean wasCreated = Document.MIME_TYPE_DIR.equals(mimeType)
      ? target.mkdir()
      : target.createNewFile();
    if (!wasCreated) {
      if (target.exists()) {
        throw new FileAlreadyExistsException(name);
      }
      throw new IOException("Cannot create the entry");
    }
    return child(parentDocumentId, name);
  }

  @Override
  public boolean delete(Uri tree, String documentId) throws Exception {
    return file(tree, documentId).delete();
  }

  @Override
  public Long availableBytes(Uri tree, String documentId, CancellationSignal signal)
    throws Exception {
    signal.throwIfCanceled();
    try {
      return new StatFs(file(tree, documentId).getPath()).getAvailableBytes();
    } catch (IllegalArgumentException unknown) {
      // StatFs 查询失败时抛 IllegalArgumentException，容量按未知处理。
      return null;
    }
  }
}
