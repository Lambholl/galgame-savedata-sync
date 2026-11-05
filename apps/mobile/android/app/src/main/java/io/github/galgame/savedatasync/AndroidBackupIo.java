package io.github.galgame.savedatasync;

import android.os.StatFs;
import android.system.Os;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;

/** 查询 Android 备份卷的容量和真实硬链接计数；只由原生工厂创建。 */
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
