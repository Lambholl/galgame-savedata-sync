package io.github.galgame.savedatasync;

import java.io.IOException;

/** 原生归档错误；只传递稳定码和脱敏消息，清理错误不能覆盖主错误。 */
final class ArchiveFailure extends IOException {
    final String code;
    final boolean cancelled;
    ArchiveFailure cleanupFailure;

    ArchiveFailure(String code, String message) { this(code, message, false, null); }
    ArchiveFailure(String code, String message, boolean cancelled, Throwable cause) {
        super(message, cause);
        this.code = code;
        this.cancelled = cancelled;
    }

    static ArchiveFailure from(Exception cause) {
        if (cause instanceof ArchiveFailure) return (ArchiveFailure) cause;
        if (cause instanceof SafFailure) {
            return new ArchiveFailure(((SafFailure) cause).code, "无法读取已授权的源文件", false, cause);
        }
        return new ArchiveFailure("io-failure", "归档本地读写失败", false, cause);
    }
}
