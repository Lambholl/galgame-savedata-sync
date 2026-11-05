package io.github.galgame.savedatasync;

import android.content.Context;
import android.os.Environment;
import java.io.File;
import java.nio.file.Path;

/** 同一原生进程共享的 SAF 目录引用和扫描、备份、恢复实例；不持有 Activity。 */
final class SafRuntime {
    private static SafDirectoryStore store;
    private static SyncScanner scanner;
    private static BackupStore backups;
    private static SyncWriteRuntime writes;
    private SafRuntime() {}
    static synchronized SafDirectoryStore store(Context context) throws SafFailure {
        if (store == null) store = new SafDirectoryStore(context.getApplicationContext());
        return store;
    }
    /** 同一原生进程共享扫描器及内存中的本次结果。 */
    static synchronized SyncScanner scanner(Context context) throws SafFailure {
        if (scanner == null) scanner = new SyncScanner(new SafSyncSource(store(context)));
        return scanner;
    }
    /** 备份放应用专属外部目录，用户可以直接管理；设置留在内部目录。每次重新取得目录，用户删掉后系统才会重建。 */
    static synchronized BackupStore backups(Context context) throws Exception {
        if (backups == null) {
            Context application = context.getApplicationContext();
            backups = new BackupStore(application.getFilesDir().getCanonicalFile().toPath(), new BackupStore.Location() {
                @Override public Path directory() throws Exception {
                    File directory = application.getExternalFilesDir(null);
                    if (directory == null || !Environment.MEDIA_MOUNTED.equals(Environment.getExternalStorageState(directory))) throw BackupFiles.failure("io-failure");
                    return directory.getCanonicalFile().toPath();
                }
                @Override public String gameName(String projectId) { return AppStoragePlugin.gameName(application, projectId); }
            }, new SafSyncSource(store(context)), new AndroidBackupIo());
        }
        return backups;
    }
    /** 本机恢复由应用 Context 持有；Activity 重建后继续查询原任务。 */
    static synchronized SyncWriteRuntime writes(Context context) throws Exception {
        if (writes == null) writes = new SyncWriteRuntime(context.getApplicationContext(), store(context), backups(context));
        return writes;
    }
}
