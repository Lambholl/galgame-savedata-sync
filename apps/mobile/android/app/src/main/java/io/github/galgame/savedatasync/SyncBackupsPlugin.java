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

/** 本机备份设置、摘要和明确清理；创建和恢复文件流只由原生编排调用。 */
@CapacitorPlugin(name = "SyncBackups")
public class SyncBackupsPlugin extends Plugin {
    private final ExecutorService controls = Executors.newFixedThreadPool(2);
    private volatile boolean destroyed;
    private interface Work { Object run(BackupStore store) throws Exception; }
    private Map<String, Object> arguments(PluginCall call, String... fields) throws Exception {
        return shape(parse(call.getData().toString().getBytes(StandardCharsets.UTF_8)), fields);
    }
    private void submit(PluginCall call, Work work) {
        try {
            controls.execute(() -> {
                try {
                    if (destroyed) throw BackupFiles.failure("unsupported-operation");
                    Object value = work.run(SafRuntime.backups(getContext()));
                    call.resolve(new JSObject(new String(bytes(object("status", "success", "value", value)), StandardCharsets.UTF_8)));
                } catch (Exception cause) {
                    String code = cause instanceof ArchiveFailure ? ((ArchiveFailure) cause).code :
                        cause instanceof SafFailure ? ((SafFailure) cause).code : "io-failure";
                    try { call.resolve(new JSObject(new String(bytes(object("status", "error", "error", BackupStore.error(BackupFiles.failure(code)))), StandardCharsets.UTF_8))); }
                    catch (Exception invalid) { call.resolve(new SafFailure("io-failure", "备份查询响应失败", invalid).result()); }
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException cause) {
            call.resolve(new SafFailure("unsupported-operation", "备份桥已关闭", cause).result());
        }
    }
    @PluginMethod public void read(PluginCall call) { submit(call, store -> { arguments(call); return store.info(); }); }
    @PluginMethod public void list(PluginCall call) { submit(call, store -> {
        Map<String, Object> value = arguments(call, "projectId", "rootId");
        return store.list(id(value.get("projectId")), id(value.get("rootId")));
    }); }
    @PluginMethod public void manifest(PluginCall call) { submit(call, store -> {
        Map<String, Object> value = arguments(call, "projectId", "rootId", "backupId");
        return store.manifest(id(value.get("projectId")), id(value.get("rootId")), id(value.get("backupId")));
    }); }
    @PluginMethod public void setPreference(PluginCall call) { submit(call, store -> {
        Map<String, Object> value = arguments(call, "projectId", "rootId", "shouldBackup"); require(value.get("shouldBackup") instanceof Boolean);
        return store.setPreference(id(value.get("projectId")), id(value.get("rootId")), (Boolean) value.get("shouldBackup"));
    }); }
    @PluginMethod public void rotate(PluginCall call) { submit(call, store -> {
        Map<String, Object> value = arguments(call, "projectId", "rootId");
        store.rotate(id(value.get("projectId")), id(value.get("rootId"))); return null;
    }); }
    @PluginMethod public void cleanupIncomplete(PluginCall call) { submit(call, store -> {
        Map<String, Object> value = arguments(call, "projectId", "rootId", "backupId");
        store.cleanupIncomplete(id(value.get("projectId")), id(value.get("rootId")), id(value.get("backupId"))); return null;
    }); }
    @Override protected void handleOnDestroy() { destroyed = true; controls.shutdownNow(); }
}
