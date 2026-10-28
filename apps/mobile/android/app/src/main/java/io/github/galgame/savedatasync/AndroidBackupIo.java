package io.github.galgame.savedatasync;

import android.os.StatFs;
import android.system.Os;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;

/** Android 私有卷容量及真实硬链接计数；仅由原生工厂提供。 */
final class AndroidBackupIo implements BackupFiles.Io {
    @Override public Object identity(Path path, BasicFileAttributes ignored) throws Exception {
        android.system.StructStat value = Os.lstat(path.toString());
        return value.st_dev + ":" + value.st_ino;
    }
    @Override public Long available(Path path) {
        try { return new StatFs(path.toString()).getAvailableBytes(); }
        catch (IllegalArgumentException unknown) { return null; }
    }
    @Override public long links(Path path) throws Exception { return Os.lstat(path.toString()).st_nlink; }
}
