package io.github.galgame.savedatasync;

import java.text.Normalizer;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/** 单文件发布的值对象。 */
final class PublicationModel {

  static final int MAX_DIRECTORY_ENTRIES = 32768;

  private PublicationModel() {}

  static final class Request {

    final String fileId;
    final String rootId;
    final String parentId;
    final String name;
    /** 要核对的内容哈希；为 null 时只核对字节数。 */
    final String sha256;
    final long sizeBytes;
    /** 写完后设置的修改日期（Unix 毫秒）。为 null 时保留写入时的日期。 */
    final Long modifiedAt;

    Request(
      String fileId,
      String rootId,
      String parentId,
      String name,
      long sizeBytes,
      String sha256
    ) {
      this(fileId, rootId, parentId, name, sizeBytes, sha256, null);
    }

    Request(
      String fileId,
      String rootId,
      String parentId,
      String name,
      long sizeBytes,
      String sha256,
      Long modifiedAt
    ) {
      this.fileId = fileId;
      this.rootId = rootId;
      this.parentId = parentId;
      this.name = name;
      this.sizeBytes = sizeBytes;
      this.sha256 = sha256;
      this.modifiedAt = modifiedAt;
    }

    void validate() throws ArchiveFailure {
      if (
        fileId == null ||
        !fileId.matches("f[0-9]{6}") ||
        Integer.parseInt(fileId.substring(1)) < 1 ||
        Integer.parseInt(fileId.substring(1)) > 1024 ||
        !DocumentValues.isId(rootId) ||
        (parentId != null && !DocumentValues.isId(parentId)) ||
        !portableName(name) ||
        sizeBytes < 0 ||
        (sha256 != null && !ArchiveModel.hash(sha256))
      ) {
        throw new ArchiveFailure("invalid-request", "New file publication fields are invalid.");
      }
      if (sizeBytes > 268435456L) {
        throw new ArchiveFailure("resource-limit", "The file exceeds the publication budget.");
      }
    }
  }

  static final class Document {

    final String id;
    final String name;
    final boolean isDirectory;
    final boolean isVirtual;
    final Long size;
    final Long modified;

    Document(
      String id,
      String name,
      boolean isDirectory,
      boolean isVirtual,
      Long size,
      Long modified
    ) {
      this.id = id;
      this.name = name;
      this.isDirectory = isDirectory;
      this.isVirtual = isVirtual;
      this.size = size;
      this.modified = modified;
    }
  }

  /** 发布出的条目，用不透明 ID 引用。 */
  static final class Entry {

    final String rootId;
    final String parentId;
    final String entryId;
    final String name;
    final Long size;
    final Long modified;

    Entry(String rootId, String parentId, String entryId, String name, Long size, Long modified) {
      this.rootId = rootId;
      this.parentId = parentId;
      this.entryId = entryId;
      this.name = name;
      this.size = size;
      this.modified = modified;
    }
  }

  static final class Result {

    final String fileId;
    final String status;
    final String errorCode;
    final String cleanup;
    final String cleanupError;
    final Entry entry;
    final List<Entry> residualEntries;
    final long bytesWritten;
    final String sha256;

    Result(
      Request request,
      String status,
      String errorCode,
      Entry entry,
      Entry residual,
      String cleanup,
      String cleanupError
    ) {
      fileId = request.fileId;
      this.status = status;
      this.errorCode = errorCode;
      this.entry = entry;
      residualEntries =
        residual == null ? Collections.emptyList() : Collections.singletonList(residual);
      this.cleanup = cleanup;
      this.cleanupError = cleanupError;
      bytesWritten = "succeeded".equals(status) ? request.sizeBytes : 0;
      sha256 = "succeeded".equals(status) ? request.sha256 : null;
    }
  }

  static boolean portableName(String value) {
    if (
      !ArchiveModel.text(value) ||
      value.length() > 255 ||
      value.endsWith(".") ||
      value.endsWith(" ")
    ) {
      return false;
    }
    for (int c : value.codePoints().toArray()) {
      if (c < 32 || c == 127 || "<>:\"/\\|?*".indexOf(c) >= 0) {
        return false;
      }
    }
    return !value
      .toUpperCase(Locale.ROOT)
      .matches("(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\\$|CONOUT\\$)(?:\\..*)?");
  }

  /** 返回名称的比较键：NFC 规范化后转大写，大小写或 Unicode 组合方式不同的名称得到同一个键。 */
  static String nameKey(String value) {
    return Normalizer.normalize(value, Normalizer.Form.NFC).toUpperCase(Locale.ROOT);
  }
}
