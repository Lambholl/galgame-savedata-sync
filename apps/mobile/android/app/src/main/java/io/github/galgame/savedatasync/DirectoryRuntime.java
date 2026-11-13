package io.github.galgame.savedatasync;

import android.content.Context;
import android.os.Environment;
import java.io.File;
import java.nio.file.Path;

/** 进程内共享的目录登记表和扫描、备份、恢复实例，只持有应用 Context。 */
final class DirectoryRuntime {

  private static DirectoryStore store;
  private static SyncScanner scanner;
  private static BackupStore backups;
  private static SyncWriteRuntime writes;

  private DirectoryRuntime() {}

  static synchronized DirectoryStore store(Context context) throws DirectoryFailure {
    if (store == null) {
      store = new DirectoryStore(context.getApplicationContext());
    }
    return store;
  }

  /** 返回进程内共享的扫描器，扫描结果保存在其中。 */
  static synchronized SyncScanner scanner(Context context) throws DirectoryFailure {
    if (scanner == null) {
      scanner = new SyncScanner(new DirectorySyncSource(store(context)));
    }
    return scanner;
  }

  /** 返回进程内共享的备份存储：备份放在应用专属外部目录，设置放在内部目录。 */
  static synchronized BackupStore backups(Context context) throws Exception {
    if (backups == null) {
      Context application = context.getApplicationContext();
      backups = new BackupStore(
        application.getFilesDir().getCanonicalFile().toPath(),
        new BackupStore.Location() {
          @Override
          public Path directory() throws Exception {
            // 每次重新取得目录：用户删掉目录后，系统在这次调用时重建。
            File directory = application.getExternalFilesDir(null);
            if (
              directory == null ||
              !Environment.MEDIA_MOUNTED.equals(Environment.getExternalStorageState(directory))
            ) {
              throw BackupFiles.failure("io-failure");
            }
            return directory.getCanonicalFile().toPath();
          }

          @Override
          public String gameName(String projectId) {
            return AppStoragePlugin.gameName(application, projectId);
          }
        },
        new DirectorySyncSource(store(context)),
        new AndroidBackupIo()
      );
    }
    return backups;
  }

  /** 返回进程内共享的写入运行时，Activity 重建后仍能查询原来的任务。 */
  static synchronized SyncWriteRuntime writes(Context context) throws Exception {
    if (writes == null) {
      writes = new SyncWriteRuntime(
        context.getApplicationContext(),
        store(context),
        backups(context)
      );
    }
    return writes;
  }
}
