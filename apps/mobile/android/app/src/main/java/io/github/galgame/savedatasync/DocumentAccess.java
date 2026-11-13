package io.github.galgame.savedatasync;

import android.net.Uri;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import java.io.InputStream;
import java.util.List;

/**
 * 按树 URI 和文档 ID 访问已授权目录树中的文档，必须在 I/O 工作线程调用。
 *
 * <p>各实现返回同样格式的文档 ID 和属性：ID 用系统存储提供者的 {@code 卷 ID:相对路径}，或其他提供者自己的 ID；属性见 {@link
 * DirectoryStore.Snapshot}，能力标志只保证 {@code FLAG_SUPPORTS_WRITE}、{@code FLAG_SUPPORTS_DELETE}、{@code
 * FLAG_DIR_SUPPORTS_CREATE} 和 {@code FLAG_VIRTUAL_DOCUMENT} 一致。所以一种实现取得的 ID 可以交给另一种实现继续使用。
 *
 * <p>各方法收到取消时抛出 {@link android.os.OperationCanceledException}，访问被拒时抛出 {@link SecurityException}。
 */
interface DocumentAccess {
  /**
   * 查询一个文档的属性。
   *
   * @throws java.io.FileNotFoundException 文档不存在。
   */
  DirectoryStore.Snapshot query(Uri tree, String documentId, CancellationSignal signal)
    throws Exception;

  /**
   * 列出目录的直接子项，顺序不固定。
   *
   * @throws java.io.FileNotFoundException 目录不存在。
   */
  List<DirectoryStore.Snapshot> children(Uri tree, String documentId, CancellationSignal signal)
    throws Exception;

  /** 打开文件的读流，由调用者关闭；读取期间不检查取消。 */
  InputStream read(Uri tree, String documentId, CancellationSignal signal) throws Exception;

  /**
   * 以 mode 打开文件的描述符，由调用者关闭。
   *
   * @param mode {@code "r"} 或 {@code "rw"}；{@code "rw"} 不截断已有内容。
   */
  ParcelFileDescriptor open(Uri tree, String documentId, String mode, CancellationSignal signal)
    throws Exception;

  /**
   * 在目录下新建一个空文件或空文件夹，返回新文档的 ID。
   *
   * <p>同名条目已存在时，系统存储提供者经 SAF 会换个名字创建，直接读写会抛出 {@link
   * java.nio.file.FileAlreadyExistsException}；调用者要按返回的 ID 核实名称。
   *
   * @param mimeType {@link android.provider.DocumentsContract.Document#MIME_TYPE_DIR} 表示文件夹。
   * @throws ArchiveFailure 提供者返回了不属于这棵树的引用（result-unknown）。
   */
  String create(Uri tree, String parentDocumentId, String mimeType, String name) throws Exception;

  /**
   * 删除一个文档。文件夹经 SAF 会连同内容一起删除，直接读写只能删除空文件夹，调用者要先确认文件夹为空。
   *
   * @return 实现报告已删除时为 true。
   */
  boolean delete(Uri tree, String documentId) throws Exception;

  /** 返回文档所在存储的可用字节；报告不了时返回 null。 */
  Long availableBytes(Uri tree, String documentId, CancellationSignal signal) throws Exception;
}
