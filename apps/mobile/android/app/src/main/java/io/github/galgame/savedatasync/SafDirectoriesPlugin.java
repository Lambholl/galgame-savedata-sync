package io.github.galgame.savedatasync;

import android.app.Activity;
import android.content.Intent;
import android.os.CancellationSignal;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/**
 * 仅在前台可用的元数据桥；不暴露 URI、路径、文件字节或写入方法。
 * 提供者 I/O 在 UI 线程之外串行执行；离开前台时取消活动查询。
 */
@CapacitorPlugin(name = "SafDirectories")
public class SafDirectoriesPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Set<CancellationSignal> signals = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean choosing = new AtomicBoolean();
    private volatile boolean foreground;
    private SafDirectoryStore store;

    private SafDirectoryStore store() throws SafFailure {
        if (store == null) store = new SafDirectoryStore(getContext());
        return store;
    }

    private interface Work { JSObject run(CancellationSignal signal) throws Exception; }

    private void submit(PluginCall call, boolean requireForeground, Work work) {
        try {
            worker.execute(() -> {
                CancellationSignal signal = new CancellationSignal();
                signals.add(signal);
                try {
                    if (requireForeground && !foreground) {
                        throw new SafFailure("unsupported-operation", "请在应用前台读取目录");
                    }
                    JSObject result = work.run(signal);
                    if (result != null) {
                        signal.throwIfCanceled();
                        call.resolve(result);
                    }
                } catch (Exception cause) {
                    if ("chooseDirectory".equals(call.getMethodName())) choosing.set(false);
                    call.resolve(SafFailure.from(cause).result());
                } finally {
                    signals.remove(signal);
                }
            });
        } catch (RejectedExecutionException cause) {
            call.resolve(new SafFailure("io-failure", "应用已关闭，请重新打开", cause).result());
        }
    }

    private boolean noArguments(PluginCall call) {
        if (call.getData().length() == 0) return true;
        call.resolve(new SafFailure("invalid-request", "不接受额外参数").result());
        return false;
    }

    private static JSObject success(Object value) {
        JSObject result = new JSObject();
        result.put("status", "success");
        result.put("value", value);
        return result;
    }

    /** 仅以 READ 权限启动系统选择器；取消时保留所有已保存的根目录。 */
    @PluginMethod
    public void chooseDirectory(PluginCall call) {
        if (!noArguments(call)) return;
        if (!foreground || !choosing.compareAndSet(false, true)) {
            call.resolve(new SafFailure("unsupported-operation", "请在应用前台完成当前目录选择").result());
            return;
        }
        // 启动可授予权限的选择器前，先校验登记表。
        submit(call, true, signal -> {
            store();
            signal.throwIfCanceled();
            getActivity().runOnUiThread(() -> {
                try {
                    if (!foreground) throw new IllegalStateException("Activity left foreground");
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION |
                        Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
                    startActivityForResult(call, intent, "onDirectoryChosen");
                } catch (Exception cause) {
                    choosing.set(false);
                    call.resolve(SafFailure.from(cause).result());
                }
            });
            return null;
        });
    }

    /** 仅接收系统 Activity 返回的结果；JS 调用丢失时不会伪造选择成功。 */
    @ActivityCallback
    private void onDirectoryChosen(PluginCall call, ActivityResult activityResult) {
        choosing.set(false);
        if (call == null) return;
        if (activityResult.getResultCode() == Activity.RESULT_CANCELED) {
            JSObject result = new JSObject();
            result.put("status", "cancelled");
            call.resolve(result);
            return;
        }
        Intent data = activityResult.getData();
        if (activityResult.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.resolve(new SafFailure("permission-denied", "系统未返回有效的目录授权").result());
            return;
        }
        // Activity 结果可能在 onResume 之前到达；此时允许登记授权。
        submit(call, false, signal -> {
            JSObject result = new JSObject();
            result.put("status", "selected");
            result.put("directory", store().register(data.getData(), data.getFlags(), signal));
            return result;
        });
    }

    /** 返回共享 RootsResponse，其中包含已过期的保存引用。 */
    @PluginMethod
    public void listRoots(PluginCall call) {
        if (noArguments(call)) submit(call, true, signal -> success(store().listRoots(signal)));
    }

    /** 仅接受 rootId 和可为 null 的 parentId；未知 ID 不会转换为任意提供者 URI。 */
    @PluginMethod
    public void listDirectory(PluginCall call) {
        JSObject data = call.getData();
        Object root = data.opt("rootId");
        Object parent = data.opt("parentId");
        if (data.length() != 2 || !SafValues.isId(root) ||
            (parent != JSONObject.NULL && !SafValues.isId(parent))) {
            call.resolve(new SafFailure("invalid-request", "目录读取参数无效").result());
            return;
        }
        submit(call, true, signal -> success(store().listDirectory(
            (String) root, parent == JSONObject.NULL ? null : (String) parent, signal)));
    }

    @Override protected void handleOnResume() { foreground = true; }

    @Override protected void handleOnPause() {
        foreground = false;
        for (CancellationSignal signal : signals) signal.cancel();
    }

    @Override protected void handleOnDestroy() {
        foreground = false;
        for (CancellationSignal signal : signals) signal.cancel();
        worker.shutdownNow();
    }
}
