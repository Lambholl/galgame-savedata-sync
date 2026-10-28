package io.github.galgame.savedatasync;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import static io.github.galgame.savedatasync.TransferJson.*;
import static io.github.galgame.savedatasync.TransferSchema.*;

/** 仅本机恢复的有限桥；原文、FD、URI 和任意路径均留在原生层。 */
@CapacitorPlugin(name = "SyncWrites")
public class SyncWritesPlugin extends Plugin {
    private final ExecutorService controls = Executors.newFixedThreadPool(2);
    private volatile boolean destroyed;
    private interface Work { Object run(SyncWriteRuntime runtime) throws Exception; }
    private Map<String, Object> arguments(PluginCall call, String... fields) throws Exception {
        return shape(parse(call.getData().toString().getBytes(StandardCharsets.UTF_8)), fields);
    }
    private void submit(PluginCall call, Work work) {
        try {
            controls.execute(() -> {
                try {
                    if (destroyed) throw new ArchiveFailure("unsupported-operation", "恢复桥已关闭");
                    Object value = work.run(SafRuntime.writes(getContext()));
                    call.resolve(new JSObject(new String(bytes(object("status", "success", "value", value)), StandardCharsets.UTF_8)));
                } catch (Exception cause) {
                    ArchiveFailure failure = ArchiveFailure.from(cause);
                    try { call.resolve(new JSObject(new String(bytes(object("status", "error", "error", object("code", failure.code, "message", failure.getMessage(), "canRetry", false))), StandardCharsets.UTF_8))); }
                    catch (Exception invalid) { call.resolve(new SafFailure("io-failure", "恢复响应无效", invalid).result()); }
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException cause) { call.resolve(new SafFailure("unsupported-operation", "恢复桥已关闭", cause).result()); }
    }
    @PluginMethod public void bindProject(PluginCall call) { submit(call, runtime -> {
        Map<String, Object> value = arguments(call, "projectId", "rootId"); runtime.bindProject(id(value.get("projectId")), id(value.get("rootId"))); return null;
    }); }
    @PluginMethod public void prepareRestore(PluginCall call) { submit(call, runtime -> {
        Map<String, Object> value = arguments(call, "projectId", "rootId", "backupId"); return runtime.prepare(id(value.get("projectId")), id(value.get("rootId")), id(value.get("backupId")));
    }); }
    @PluginMethod public void query(PluginCall call) { submit(call, runtime -> runtime.query(id(arguments(call, "restoreId").get("restoreId")))); }
    @PluginMethod public void current(PluginCall call) { submit(call, runtime -> { arguments(call); return runtime.current(); }); }
    @PluginMethod public void preview(PluginCall call) { submit(call, runtime -> runtime.preview(id(arguments(call, "restoreId").get("restoreId")))); }
    @PluginMethod public void execute(PluginCall call) { submit(call, runtime -> {
        Map<String, Object> value = arguments(call, "restoreId", "plan"); return runtime.execute(id(value.get("restoreId")), value.get("plan"));
    }); }
    @PluginMethod public void cancel(PluginCall call) { submit(call, runtime -> runtime.cancel(id(arguments(call, "restoreId").get("restoreId")))); }
    @PluginMethod public void release(PluginCall call) { submit(call, runtime -> { runtime.release(id(arguments(call, "restoreId").get("restoreId"))); return null; }); }
    @PluginMethod public void retryCleanup(PluginCall call) { submit(call, runtime -> {
        arguments(call); if (!runtime.retryCleanup()) throw new ArchiveFailure("cleanup-failed", "恢复资源尚未完整释放"); return null;
    }); }
    @Override protected void handleOnDestroy() { destroyed = true; controls.shutdownNow(); }
}
