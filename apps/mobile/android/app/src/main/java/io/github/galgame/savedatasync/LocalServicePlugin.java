package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.object;
import static io.github.galgame.savedatasync.TransferJson.parse;
import static io.github.galgame.savedatasync.TransferSchema.id;
import static io.github.galgame.savedatasync.TransferSchema.parent;
import static io.github.galgame.savedatasync.TransferSchema.shape;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 本机服务的原生插件：开关、端口、状态，以及连着本机的设备的目录表、目录读取和断开。
 * 状态变化时发 serviceState 事件，本机服务改写游戏库配置后发 libraryChanged 事件。
 */
@CapacitorPlugin(name = "LocalService")
public class LocalServicePlugin extends Plugin {

  private final ExecutorService io = Executors.newFixedThreadPool(2);
  private ListenerRuntime runtime;
  private final ListenerRuntime.Observer observer = new ListenerRuntime.Observer() {
    @Override
    public void stateChanged() {
      notifyListeners("serviceState", new JSObject());
    }

    @Override
    public void libraryChanged() {
      notifyListeners("libraryChanged", new JSObject());
    }
  };

  private interface Work {
    Object run() throws Exception;
  }

  @Override
  public void load() {
    runtime = ListenerRuntime.get(getContext());
    runtime.subscribe(observer);
  }

  @Override
  protected void handleOnResume() {
    // 开关开着、进程却被结束过时，回到应用即重新启动服务。等 Activity 可见再启动：系统不允许后台应用启动前台服务。
    io.execute(runtime::resume);
  }

  private void submit(PluginCall call, Work work) {
    try {
      io.execute(() -> {
        try {
          call.resolve(json(object("status", "success", "value", work.run())));
        } catch (Exception cause) {
          ArchiveFailure failure = ArchiveFailure.from(cause);
          try {
            call.resolve(
              json(
                object(
                  "status",
                  "error",
                  "error",
                  object(
                    "code",
                    failure.code,
                    "message",
                    failure.getMessage(),
                    "canRetry",
                    !"invalid-request".equals(failure.code)
                  )
                )
              )
            );
          } catch (Exception invalid) {
            call.resolve(
              new DirectoryFailure("internal-error", "The local service is unavailable.").result()
            );
          }
        }
      });
    } catch (java.util.concurrent.RejectedExecutionException closed) {
      call.resolve(new DirectoryFailure("unsupported-operation", "The app is closed.").result());
    }
  }

  private static JSObject json(Object value) throws Exception {
    return new JSObject(new String(TransferJson.bytes(value), StandardCharsets.UTF_8));
  }

  private Map<String, Object> arguments(PluginCall call, String... fields) throws Exception {
    return shape(parse(call.getData().toString().getBytes(StandardCharsets.UTF_8)), fields);
  }

  @PluginMethod
  public void status(PluginCall call) {
    submit(call, () -> {
      arguments(call);
      return runtime.status();
    });
  }

  @PluginMethod
  public void start(PluginCall call) {
    submit(call, () -> {
      arguments(call);
      runtime.start();
      return runtime.status();
    });
  }

  @PluginMethod
  public void stop(PluginCall call) {
    submit(call, () -> {
      arguments(call);
      runtime.stop();
      return runtime.status();
    });
  }

  @PluginMethod
  public void randomizePort(PluginCall call) {
    submit(call, () -> {
      arguments(call);
      runtime.randomizePort();
      return runtime.status();
    });
  }

  @PluginMethod
  public void peers(PluginCall call) {
    submit(call, () -> {
      arguments(call);
      return runtime.peers();
    });
  }

  @PluginMethod
  public void disconnectPeer(PluginCall call) {
    submit(call, () -> {
      runtime.disconnect(id(arguments(call, "deviceId").get("deviceId")));
      return null;
    });
  }

  @PluginMethod
  public void peerDirectory(PluginCall call) {
    submit(call, () -> {
      Map<String, Object> a = arguments(call, "deviceId", "rootId", "parentId");
      return runtime.directory(
        id(a.get("deviceId")),
        id(a.get("rootId")),
        parent(a.get("parentId"))
      );
    });
  }

  @PluginMethod
  public void peerPoster(PluginCall call) {
    submit(call, () -> {
      Map<String, Object> a = arguments(call, "deviceId", "gameId");
      return runtime.peerPoster(id(a.get("deviceId")), id(a.get("gameId")));
    });
  }

  @PluginMethod
  public void catalogChanged(PluginCall call) {
    submit(call, () -> {
      arguments(call);
      runtime.catalogChanged();
      return null;
    });
  }

  @Override
  protected void handleOnDestroy() {
    runtime.unsubscribe(observer);
    io.shutdownNow();
  }
}
