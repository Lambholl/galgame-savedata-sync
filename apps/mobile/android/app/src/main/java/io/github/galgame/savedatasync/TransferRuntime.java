package io.github.galgame.savedatasync;

import android.content.Context;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import static io.github.galgame.savedatasync.TransferJson.*;
import static io.github.galgame.savedatasync.TransferSchema.*;

/** 应用进程持有本次传输；Activity 只订阅，持续通知服务持有运行期，不保存旧任务到磁盘。 */
final class TransferRuntime {
    private static TransferRuntime instance;
    final TransferEngine engine;
    final NewFilePublisher publisher;
    private final Context context;
    private final ExecutorService controls = Executors.newSingleThreadExecutor();
    private final List<WeakReference<TransferEngine.Listener>> listeners = new CopyOnWriteArrayList<>();
    private final java.util.Set<Object> visible = new java.util.HashSet<>();
    private volatile boolean starting;
    private volatile String pendingId;
    private volatile boolean pendingUpload;
    static synchronized TransferRuntime get(Context context) throws Exception {
        if (instance == null) instance = new TransferRuntime(context.getApplicationContext());
        return instance;
    }
    static synchronized TransferRuntime peek() { return instance; }
    private TransferRuntime(Context context) throws Exception {
        this.context = context; SafDirectoryStore store = SafRuntime.store(context);
        publisher = new NewFilePublisher(new SafPublicationBackend(context, store));
        engine = new TransferEngine(SafArchiveSource.createAdapter(context), publisher, new TransferEngine.Local() {
            @Override public String deviceId() { return store.deviceId(); }
            @Override public List<ArchiveModel.Source> sources(String rootId, List<Object> selections) throws Exception {
                List<ArchiveModel.Source> result = new ArrayList<>();
                for (Object selection : selections) result.add(new SafArchiveSource(store, rootId, string(map(selection).get("entryId"))));
                return result;
            }
        }, value -> {
            for (WeakReference<TransferEngine.Listener> reference : listeners) {
                TransferEngine.Listener listener = reference.get();
                if (listener == null) listeners.remove(reference); else listener.state(value);
            }
        });
    }
    void attach(TransferEngine.Listener listener) { listeners.add(new WeakReference<>(listener)); }
    void detach(TransferEngine.Listener listener) { listeners.removeIf(reference -> reference.get() == null || reference.get() == listener); }
    synchronized void visibility(Object owner, boolean value) {
        if (value) visible.add(owner); else visible.remove(owner);
        engine.foreground(!visible.isEmpty());
    }
    Object start(Object options, boolean upload) throws Exception {
        Map<String, Object> value = shape(copy(options), "request", "targetRootId", "targets");
        Map<String, Object> request = selection(value.get("request")); id(value.get("targetRootId")); targets(value.get("targets"), list(request.get("files")).size());
        synchronized (this) {
            if (starting || engine.hasWork()) throw fail("busy");
            if (!TransferService.notificationsAllowed(context)) throw fail("permission-denied");
            starting = true; pendingId = string(request.get("transferId")); pendingUpload = upload;
        }
        try {
            // 目录选择已保存系统读写权限；每次接收前重新核实并恢复进程内发布授权。
            if (!upload) publisher.grant(string(value.get("targetRootId")));
            // 必须先确认系统已接受前台服务和持续通知，再开始文件/网络任务。
            TransferService.launch(context).get(10, TimeUnit.SECONDS);
            return engine.start(value, upload);
        } finally { starting = false; }
    }
    boolean busy() { return starting || engine.hasWork(); }
    Map<String, Object> notice() {
        Map<String, Object> value = engine.notice();
        return value == null && starting ? object("transferId", pendingId, "upload", pendingUpload, "running", true, "stage", "preparing", "progress", null) : value;
    }
    void cancel(String id, boolean timeout) { controls.execute(() -> engine.cancelActive(id, timeout)); }
    void retry(String id) { controls.execute(() -> { if (id != null && id.equals(engine.activeId())) engine.retryCleanup(); }); }
}
