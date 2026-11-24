package io.github.galgame.savedatasync;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 调试版的诊断入口：接收 adb 发来的显式广播，输出本机服务、连接和传输任务的状态，或开关故障注入。
 *
 * <p>extra {@code command} 取 status、space、slow-write、drop、reset。space 和 slow-write 另需 {@code
 * area}（{@link FaultInjection#AREAS} 之一）和 {@code value}（字节数或毫秒数，off 表示关闭）。结果是一个 JSON
 * 对象，既写进广播的结果数据，也以 {@link #TAG} 写入 logcat；命令无效时对象里只有 error。
 */
public final class DebugDiagnostics extends BroadcastReceiver {

  /** 写入 logcat 时用的标签。 */
  public static final String TAG = "SavedataDiag";
  // logcat 单条约 4 KB 上限，长结果分段输出。
  private static final int LOG_CHUNK = 3000;
  // 读取状态要等运行时的锁，不能占着主线程。
  private static final ExecutorService WORKER = Executors.newSingleThreadExecutor(runnable -> {
    Thread thread = new Thread(runnable, "debug-diagnostics");
    thread.setDaemon(true);
    return thread;
  });

  @Override
  public void onReceive(Context context, Intent intent) {
    PendingResult pending = goAsync();
    WORKER.execute(() -> {
      String text;
      try {
        text = new String(TransferJson.bytes(handle(intent)), StandardCharsets.UTF_8);
      } catch (Exception failure) {
        text = "{\"error\":\"" + failure.getClass().getSimpleName() + "\"}";
      }
      for (int start = 0; start < text.length(); start += LOG_CHUNK) {
        Log.i(TAG, text.substring(start, Math.min(text.length(), start + LOG_CHUNK)));
      }
      pending.setResultData(text);
      pending.finish();
    });
  }

  private static Map<String, Object> handle(Intent intent) {
    String command = String.valueOf(intent.getStringExtra("command"));
    try {
      switch (command) {
        case "status":
          return status();
        case "space":
          FaultInjection.setAvailableBytes(intent.getStringExtra("area"), value(intent));
          return FaultInjection.state();
        case "slow-write":
          FaultInjection.setWriteDelay(intent.getStringExtra("area"), value(intent));
          return FaultInjection.state();
        case "drop":
          return TransferJson.object("droppedConnections", FaultInjection.dropConnections());
        case "reset":
          FaultInjection.reset();
          return FaultInjection.state();
        default:
          return TransferJson.object("error", "Unknown command: " + command);
      }
    } catch (IllegalArgumentException invalid) {
      return TransferJson.object("error", invalid.getMessage());
    }
  }

  private static Long value(Intent intent) {
    String text = intent.getStringExtra("value");
    if ("off".equals(text)) {
      return null;
    }
    try {
      long value = Long.parseLong(String.valueOf(text));
      if (value < 0) {
        throw new IllegalArgumentException("value must not be negative: " + text);
      }
      return value;
    } catch (NumberFormatException invalid) {
      throw new IllegalArgumentException("value must be a number or off: " + text);
    }
  }

  private static Map<String, Object> status() {
    return TransferJson.object(
      "faults",
      FaultInjection.state(),
      "isTargetBusy",
      TargetOperation.hasWork(),
      "listener",
      listener(),
      "dialer",
      dialer(),
      "transfer",
      transfer()
    );
  }

  // 下面三项各自取状态，一项失败时只在这一项写 error，不影响其他项。

  private static Object listener() {
    ListenerRuntime runtime = ListenerRuntime.peek();
    if (runtime == null) {
      return null;
    }
    try {
      List<Object> peers = new ArrayList<>();
      for (Object item : runtime.peers()) {
        Map<String, Object> peer = TransferJson.map(item);
        peers.add(
          TransferJson.object(
            "deviceId",
            peer.get("deviceId"),
            "name",
            peer.get("name"),
            "isOpen",
            peer.get("isOpen")
          )
        );
      }
      return TransferJson.object("status", runtime.status(), "peers", peers);
    } catch (Exception failure) {
      return errorOf(failure);
    }
  }

  private static Object dialer() {
    TransferRuntime runtime = TransferRuntime.peek();
    if (runtime == null) {
      return null;
    }
    try {
      return TransferJson.object(
        "connections",
        runtime.engine.connections(),
        "controls",
        runtime.engine.controlStates()
      );
    } catch (Exception failure) {
      return errorOf(failure);
    }
  }

  private static Object transfer() {
    SyncTransferRuntime runtime = SyncTransferRuntime.peek();
    if (runtime == null) {
      return null;
    }
    try {
      String active = runtime.activeId();
      return TransferJson.object(
        "activeId",
        active,
        "isBusy",
        runtime.busy(),
        "notice",
        runtime.notice(),
        "job",
        active == null ? null : runtime.query(active, false)
      );
    } catch (Exception failure) {
      return errorOf(failure);
    }
  }

  private static Map<String, Object> errorOf(Exception failure) {
    String code =
      failure instanceof ArchiveFailure
        ? ((ArchiveFailure) failure).code
        : failure.getClass().getSimpleName();
    return TransferJson.object("error", code);
  }
}
