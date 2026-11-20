package io.github.galgame.savedatasync;

import java.io.InputStream;
import java.util.Objects;

/** 归档格式 v1 的不可变模型。 */
final class ArchiveModel {

  static final int BUFFER = 65536;

  private ArchiveModel() {}

  /** 归档的字节上限，取值不大于协议的上限。 */
  static final class Limits {

    final int files;
    final long file;
    final long total;
    final long tar;
    final long cache;

    Limits() {
      this(1024, 268435456L, 1073741824L, 1074790400L, 3221225472L);
    }

    Limits(int files, long file, long total, long tar, long cache) {
      if (
        files < 1 ||
        files > 1024 ||
        file < 1 ||
        file > 268435456L ||
        total < 1 ||
        total > 1073741824L ||
        tar < 1 ||
        tar > 1074790400L ||
        cache < 1 ||
        cache > 3221225472L
      ) {
        throw new IllegalArgumentException("Invalid archive limits");
      }
      this.files = files;
      this.file = file;
      this.total = total;
      this.tar = tar;
      this.cache = cache;
    }
  }

  /** 源文件的身份和可观察属性；长度或时间未知时为 null。 */
  static final class Observation {

    final String identity;
    final String entryId;
    final String parentId;
    final String name;
    final Long size;
    final Long modified;

    Observation(
      String identity,
      String entryId,
      String parentId,
      String name,
      Long size,
      Long modified
    ) {
      this.identity = identity;
      this.entryId = entryId;
      this.parentId = parentId;
      this.name = name;
      this.size = size;
      this.modified = modified;
    }

    boolean same(Observation other) {
      return (
        other != null &&
        Objects.equals(identity, other.identity) &&
        Objects.equals(entryId, other.entryId) &&
        Objects.equals(parentId, other.parentId) &&
        Objects.equals(name, other.name) &&
        Objects.equals(size, other.size) &&
        Objects.equals(modified, other.modified)
      );
    }

    void validate() throws ArchiveFailure {
      require(
        identity != null &&
          !identity.isEmpty() &&
          DocumentValues.isId(entryId) &&
          (parentId == null || (DocumentValues.isId(parentId) && !parentId.equals(entryId))) &&
          text(name) &&
          (size == null || (size >= 0 && size <= 9007199254740991L)) &&
          (modified == null || (modified >= -8640000000000000L && modified <= 8640000000000000L))
      );
    }
  }

  /** 只读的源文件。打开的流由调用方关闭；observe 每次都重新检查授权和身份。 */
  interface Source {
    /** 校验源属于 rootId 这个根目录，不属于时抛错；默认实现接受任何根目录。 */
    default void validateRoot(String rootId) throws ArchiveFailure {}

    Observation observe(ArchiveControl control) throws Exception;

    InputStream open(ArchiveControl control) throws Exception;
  }

  /** 阶段内的实际计数；total 未知时为 null。回调在同一 I/O 线程执行，不能阻塞或修改任务。 */
  interface Progress {
    void update(String stage, long completed, Long total) throws Exception;
  }

  static String id(int index) {
    return String.format(java.util.Locale.ROOT, "f%06d", index + 1);
  }

  static long padded(long size) {
    return ((size + 511) / 512) * 512;
  }

  static boolean text(String value) {
    if (
      value == null ||
      value.isEmpty() ||
      value.length() > 1024 ||
      value.codePoints().allMatch(c -> Character.isWhitespace(c) || Character.isSpaceChar(c))
    ) {
      return false;
    }
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      if (Character.isHighSurrogate(c)) {
        if (++i == value.length() || !Character.isLowSurrogate(value.charAt(i))) {
          return false;
        }
      } else if (Character.isLowSurrogate(c)) {
        return false;
      }
    }
    return true;
  }

  static void require(boolean isSatisfied) throws ArchiveFailure {
    if (!isSatisfied) {
      throw new ArchiveFailure(
        "invalid-request",
        "Archive request or manifest fields are invalid."
      );
    }
  }

  static void limit(boolean isSatisfied) throws ArchiveFailure {
    if (!isSatisfied) {
      throw new ArchiveFailure(
        "resource-limit",
        "The archive exceeds the resource budget for this operation."
      );
    }
  }
}
