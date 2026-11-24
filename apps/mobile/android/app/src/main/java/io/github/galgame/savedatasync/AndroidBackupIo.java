package io.github.galgame.savedatasync;

import android.os.StatFs;
import android.system.Os;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;

/** 查询 Android 备份卷的可用容量和文件的硬链接计数。 */
final class AndroidBackupIo implements BackupFiles.Io {

  @Override
  public Object identity(Path path, BasicFileAttributes ignored) throws Exception {
    android.system.StructStat value = Os.lstat(path.toString());
    return value.st_dev + ":" + value.st_ino;
  }

  @Override
  public Long available(Path path) {
    Long available;
    try {
      available = new StatFs(path.toString()).getAvailableBytes();
    } catch (IllegalArgumentException unknown) {
      available = null;
    }
    return FaultInjection.availableBytes(FaultInjection.BACKUP, available);
  }

  @Override
  public void beforeWrite(Path path, int bytes) throws Exception {
    FaultInjection.beforeWrite(FaultInjection.BACKUP);
  }

  @Override
  public long links(Path path) throws Exception {
    return Os.lstat(path.toString()).st_nlink;
  }
}
