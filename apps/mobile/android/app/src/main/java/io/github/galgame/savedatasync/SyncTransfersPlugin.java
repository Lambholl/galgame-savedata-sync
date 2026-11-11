package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.bytes;
import static io.github.galgame.savedatasync.TransferJson.fail;
import static io.github.galgame.savedatasync.TransferJson.object;
import static io.github.galgame.savedatasync.TransferJson.parse;
import static io.github.galgame.savedatasync.TransferSchema.error;
import static io.github.galgame.savedatasync.TransferSchema.id;
import static io.github.galgame.savedatasync.TransferSchema.require;
import static io.github.galgame.savedatasync.TransferSchema.shape;
import static io.github.galgame.savedatasync.TransferSchema.string;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** 复制任务的原生插件：准备和预览、确认、状态和清单、取消和释放。 */
@CapacitorPlugin(name = "SyncTransfers")
public class SyncTransfersPlugin extends Plugin {

  private final ExecutorService controls = Executors.newFixedThreadPool(2);
  private volatile boolean isDestroyed;

  private interface Work {
    Object run(SyncTransferRuntime runtime) throws Exception;
  }

  private Map<String, Object> arguments(PluginCall call, String... fields) throws Exception {
    return shape(parse(call.getData().toString().getBytes(StandardCharsets.UTF_8)), fields);
  }

  private void submit(PluginCall call, Work work) {
    try {
      controls.execute(() -> {
        try {
          if (isDestroyed) {
            throw fail("unsupported-operation");
          }
          Object value = work.run(SyncTransferRuntime.get(getContext()));
          call.resolve(
            new JSObject(
              new String(bytes(object("status", "success", "value", value)), StandardCharsets.UTF_8)
            )
          );
        } catch (Exception cause) {
          ArchiveFailure failure = ArchiveFailure.from(cause);
          Map<String, Object> error = object(
            "code",
            failure.code,
            "message",
            failure.getMessage(),
            "canRetry",
            false
          );
          if (failure.device != null) {
            error.put("device", failure.device);
          }
          try {
            call.resolve(
              new JSObject(
                new String(bytes(object("status", "error", "error", error)), StandardCharsets.UTF_8)
              )
            );
          } catch (Exception invalid) {
            call.resolve(
              new SafFailure("io-failure", "The copy response is invalid.", invalid).result()
            );
          }
        }
      });
    } catch (java.util.concurrent.RejectedExecutionException cause) {
      call.resolve(
        new SafFailure("unsupported-operation", "The copy bridge is closed.", cause).result()
      );
    }
  }

  @PluginMethod
  public void prepare(PluginCall call) {
    submit(call, runtime -> {
      Map<String, Object> value = arguments(call, "binding", "direction");
      return runtime.engine.prepare(value.get("binding"), string(value.get("direction")));
    });
  }

  @PluginMethod
  public void queryPreparation(PluginCall call) {
    submit(call, runtime ->
      runtime.engine.preparationState(id(arguments(call, "preparationId").get("preparationId")))
    );
  }

  @PluginMethod
  public void preview(PluginCall call) {
    submit(call, runtime ->
      runtime.engine.preview(id(arguments(call, "preparationId").get("preparationId")))
    );
  }

  @PluginMethod
  public void cancelPreparation(PluginCall call) {
    submit(call, runtime ->
      runtime.engine.cancelPreparation(id(arguments(call, "preparationId").get("preparationId")))
    );
  }

  @PluginMethod
  public void execute(PluginCall call) {
    submit(call, runtime -> {
      Map<String, Object> value = arguments(call, "preparationId", "plan");
      return runtime.execute(id(value.get("preparationId")), value.get("plan"));
    });
  }

  @PluginMethod
  public void query(PluginCall call) {
    submit(call, runtime -> {
      Map<String, Object> value = arguments(call, "jobId", "refresh");
      require(value.get("refresh") instanceof Boolean);
      return runtime.engine.query(id(value.get("jobId")), (Boolean) value.get("refresh"));
    });
  }

  @PluginMethod
  public void manifest(PluginCall call) {
    submit(call, runtime -> runtime.engine.manifest(id(arguments(call, "jobId").get("jobId"))));
  }

  @PluginMethod
  public void current(PluginCall call) {
    submit(call, runtime -> {
      arguments(call);
      return runtime.engine.current();
    });
  }

  @PluginMethod
  public void latest(PluginCall call) {
    submit(call, runtime ->
      runtime.engine.latest(id(arguments(call, "projectId").get("projectId")))
    );
  }

  @PluginMethod
  public void cancel(PluginCall call) {
    submit(call, runtime ->
      runtime.engine.cancel(id(arguments(call, "jobId").get("jobId")), false)
    );
  }

  @PluginMethod
  public void release(PluginCall call) {
    submit(call, runtime -> {
      runtime.engine.release(id(arguments(call, "preparationId").get("preparationId")));
      return null;
    });
  }

  @PluginMethod
  public void retryCleanup(PluginCall call) {
    submit(call, runtime -> {
      arguments(call);
      runtime.engine.retryCleanup();
      return null;
    });
  }

  @Override
  protected void handleOnDestroy() {
    // 已开始的确认可能正在等系统接受传输通知；页面销毁不能中断应用级启动。
    isDestroyed = true;
    controls.shutdown();
  }
}
