package io.github.galgame.savedatasync;

import java.io.IOException;

/** 归档错误，只传递稳定的错误码和脱敏消息；清理错误不能覆盖主错误。 */
final class ArchiveFailure extends IOException {

  final String code;
  final boolean isCancelled;
  final String diagnosticCode;
  ArchiveFailure cleanupFailure;
  /** 出错的目录在哪一端（协议取值 phone 表示移动端，pc 表示电脑）；抛出处不知道时为 null。 */
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
    if (cause instanceof SafFailure) {
      return new ArchiveFailure(
        ((SafFailure) cause).code,
        "Cannot read the authorized source file.",
        false,
        cause
      );
    }
    return new ArchiveFailure("io-failure", "Local archive I/O failed.", false, cause);
  }
}
