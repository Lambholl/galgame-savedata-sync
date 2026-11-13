package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.bytes;
import static io.github.galgame.savedatasync.TransferJson.object;
import static io.github.galgame.savedatasync.TransferJson.parse;
import static io.github.galgame.savedatasync.TransferSchema.id;
import static io.github.galgame.savedatasync.TransferSchema.shape;
import static io.github.galgame.savedatasync.TransferSchema.target;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** 本机备份的原生插件：读写备份设置、查看备份和清理备份。 */
@CapacitorPlugin(name = "SyncBackups")
public class SyncBackupsPlugin extends Plugin {

  private final ExecutorService controls = Executors.newFixedThreadPool(2);
  private volatile boolean isDestroyed;

  private interface Work {
    Object run(BackupStore store) throws Exception;
  }

  /** 占用与传输、恢复相同的进程名额后执行修改；名额被占时抛出 busy。 */
  private Object mutate(BackupStore store, Work work) throws Exception {
    // 任务确认后备份设置不能再变，所以修改和任务共用名额。
    Object owner = new Object();
    if (!TargetOperation.acquire(owner)) {
      throw new ArchiveFailure(
        "busy",
        "Wait for current task cleanup to finish " +
          "before changing backup settings or maintaining backups."
      );
    }
    try {
      return work.run(store);
    } finally {
      TargetOperation.release(owner);
    }
  }

  private Map<String, Object> arguments(PluginCall call, String... fields) throws Exception {
    return shape(parse(call.getData().toString().getBytes(StandardCharsets.UTF_8)), fields);
  }

  private void submit(PluginCall call, Work work) {
    try {
      controls.execute(() -> {
        try {
          if (isDestroyed) {
            throw BackupFiles.failure("unsupported-operation");
          }
          Object value = work.run(DirectoryRuntime.backups(getContext()));
          call.resolve(
            new JSObject(
              new String(bytes(object("status", "success", "value", value)), StandardCharsets.UTF_8)
            )
          );
        } catch (Exception cause) {
          String code =
            cause instanceof ArchiveFailure
              ? ((ArchiveFailure) cause).code
              : cause instanceof DirectoryFailure
                ? ((DirectoryFailure) cause).code
                : "io-failure";
          try {
            call.resolve(
              new JSObject(
                new String(
                  bytes(
                    object("status", "error", "error", BackupStore.error(BackupFiles.failure(code)))
                  ),
                  StandardCharsets.UTF_8
                )
              )
            );
          } catch (Exception invalid) {
            call.resolve(
              new DirectoryFailure(
                "io-failure",
                "The backup query response failed.",
                invalid
              ).result()
            );
          }
        }
      });
    } catch (java.util.concurrent.RejectedExecutionException cause) {
      call.resolve(
        new DirectoryFailure(
          "unsupported-operation",
          "The backup bridge is closed.",
          cause
        ).result()
      );
    }
  }

  @PluginMethod
  public void read(PluginCall call) {
    submit(call, store -> {
      arguments(call);
      return store.info();
    });
  }

  @PluginMethod
  public void list(PluginCall call) {
    submit(call, store -> store.list(id(arguments(call, "projectId").get("projectId"))));
  }

  @PluginMethod
  public void manifest(PluginCall call) {
    submit(call, store -> {
      Map<String, Object> value = arguments(call, "projectId", "backupId");
      return store.manifest(id(value.get("projectId")), id(value.get("backupId")));
    });
  }

  @PluginMethod
  public void setPreference(PluginCall call) {
    submit(call, store -> {
      Map<String, Object> value = arguments(call, "projectId", "policy");
      Map<String, Object> policy =
        value.get("policy") == null ? null : BackupModel.policy(value.get("policy"));
      return mutate(store, target -> target.setPreference(id(value.get("projectId")), policy));
    });
  }

  @PluginMethod
  public void setDefaults(PluginCall call) {
    submit(call, store -> {
      Map<String, Object> policy = BackupModel.policy(arguments(call, "policy").get("policy"));
      return mutate(store, target -> target.setDefaults(policy));
    });
  }

  @PluginMethod
  public void rotate(PluginCall call) {
    submit(call, store -> {
      String projectId = id(arguments(call, "projectId").get("projectId"));
      return mutate(store, target -> {
        target.rotate(projectId);
        return null;
      });
    });
  }

  @PluginMethod
  public void cleanupIncomplete(PluginCall call) {
    submit(call, store -> {
      Map<String, Object> value = arguments(call, "projectId", "backupId");
      return mutate(store, target -> {
        target.cleanupIncomplete(id(value.get("projectId")), id(value.get("backupId")));
        return null;
      });
    });
  }

  @PluginMethod
  public void deleteBackup(PluginCall call) {
    submit(call, store -> {
      Map<String, Object> value = arguments(call, "projectId", "backupId");
      return mutate(store, target -> {
        target.deleteBackup(id(value.get("projectId")), id(value.get("backupId")));
        return null;
      });
    });
  }

  @PluginMethod
  public void deleteGameBackups(PluginCall call) {
    submit(call, store -> {
      Map<String, Object> value = arguments(call, "projectId");
      return mutate(store, target -> {
        target.deleteGameBackups(id(value.get("projectId")));
        return null;
      });
    });
  }

  @Override
  protected void handleOnDestroy() {
    isDestroyed = true;
    controls.shutdownNow();
  }
}
