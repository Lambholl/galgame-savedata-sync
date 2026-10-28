package io.github.galgame.savedatasync;

import android.content.Context;

/** 同一原生进程共享当前引用映射；不持有 Activity，不将 entryId 另存为历史。 */
final class SafRuntime {
    private static SafDirectoryStore store;
    private static SyncScanner scanner;
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
}
