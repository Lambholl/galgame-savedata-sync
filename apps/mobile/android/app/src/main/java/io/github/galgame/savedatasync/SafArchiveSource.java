package io.github.galgame.savedatasync;

import android.content.Context;
import android.os.CancellationSignal;
import java.io.Closeable;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * 将已枚举的 SAF 引用接入纯归档模块；不接受 URI/路径，不申请新授权或目标写权限。
 * 查询和打开必须在后台工作线程调用。控制器取消会同时取消提供者查询和关闭读流；
 * 流关闭后注销信号，所有权由 prepare 的工作线程回收。
 */
final class SafArchiveSource implements ArchiveModel.Source {
    private final SafDirectoryStore store;
    private final String rootId, entryId;
    SafArchiveSource(SafDirectoryStore store, String rootId, String entryId) throws ArchiveFailure {
        ArchiveModel.require(store != null && SafValues.isId(rootId) && SafValues.isId(entryId));
        this.store = store; this.rootId = rootId; this.entryId = entryId;
    }

    /** 应用私有缓存工厂；不使用外部存储或 SAF URI，实际字节始终留在原生层。 */
    static ArchiveAdapter createAdapter(Context context) throws IOException {
        // Android 的 /data/user/0 可能是系统别名；仅在可信 Context 边界先解析真实路径，
        // 缓存管理器仍拒绝真实根以下的链接和归属变化。
        return new ArchiveAdapter(new ArchiveCache(context.getApplicationContext().getCacheDir().getCanonicalFile().toPath()));
    }

    @Override public ArchiveModel.Observation observe(ArchiveControl control) throws Exception {
        CancellationSignal signal = new CancellationSignal();
        Closeable cancellation = control.track((Closeable) signal::cancel);
        try {
            control.check();
            return store.archiveObservation(rootId, entryId, signal);
        } finally { control.untrack(cancellation); }
    }
    @Override public void validateRoot(String batchRootId) throws ArchiveFailure {
        ArchiveModel.require(rootId.equals(batchRootId));
    }
    @Override public InputStream open(ArchiveControl control) throws Exception {
        CancellationSignal signal = new CancellationSignal();
        Closeable cancellation = control.track((Closeable) signal::cancel);
        try {
            InputStream input = store.openFile(rootId, entryId, signal);
            return new FilterInputStream(input) {
                @Override public void close() throws IOException {
                    try { super.close(); } finally { control.untrack(cancellation); }
                }
            };
        } catch (Exception failure) { control.untrack(cancellation); throw failure; }
    }
}
