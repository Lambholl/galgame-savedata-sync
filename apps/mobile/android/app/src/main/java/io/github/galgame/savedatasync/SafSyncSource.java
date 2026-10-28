package io.github.galgame.savedatasync;

import android.os.CancellationSignal;
import java.io.Closeable;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import static io.github.galgame.savedatasync.TransferJson.*;

/** SAF 枚举与原生读流适配；提供者 URI 和文件内容不进入扫描公开模型。 */
final class SafSyncSource implements SyncScanner.Source {
    private final SafDirectoryStore store;
    SafSyncSource(SafDirectoryStore store) { this.store = store; }
    @Override public String deviceId() { return store.deviceId(); }
    @Override public List<Object> list(String rootId, String parentId, ArchiveControl control) throws Exception {
        CancellationSignal signal = new CancellationSignal();
        Closeable cancellation = control.track((Closeable) signal::cancel);
        try {
            control.check();
            Map<String, Object> listing = TransferSchema.directory(
                parse(store.listDirectory(rootId, parentId, signal).toString().getBytes(StandardCharsets.UTF_8)), rootId, parentId);
            return TransferJson.list(listing.get("entries"));
        } catch (SafFailure failure) {
            throw new ArchiveFailure(failure.code, "无法读取已授权目录", false, failure);
        } finally { control.untrack(cancellation); }
    }
    @Override public ArchiveModel.Source file(String rootId, String entryId) throws Exception {
        ArchiveModel.Source delegate = new SafArchiveSource(store, rootId, entryId);
        return new ArchiveModel.Source() {
            @Override public void validateRoot(String root) throws ArchiveFailure { delegate.validateRoot(root); }
            @Override public ArchiveModel.Observation observe(ArchiveControl control) throws Exception {
                try { return delegate.observe(control); }
                catch (SafFailure failure) { throw new ArchiveFailure(failure.code, "无法读取已授权文件属性", false, failure); }
            }
            @Override public java.io.InputStream open(ArchiveControl control) throws Exception {
                try { return delegate.open(control); }
                catch (SafFailure failure) { throw new ArchiveFailure(failure.code, "无法打开已授权文件", false, failure); }
            }
        };
    }
}
