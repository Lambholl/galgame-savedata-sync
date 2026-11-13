package io.github.galgame.savedatasync;

import android.os.OperationCanceledException;
import com.getcapacitor.JSObject;
import java.io.FileNotFoundException;

/** 目录操作的错误，带稳定的错误码和已脱敏的消息；result 只输出错误码和消息，原始异常留作 cause。 */
final class DirectoryFailure extends Exception {

  final String code;

  DirectoryFailure(String code, String message) {
    super(message);
    this.code = code;
  }

  DirectoryFailure(String code, String message, Throwable cause) {
    super(message, cause);
    this.code = code;
  }

  JSObject result() {
    JSObject error = new JSObject();
    error.put("code", code);
    error.put("message", getMessage());
    error.put("canRetry", !code.equals("invalid-request"));
    JSObject result = new JSObject();
    result.put("status", "error");
    result.put("error", error);
    return result;
  }

  static DirectoryFailure from(Exception cause) {
    if (cause instanceof DirectoryFailure) {
      return (DirectoryFailure) cause;
    }
    if (cause instanceof SecurityException) {
      return new DirectoryFailure(
        "permission-denied",
        "Directory access was denied. Select the directory again.",
        cause
      );
    }
    if (cause instanceof FileNotFoundException) {
      return new DirectoryFailure(
        "not-found",
        "The directory or file is no longer available. Read it again.",
        cause
      );
    }
    if (cause instanceof OperationCanceledException || cause instanceof InterruptedException) {
      return new DirectoryFailure(
        "io-failure",
        "Reading stopped because of the app lifecycle or cancellation.",
        cause
      );
    }
    return new DirectoryFailure(
      "io-failure",
      "Cannot read the directory provider or local configuration.",
      cause
    );
  }
}
