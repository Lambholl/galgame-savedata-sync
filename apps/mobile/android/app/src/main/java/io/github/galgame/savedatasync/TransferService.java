package io.github.galgame.savedatasync;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/** 保持用户已发起的传输运行的前台服务；Activity 暂停不取消任务。 */
public class TransferService extends Service {

  static final String CHANNEL = "active-file-transfers";
  static final int NOTIFICATION_ID = 101;
  private static final String BEGIN = "io.github.galgame.savedatasync.TRANSFER_BEGIN";
  private static final String CANCEL = "io.github.galgame.savedatasync.TRANSFER_CANCEL";
  private static final String RETRY = "io.github.galgame.savedatasync.TRANSFER_RETRY";
  private static CompletableFuture<Void> startup;
  private static volatile boolean isRunning;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private TransferRuntime runtime;
  private int lastStartId;

  static void prepareChannel(Context context) {
    Context localized = AppPreferencesPlugin.localizedContext(context);
    String name = localized.getString(R.string.transfer_channel);
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
    if (channel == null || !name.contentEquals(channel.getName())) {
      manager.createNotificationChannel(
        new NotificationChannel(CHANNEL, name, NotificationManager.IMPORTANCE_LOW)
      );
    }
  }

  static boolean notificationsAllowed(Context context) {
    prepareChannel(context);
    if (
      Build.VERSION.SDK_INT >= 33 &&
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
        PackageManager.PERMISSION_GRANTED
    ) {
      return false;
    }
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    return (
      manager.areNotificationsEnabled() &&
      manager.getNotificationChannel(CHANNEL).getImportance() != NotificationManager.IMPORTANCE_NONE
    );
  }

  static synchronized CompletableFuture<Void> launch(Context context) throws Exception {
    if (startup != null && !startup.isDone()) {
      throw TransferJson.fail("busy");
    }
    startup = new CompletableFuture<>();
    try {
      context.startForegroundService(new Intent(context, TransferService.class).setAction(BEGIN));
    } catch (Exception cause) {
      startup.completeExceptionally(cause);
      throw cause;
    }
    return startup;
  }

  static boolean isRunning() {
    return isRunning;
  }

  private static synchronized void ready(Exception failure) {
    if (startup != null) {
      if (failure == null) {
        startup.complete(null);
      } else {
        startup.completeExceptionally(failure);
      }
    }
  }

  @Override
  public void onCreate() {
    super.onCreate();
    prepareChannel(this);
    try {
      runtime = TransferRuntime.get(this);
    } catch (Exception cause) {
      ready(cause);
      stopSelf();
    }
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    lastStartId = startId;
    if (runtime == null || intent == null) {
      stopSelf();
      return START_NOT_STICKY;
    }
    String action = intent.getAction();
    String id = intent.getStringExtra("transferId");
    try {
      startForeground(
        NOTIFICATION_ID,
        notification(),
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      );
      isRunning = true;
      ready(null);
      SyncTransferRuntime sync = SyncTransferRuntime.peek();
      if (CANCEL.equals(action)) {
        if (sync != null && sync.busy()) {
          sync.cancel(id, false);
        } else {
          runtime.cancel(id, false);
        }
      } else if (RETRY.equals(action)) {
        if (sync != null && sync.busy()) {
          sync.retry(id);
        } else {
          runtime.retry(id);
        }
      }
      handler.removeCallbacks(refresh);
      handler.postDelayed(refresh, 300);
    } catch (Exception cause) {
      ready(cause);
      stopSelf();
    }
    return START_NOT_STICKY;
  }

  private final Runnable refresh = new Runnable() {
    @Override
    public void run() {
      SyncTransferRuntime sync = SyncTransferRuntime.peek();
      if ((runtime == null || !runtime.busy()) && (sync == null || !sync.busy())) {
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelfResult(lastStartId);
        return;
      }
      getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification());
      handler.postDelayed(this, 500);
    }
  };

  @SuppressWarnings("unchecked")
  private Notification notification() {
    Context localized = AppPreferencesPlugin.localizedContext(this);
    prepareChannel(localized);
    SyncTransferRuntime sync = SyncTransferRuntime.peek();
    Map<String, Object> state =
      sync != null && sync.busy() ? sync.notice() : runtime == null ? null : runtime.notice();
    String id = state == null ? null : (String) state.get("transferId");
    boolean isUpload = state != null && Boolean.TRUE.equals(state.get("upload"));
    boolean isActive = state == null || Boolean.TRUE.equals(state.get("running"));
    String stage = state == null ? "preparing" : (String) state.get("stage");
    int textResource;
    switch (stage) {
      case "ready":
        textResource = R.string.transfer_stage_ready;
        break;
      case "awaiting-content":
        textResource = R.string.transfer_stage_awaiting_content;
        break;
      case "transferring":
        textResource = R.string.transfer_stage_transferring;
        break;
      case "verifying":
        textResource = R.string.transfer_stage_verifying;
        break;
      case "publishing":
      case "writing":
        textResource = R.string.transfer_stage_writing;
        break;
      case "backing-up":
        textResource = R.string.transfer_stage_backing_up;
        break;
      case "cleaning":
        textResource = R.string.transfer_stage_cleaning;
        break;
      case "done":
        textResource = R.string.transfer_stage_done;
        break;
      case "sent":
        textResource = R.string.transfer_stage_sent;
        break;
      default:
        textResource = R.string.transfer_stage_preparing;
    }
    if (!isActive) {
      textResource = R.string.transfer_cleanup_pending;
    }
    Intent open = new Intent(this, MainActivity.class)
      .setAction(Intent.ACTION_MAIN)
      .addCategory(Intent.CATEGORY_LAUNCHER)
      .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    Notification.Builder builder = new Notification.Builder(localized, CHANNEL)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle(
        localized.getString(
          isUpload ? R.string.transfer_title_sending : R.string.transfer_title_receiving,
          localized.getString(R.string.app_name)
        )
      )
      .setContentText(localized.getString(textResource))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setContentIntent(
        PendingIntent.getActivity(
          this,
          0,
          open,
          PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        )
      );
    if (id != null) {
      Intent action = new Intent(this, TransferService.class)
        .setAction(isActive ? CANCEL : RETRY)
        .putExtra("transferId", id)
        .setData(Uri.parse("savedata-sync://transfer/" + id + (isActive ? "/cancel" : "/retry")));
      builder.addAction(
        new Notification.Action.Builder(
          null,
          localized.getString(
            isActive ? R.string.transfer_cancel : R.string.transfer_retry_cleanup
          ),
          PendingIntent.getService(
            this,
            0,
            action,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
          )
        ).build()
      );
    }
    Map<String, Object> progress =
      state == null || !(state.get("progress") instanceof Map)
        ? null
        : (Map<String, Object>) state.get("progress");
    Long completed = null;
    Long total = null;
    if (progress != null) {
      String doneKey = stage.equals("transferring")
        ? "archiveBytesTransferred"
        : stage.equals("verifying")
          ? "fileBytesVerified"
          : stage.equals("publishing") || stage.equals("writing")
            ? "publishedFiles"
            : "sourceBytesRead";
      String totalKey = stage.equals("transferring")
        ? "totalArchiveBytes"
        : stage.equals("publishing") || stage.equals("writing")
          ? "totalFiles"
          : "totalFileBytes";
      completed = ((Number) progress.get(doneKey)).longValue();
      if (progress.get(totalKey) instanceof Number) {
        total = ((Number) progress.get(totalKey)).longValue();
      }
    }
    if (
      isActive && !stage.equals("backing-up") && total != null && total > 0 && completed != null
    ) {
      builder.setProgress(100, (int) Math.min(100, (completed * 100) / total), false);
    } else {
      builder.setProgress(0, 0, isActive);
    }
    return builder.build();
  }

  /** 系统 dataSync 期限到时按实际中止反馈；已停止的传输不会重启。 */
  @Override
  public void onTimeout(int startId, int foregroundServiceType) {
    SyncTransferRuntime sync = SyncTransferRuntime.peek();
    if (sync != null && sync.busy()) {
      sync.cancel(sync.engine.activeId(), true);
    } else if (runtime != null) {
      runtime.cancel(runtime.engine.activeId(), true);
    }
    stopForeground(STOP_FOREGROUND_REMOVE);
    stopSelf();
  }

  @Override
  public void onDestroy() {
    isRunning = false;
    handler.removeCallbacksAndMessages(null);
    if (runtime != null && runtime.busy()) {
      runtime.cancel(runtime.engine.activeId(), false);
    }
    SyncTransferRuntime sync = SyncTransferRuntime.peek();
    if (sync != null && sync.busy()) {
      sync.cancel(sync.engine.activeId(), false);
    }
    ready(new IllegalStateException("The foreground transfer service has ended."));
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
