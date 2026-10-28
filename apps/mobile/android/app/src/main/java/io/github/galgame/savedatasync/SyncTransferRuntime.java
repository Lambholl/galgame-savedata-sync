package io.github.galgame.savedatasync;

import android.content.Context;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import static io.github.galgame.savedatasync.TransferJson.*;
import static io.github.galgame.savedatasync.TransferSchema.*;

/** 应用 Context 持有新复制，页面只是控制入口；只在确认执行后启动传输通知。 */
final class SyncTransferRuntime {
    private static SyncTransferRuntime instance;
    final SyncTransferEngine engine;
    private final Context context;
    private final ExecutorService controls = Executors.newSingleThreadExecutor();
    static synchronized SyncTransferRuntime get(Context context) throws Exception {
        if (instance == null) instance = new SyncTransferRuntime(context.getApplicationContext()); return instance;
    }
    static synchronized SyncTransferRuntime peek() { return instance; }
    private SyncTransferRuntime(Context context) throws Exception {
        this.context = context;
        SafDirectoryStore store = SafRuntime.store(context);
        engine = new SyncTransferEngine(TransferRuntime.get(context).engine, new SyncTransferEngine.Local() {
            @Override public String deviceId() { return store.deviceId(); }
            @Override public Map<String, Object> snapshot(String rootId, ArchiveControl control) throws Exception {
                return SafRuntime.scanner(context).snapshotNow(rootId, control);
            }
            @Override public List<ArchiveModel.Source> sources(SyncPlanModel.Plan plan) throws Exception {
                List<ArchiveModel.Source> sources = new ArrayList<>();
                for (Map<String, Object> operation : plan.writes) if (!operation.get("action").equals("create-directory")) {
                    sources.add(new SafArchiveSource(store, plan.source.root, id(operation.get("sourceEntryId"))));
                }
                return sources;
            }
        });
    }
    Map<String, Object> execute(String id, Object plan) throws Exception {
        if (!TransferService.notificationsAllowed(context)) throw new ArchiveFailure("permission-denied", "请先允许文件传输通知");
        engine.reserve(id, plan);
        try {
            TransferService.launch(context).get(10, TimeUnit.SECONDS);
            engine.begin(id);
        } catch (Exception cause) {
            ArchiveFailure failure = new ArchiveFailure("permission-denied", "系统未接受本次文件传输服务", false, cause);
            engine.failStart(id, failure); throw failure;
        }
        return engine.query(id, false);
    }
    boolean busy() { return engine.busy(); }
    Map<String, Object> notice() { return engine.notice(); }
    void cancel(String expectedId, boolean timeout) {
        controls.execute(() -> {
            String active = engine.activeId();
            if (active != null && (expectedId == null || active.equals(expectedId))) try { engine.cancel(active, timeout); }
            catch (Exception ignored) { /* 任务已终止时保留可查询的实际结果。 */ }
        });
    }
    void retry(String expectedId) {
        controls.execute(() -> {
            if (expectedId != null && expectedId.equals(engine.activeId())) try { engine.retryCleanup(); }
            catch (Exception ignored) { /* 清理失败仍保留通知和名额，下次显式重试。 */ }
        });
    }
}
