package io.github.galgame.savedatasync;

import android.os.OperationCanceledException;
import com.getcapacitor.JSObject;
import java.io.FileNotFoundException;

/** Stable, sanitized bridge error; native causes are retained but never sent to JavaScript. */
final class SafFailure extends Exception {
    final String code;

    SafFailure(String code, String message) {
        super(message);
        this.code = code;
    }

    SafFailure(String code, String message, Throwable cause) {
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

    static SafFailure from(Exception cause) {
        if (cause instanceof SafFailure) return (SafFailure) cause;
        if (cause instanceof SecurityException) {
            return new SafFailure("permission-denied", "目录访问被拒绝，请重新选择目录", cause);
        }
        if (cause instanceof FileNotFoundException) {
            return new SafFailure("not-found", "目录或文件已不可用，请重新读取", cause);
        }
        if (cause instanceof OperationCanceledException || cause instanceof InterruptedException) {
            return new SafFailure("io-failure", "读取已因应用生命周期或取消而停止", cause);
        }
        return new SafFailure("io-failure", "无法读取目录提供者或本地配置", cause);
    }
}
