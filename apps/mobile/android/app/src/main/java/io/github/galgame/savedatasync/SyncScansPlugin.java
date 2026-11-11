package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.bytes;
import static io.github.galgame.savedatasync.TransferJson.fail;
import static io.github.galgame.savedatasync.TransferJson.object;
import static io.github.galgame.savedatasync.TransferJson.parse;
import static io.github.galgame.savedatasync.TransferSchema.id;
import static io.github.galgame.savedatasync.TransferSchema.number;
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

/** 只读扫描的原生插件：查询扫描能力，开始、查询和取消扫描。 */
@CapacitorPlugin(name = "SyncScans")
public class SyncScansPlugin extends Plugin {

  private final ExecutorService controls = Executors.newFixedThreadPool(2);
  private volatile boolean isDestroyed;

  private interface Work {
    Object run() throws Exception;
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
          Object value = work.run();
          call.resolve(
            new JSObject(
              new String(bytes(object("status", "success", "value", value)), StandardCharsets.UTF_8)
            )
          );
        } catch (Exception cause) {
          String code =
            cause instanceof ArchiveFailure
              ? ((ArchiveFailure) cause).code
              : cause instanceof SafFailure
                ? ((SafFailure) cause).code
                : "io-failure";
          try {
            call.resolve(
              new JSObject(
                new String(
                  bytes(object("status", "error", "error", SyncScanner.scanError(code))),
                  StandardCharsets.UTF_8
                )
              )
            );
          } catch (Exception invalid) {
            call.resolve(
              new SafFailure("io-failure", "The scan service response failed.", invalid).result()
            );
          }
        }
      });
    } catch (java.util.concurrent.RejectedExecutionException cause) {
      call.resolve(
        new SafFailure("unsupported-operation", "The scan bridge is closed.", cause).result()
      );
    }
  }

  @PluginMethod
  public void capabilities(PluginCall call) {
    submit(call, () -> {
      arguments(call);
      return object(
        "schemaVersion",
        SyncJobModel.CAPABILITIES_VERSION,
        "deviceId",
        SafRuntime.store(getContext()).deviceId(),
        "canScan",
        "supported",
        "canCopy",
        "supported",
        "canBackup",
        "supported",
        "canRestore",
        "supported",
        "limits",
        object(
          "maxEntries",
          10000,
          "maxDepth",
          64,
          "maxPathLength",
          4096,
          "maxNameLength",
          255,
          "maxRetainedScans",
          32,
          "snapshotLifetimeMs",
          600000,
          "scanTimeoutMs",
          1800000
        )
      );
    });
  }

  @PluginMethod
  public void start(PluginCall call) {
    submit(call, () -> {
      Map<String, Object> value = arguments(call, "schemaVersion", "rootId");
      if (number(value.get("schemaVersion"), 0, 9007199254740991L) != 1) {
        throw fail("protocol-mismatch");
      }
      return SafRuntime.scanner(getContext()).start(id(value.get("rootId")));
    });
  }

  @PluginMethod
  public void query(PluginCall call) {
    submit(call, () ->
      SafRuntime.scanner(getContext()).query(id(arguments(call, "scanId").get("scanId")))
    );
  }

  @PluginMethod
  public void cancel(PluginCall call) {
    submit(call, () ->
      SafRuntime.scanner(getContext()).cancel(id(arguments(call, "scanId").get("scanId")))
    );
  }

  @Override
  protected void handleOnDestroy() {
    isDestroyed = true;
    controls.shutdownNow();
  }
}
