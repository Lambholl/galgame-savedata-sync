package io.github.galgame.savedatasync;

import android.content.Context;

/** 同一原生进程共享当前引用映射；不持有 Activity，不将 entryId 另存为历史。 */
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
    /** 持久备份位于可信 Context 的私有 files 目录，不使用 SAF 选择备份位置。 */
    static synchronized BackupStore backups(Context context) throws Exception {
        if (backups == null) backups = new BackupStore(context.getApplicationContext().getFilesDir().getCanonicalFile().toPath(),
            new SafSyncSource(store(context)), new AndroidBackupIo());
        return backups;
    }
    /** 本机恢复由应用 Context 持有；Activity 重建后继续查询原任务。 */
    static synchronized SyncWriteRuntime writes(Context context) throws Exception {
        if (writes == null) writes = new SyncWriteRuntime(context.getApplicationContext(), store(context), backups(context));
        return writes;
    }
}
