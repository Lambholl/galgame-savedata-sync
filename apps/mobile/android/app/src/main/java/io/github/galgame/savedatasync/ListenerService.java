package io.github.galgame.savedatasync;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import java.util.concurrent.CompletableFuture;

/**
 * 本机服务开着时保持进程的前台服务（connectedDevice）。常驻通知显示服务地址和当前连接，带“停止”操作；服务一直运行到
 * {@link #finish} 被调用或用户点“停止”。
 */
public class ListenerService extends Service {

  static final String CHANNEL = "local-service";
  static final int NOTIFICATION_ID = 102;
  private static final String BEGIN = "io.github.galgame.savedatasync.LISTENER_BEGIN";
  private static final String STOP = "io.github.galgame.savedatasync.LISTENER_STOP";
  private static CompletableFuture<Void> startup;

  static void prepareChannel(Context context) {
    Context localized = AppPreferencesPlugin.localizedContext(context);
    String name = localized.getString(R.string.service_channel);
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
    if (channel == null || !name.contentEquals(channel.getName())) {
      manager.createNotificationChannel(
        new NotificationChannel(CHANNEL, name, NotificationManager.IMPORTANCE_LOW)
      );
    }
  }

  /**
   * 启动前台服务。
   *
   * @return 服务进入前台后完成；系统拒绝启动或进入前台时以异常完成。
   */
  static synchronized CompletableFuture<Void> launch(Context context) {
    startup = new CompletableFuture<>();
    try {
      context.startForegroundService(new Intent(context, ListenerService.class).setAction(BEGIN));
    } catch (RuntimeException cause) {
      startup.completeExceptionally(cause);
    }
    return startup;
  }

  /** 停止前台服务并移除通知。 */
  static void finish(Context context) {
    context.stopService(new Intent(context, ListenerService.class));
  }

  /** 服务在运行时按本机服务的当前状态刷新通知。 */
  static void refresh(Context context) {
    ListenerRuntime runtime = ListenerRuntime.peek();
    if (runtime != null && runtime.isRunning()) {
      context
        .getSystemService(NotificationManager.class)
        .notify(NOTIFICATION_ID, notification(context, runtime));
    }
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
  public int onStartCommand(Intent intent, int flags, int startId) {
    ListenerRuntime runtime = ListenerRuntime.peek();
    try {
      // 进入前台必须先做，否则系统会因为 startForegroundService 后没有及时进入前台而结束进程。
      startForeground(
        NOTIFICATION_ID,
        notification(this, runtime),
        ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
      );
    } catch (RuntimeException cause) {
      ready(cause);
      stopSelf();
      return START_NOT_STICKY;
    }
    ready(null);
    if (intent != null && STOP.equals(intent.getAction())) {
      if (runtime != null) {
        runtime.stop();
      }
    } else if (runtime == null || !runtime.isRunning()) {
      stopForeground(STOP_FOREGROUND_REMOVE);
      stopSelf();
    }
    // 进程被系统结束后不让系统重启服务：重启时没有 ListenerRuntime，服务会被直接停掉。开关开着时由
    // LocalServicePlugin 在应用回到前台时重新启动。
    return START_NOT_STICKY;
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  private static Notification notification(Context context, ListenerRuntime runtime) {
    Context localized = AppPreferencesPlugin.localizedContext(context);
    prepareChannel(context);
    String address = runtime == null ? null : runtime.recommendedAddress();
    String peer = runtime == null ? null : runtime.peerName();
    String text =
      address == null
        ? localized.getString(R.string.service_no_address)
        : localized.getString(
            peer == null ? R.string.service_waiting : R.string.service_connected,
            address,
            peer
          );
    Intent open = new Intent(context, MainActivity.class)
      .setAction(Intent.ACTION_MAIN)
      .addCategory(Intent.CATEGORY_LAUNCHER)
      .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    Intent stop = new Intent(context, ListenerService.class).setAction(STOP);
    return new Notification.Builder(localized, CHANNEL)
      .setSmallIcon(android.R.drawable.presence_online)
      .setContentTitle(
        localized.getString(R.string.service_title, localized.getString(R.string.app_name))
      )
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setContentIntent(
        PendingIntent.getActivity(
          context,
          1,
          open,
          PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        )
      )
      .addAction(
        new Notification.Action.Builder(
          null,
          localized.getString(R.string.service_stop),
          PendingIntent.getService(
            context,
            1,
            stop,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
          )
        ).build()
      )
      .build();
  }
}
