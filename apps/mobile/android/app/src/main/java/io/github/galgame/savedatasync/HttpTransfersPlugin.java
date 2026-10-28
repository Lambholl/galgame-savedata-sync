package io.github.galgame.savedatasync;

import android.app.Activity;
import android.content.Intent;
import android.content.UriPermission;
import android.net.Uri;
import android.os.CancellationSignal;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import static io.github.galgame.savedatasync.TransferJson.*;
import static io.github.galgame.savedatasync.TransferSchema.*;

/** 有限的原生 HTTP/任务桥；Activity 只订阅，进行中的传输由持续通知服务持有。 */
@CapacitorPlugin(name = "HttpTransfers", permissions = @Permission(alias = "notifications", strings = { android.Manifest.permission.POST_NOTIFICATIONS }))
public class HttpTransfersPlugin extends Plugin {
    private final ExecutorService io = Executors.newFixedThreadPool(2);
    private final Set<ArchiveControl> queries = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean choosing = new AtomicBoolean();
    private volatile boolean destroyed;
    private TransferRuntime runtime;
    private final TransferEngine.Listener listener = value -> {
        if (!destroyed) try { notifyListeners("transferState", json(value)); }
        catch (Exception cause) { throw new IllegalStateException("无法通知任务状态，可查询实际结果", cause); }
    };
    private synchronized TransferEngine engine() throws Exception {
        if (destroyed) throw fail("unsupported-operation");
        if (runtime == null) {
            runtime = TransferRuntime.get(getContext()); runtime.attach(listener);
        }
        return runtime.engine;
    }
    private interface Work { Object run(ArchiveControl control) throws Exception; }
    private static JSObject json(Object value) throws Exception { return new JSObject(new String(bytes(value), StandardCharsets.UTF_8)); }
    /** 连接错误直接显示 HTTP/协议码、系统 errno 或原始异常类型，不推测原因。 */
    private static Map<String, Object> connectionError(Exception cause) {
        ArchiveFailure failure = NewFilePublisher.failure(cause);
        Map<String, Object> result = error(failure.code);
        String diagnostic = failure.diagnosticCode;
        String nativeCode = null;
        String exceptionType = null;
        Throwable current = cause;
        for (int depth = 0; current != null && depth < 16; depth++, current = current.getCause()) {
            if (current instanceof ArchiveFailure && ((ArchiveFailure) current).diagnosticCode != null) {
                diagnostic = ((ArchiveFailure) current).diagnosticCode;
            }
            if (current instanceof android.system.ErrnoException) {
                int errno = ((android.system.ErrnoException) current).errno;
                String name = android.system.OsConstants.errnoName(errno);
                nativeCode = name != null ? name : "errno=" + errno;
            } else if (!(current instanceof ArchiveFailure)) {
                exceptionType = current.getClass().getSimpleName();
            }
        }
        String detail = nativeCode != null ? nativeCode : exceptionType;
        if (diagnostic != null) result.put("message", diagnostic);
        else if (detail == null) result.put("message", failure.code);
        else result.put("message", failure.code.equals("timeout") ? failure.code + " / " + detail : detail);
        return result;
    }
    private void submit(PluginCall call, Work work) {
        try {
            io.execute(() -> {
                ArchiveControl control = call.getMethodName().equals("connect")
                    ? new ArchiveControl(System::nanoTime, TimeUnit.SECONDS.toNanos(5)) : new ArchiveControl();
                queries.add(control);
                try {
                    if (destroyed) throw fail("unsupported-operation");
                    Object value = work.run(control);
                    if (!call.getMethodName().startsWith("start")) control.check();
                    call.resolve(json(object("status", "success", "value", value)));
                } catch (Exception cause) {
                    try {
                        Map<String, Object> failure = call.getMethodName().equals("connect") || call.getMethodName().equals("exchangeCatalog")
                            ? connectionError(cause) : error(NewFilePublisher.failure(cause).code);
                        call.resolve(json(object("status", "error", "error", failure)));
                    }
                    catch (Exception invalid) { call.resolve(new SafFailure("io-failure", "任务服务不可用").result()); }
                } finally { queries.remove(control); }
            });
        } catch (java.util.concurrent.RejectedExecutionException cause) { call.resolve(new SafFailure("unsupported-operation", "应用已关闭").result()); }
    }
    private Map<String, Object> arguments(PluginCall call, String... fields) throws Exception {
        return shape(parse(call.getData().toString().getBytes(StandardCharsets.UTF_8)), fields);
    }
    @PluginMethod public void connect(PluginCall call) { submit(call, c -> { Map<String, Object> a = arguments(call, "address"); return engine().connect(new TransferHttp.Client(string(a.get("address"))), c); }); }
    @PluginMethod public void disconnect(PluginCall call) { submit(call, c -> { arguments(call); engine().disconnect(); return null; }); }
    @PluginMethod public void connections(PluginCall call) { submit(call, c -> { arguments(call); return engine().connections(); }); }
    @PluginMethod public void selectDevice(PluginCall call) { submit(call, c -> engine().selectDevice(id(arguments(call, "deviceId").get("deviceId")))); }
    @PluginMethod public void disconnectDevice(PluginCall call) { submit(call, c -> { engine().disconnectDevice(id(arguments(call, "deviceId").get("deviceId")), c); return null; }); }
    @PluginMethod public void exchangeCatalog(PluginCall call) { submit(call, c -> {
        Map<String, Object> a = arguments(call, "deviceId", "catalog");
        return engine().exchangeCatalog(id(a.get("deviceId")), a.get("catalog"), android.os.Build.MODEL, c);
    }); }
    @PluginMethod public void listRemoteRoots(PluginCall call) { submit(call, c -> { arguments(call); return engine().roots(c); }); }
    @PluginMethod public void listRemoteDirectory(PluginCall call) { submit(call, c -> { Map<String, Object> a = arguments(call, "rootId", "parentId"); return engine().directory(id(a.get("rootId")), parent(a.get("parentId")), c); }); }
    @PluginMethod public void startDownload(PluginCall call) { submit(call, c -> { engine(); return runtime.start(arguments(call, "request", "targetRootId", "targets"), false); }); }
    @PluginMethod public void startUpload(PluginCall call) { submit(call, c -> { engine(); return runtime.start(arguments(call, "request", "targetRootId", "targets"), true); }); }
    @PluginMethod public void current(PluginCall call) { submit(call, c -> { arguments(call); return engine().current(); }); }
    @PluginMethod public void query(PluginCall call) { submit(call, c -> engine().query(id(arguments(call, "transferId").get("transferId")))); }
    @PluginMethod public void getManifest(PluginCall call) { submit(call, c -> engine().manifest(id(arguments(call, "transferId").get("transferId")))); }
    @PluginMethod public void queryRemote(PluginCall call) { submit(call, c -> {
        Map<String, Object> a = arguments(call, "transferId", "refresh"); require(a.get("refresh") instanceof Boolean);
        return engine().remoteState(id(a.get("transferId")), (Boolean) a.get("refresh"), c);
    }); }
    @PluginMethod public void cancel(PluginCall call) { submit(call, c -> { engine().cancel(id(arguments(call, "transferId").get("transferId"))); return null; }); }
    @PluginMethod public void retryCleanup(PluginCall call) { submit(call, c -> { arguments(call); return engine().retryCleanup(); }); }
    /** 主动请求通知权限；未允许持续通知时不开始传输。 */
    @PluginMethod public void requestNotifications(PluginCall call) {
        try {
            arguments(call); if (destroyed) throw fail("unsupported-operation");
            TransferService.prepareChannel(getContext());
            if (android.os.Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
                requestPermissionForAlias("notifications", call, "onNotificationPermission"); return;
            }
            call.resolve(json(object("status", "success", "value", TransferService.notificationsAllowed(getContext()))));
        } catch (Exception cause) { call.resolve(new SafFailure("permission-denied", "无法申请传输通知权限", cause).result()); }
    }
    @PermissionCallback private void onNotificationPermission(PluginCall call) {
        if (call == null) return;
        try { call.resolve(json(object("status", "success", "value", TransferService.notificationsAllowed(getContext())))); }
        catch (Exception cause) { call.resolve(new SafFailure("permission-denied", "传输通知不可用", cause).result()); }
    }

    /** 选择存档目录时保存系统读写权限；以后接收会重新核实已有持久权限。 */
    @PluginMethod public void chooseTarget(PluginCall call) {
        try { arguments(call); if (destroyed || !choosing.compareAndSet(false, true)) throw fail("unsupported-operation"); }
        catch (Exception cause) { call.resolve(new SafFailure("invalid-request", "请先完成当前目录选择").result()); return; }
        io.execute(() -> {
            try {
                engine();
                getActivity().runOnUiThread(() -> {
                    try {
                        if (destroyed) throw fail("unsupported-operation");
                        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION |
                            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
                        startActivityForResult(call, intent, "onTargetChosen");
                    } catch (Exception cause) { choosing.set(false); call.resolve(new SafFailure("permission-denied", "无法打开目标目录选择器").result()); }
                });
            } catch (Exception cause) { choosing.set(false); call.resolve(new SafFailure("permission-denied", "无法打开目标目录选择器").result()); }
        });
    }
    @ActivityCallback private void onTargetChosen(PluginCall call, ActivityResult result) {
        choosing.set(false); if (call == null) return;
        if (result.getResultCode() == Activity.RESULT_CANCELED) { JSObject value = new JSObject(); value.put("status", "cancelled"); call.resolve(value); return; }
        try {
            Intent data = result.getData(); int rights = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
            if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null || (data.getFlags() & rights) != rights ||
                (data.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) == 0) throw fail("permission-denied");
            Uri uri = data.getData();
            io.execute(() -> {
                boolean hadWrite = false;
                for (UriPermission permission : getContext().getContentResolver().getPersistedUriPermissions()) if (uri.equals(permission.getUri()) && permission.isWritePermission()) hadWrite = true;
                try {
                    getContext().getContentResolver().takePersistableUriPermission(uri, rights);
                    JSObject directory = SafRuntime.store(getContext()).register(uri, data.getFlags(), new CancellationSignal());
                    engine(); String root = directory.getString("rootId"); runtime.publisher.grant(root);
                    call.resolve(json(object("status", "selected", "directory", parse(directory.toString().getBytes(StandardCharsets.UTF_8)))));
                } catch (Exception cause) {
                    if (!hadWrite) try { getContext().getContentResolver().releasePersistableUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION); } catch (Exception ignored) { /* 不撤销既有用户授权。 */ }
                    call.resolve(new SafFailure("permission-denied", "未取得目标目录写入授权", cause).result());
                }
            });
        } catch (Exception cause) { call.resolve(new SafFailure("permission-denied", "系统未返回有效写入授权", cause).result()); }
    }
    @Override protected void handleOnDestroy() {
        destroyed = true; for (ArchiveControl control : queries) control.cancel();
        synchronized (this) { if (runtime != null) runtime.detach(listener); } io.shutdownNow();
    }
}
