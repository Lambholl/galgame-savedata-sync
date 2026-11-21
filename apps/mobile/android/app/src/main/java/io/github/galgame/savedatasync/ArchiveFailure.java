package io.github.galgame.savedatasync;

import java.io.IOException;

/** 归档错误：稳定的错误码和脱敏消息；清理失败另外记录，不覆盖主错误。 */
final class ArchiveFailure extends IOException {

  final String code;
  final boolean isCancelled;
  final String diagnosticCode;
  ArchiveFailure cleanupFailure;
  /** 出错的目录在哪一端，取值 listener 或 dialer；抛出处不知道时为 null。 */
  String device;

  ArchiveFailure(String code, String message) {
    this(code, message, false, null);
  }

  ArchiveFailure(String code, String message, boolean isCancelled, Throwable cause) {
    this(code, message, isCancelled, cause, null);
  }

  ArchiveFailure(
    String code,
    String message,
    boolean isCancelled,
    Throwable cause,
    String diagnosticCode
  ) {
    super(message, cause);
    this.code = code;
    this.isCancelled = isCancelled;
    this.diagnosticCode = diagnosticCode;
  }

  static ArchiveFailure from(Exception cause) {
    if (cause instanceof ArchiveFailure) {
      return (ArchiveFailure) cause;
    }
    if (cause instanceof DirectoryFailure) {
      return new ArchiveFailure(
        ((DirectoryFailure) cause).code,
        "Cannot read the authorized source file.",
        false,
        cause
      );
    }
    // 文档提供方在文件不可访问时也会抛运行时异常，和程序缺陷分不开，这里统一按读写失败处理。
    return new ArchiveFailure("io-failure", "Local archive I/O failed.", false, cause);
  }
}
