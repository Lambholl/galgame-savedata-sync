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

/** 仅保持用户已经发起的传输；不自动创建任务、不随 Activity 暂停取消、不重启旧任务。 */
public class TransferService extends Service {
    static final String CHANNEL = "active-file-transfers";
    static final int NOTIFICATION_ID = 101;
    private static final String BEGIN = "io.github.galgame.savedatasync.TRANSFER_BEGIN";
    private static final String CANCEL = "io.github.galgame.savedatasync.TRANSFER_CANCEL";
    private static final String RETRY = "io.github.galgame.savedatasync.TRANSFER_RETRY";
    private static CompletableFuture<Void> startup;
    private static volatile boolean running;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private TransferRuntime runtime;
    private int lastStartId;
    static void prepareChannel(Context context) {
        context.getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL, "文件传输", NotificationManager.IMPORTANCE_LOW));
    }
    static boolean notificationsAllowed(Context context) {
        prepareChannel(context);
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        return manager.areNotificationsEnabled() && manager.getNotificationChannel(CHANNEL).getImportance() != NotificationManager.IMPORTANCE_NONE;
    }
    static synchronized CompletableFuture<Void> launch(Context context) throws Exception {
        if (startup != null && !startup.isDone()) throw TransferJson.fail("busy");
        startup = new CompletableFuture<>();
        try { context.startForegroundService(new Intent(context, TransferService.class).setAction(BEGIN)); }
        catch (Exception cause) { startup.completeExceptionally(cause); throw cause; }
        return startup;
    }
    static boolean isRunning() { return running; }
    private static synchronized void ready(Exception failure) {
        if (startup != null) { if (failure == null) startup.complete(null); else startup.completeExceptionally(failure); }
    }
    @Override public void onCreate() {
        super.onCreate(); prepareChannel(this);
        try { runtime = TransferRuntime.get(this); }
        catch (Exception cause) { ready(cause); stopSelf(); }
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        lastStartId = startId;
        if (runtime == null || intent == null) { stopSelf(); return START_NOT_STICKY; }
        String action = intent.getAction(), id = intent.getStringExtra("transferId");
        try {
            startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            running = true; ready(null);
            if (CANCEL.equals(action)) runtime.cancel(id, false);
            else if (RETRY.equals(action)) runtime.retry(id);
            handler.removeCallbacks(refresh); handler.postDelayed(refresh, 300);
        } catch (Exception cause) { ready(cause); stopSelf(); }
        return START_NOT_STICKY;
    }
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            if (runtime == null || !runtime.busy()) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelfResult(lastStartId); return; }
            getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification());
            handler.postDelayed(this, 500);
        }
    };
    @SuppressWarnings("unchecked")
    private Notification notification() {
        Map<String, Object> state = runtime == null ? null : runtime.notice();
        String id = state == null ? null : (String) state.get("transferId");
        boolean upload = state != null && Boolean.TRUE.equals(state.get("upload"));
        boolean active = state == null || Boolean.TRUE.equals(state.get("running"));
        String stage = state == null ? "preparing" : (String) state.get("stage");
        String text;
        switch (stage) {
            case "transferring": text = "正在传输"; break;
            case "verifying": text = "正在校验接收内容"; break;
            case "publishing": text = "正在保存并回读校验"; break;
            case "cleaning": text = "正在清理本次资源"; break;
            case "sent": text = "已发送，正在确认电脑接收结果"; break;
            default: text = "正在准备传输";
        }
        if (!active) text = "本次资源尚未完成清理";
        Intent open = new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        Notification.Builder builder = new Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(upload ? "存档同步：发送文件" : "存档同步：接收文件").setContentText(text)
            .setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_PROGRESS)
            .setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        if (id != null) {
            Intent action = new Intent(this, TransferService.class).setAction(active ? CANCEL : RETRY).putExtra("transferId", id)
                .setData(Uri.parse("savedata-sync://transfer/" + id + (active ? "/cancel" : "/retry")));
            builder.addAction(new Notification.Action.Builder(null, active ? "取消传输" : "重试清理",
                PendingIntent.getService(this, 0, action, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)).build());
        }
        Map<String, Object> progress = state == null || !(state.get("progress") instanceof Map) ? null : (Map<String, Object>) state.get("progress");
        Long completed = null, total = null;
        if (progress != null) {
            String doneKey = stage.equals("transferring") ? "archiveBytesTransferred" : stage.equals("verifying") ? "fileBytesVerified" :
                stage.equals("publishing") ? "publishedFiles" : "sourceBytesRead";
            String totalKey = stage.equals("transferring") ? "totalArchiveBytes" : stage.equals("publishing") ? "totalFiles" : "totalFileBytes";
            completed = ((Number) progress.get(doneKey)).longValue();
            if (progress.get(totalKey) instanceof Number) total = ((Number) progress.get(totalKey)).longValue();
        }
        if (active && total != null && total > 0 && completed != null) builder.setProgress(100, (int) Math.min(100, completed * 100 / total), false);
        else builder.setProgress(0, 0, active);
        return builder.build();
    }
    /** 系统 dataSync 期限按实际中止反馈；不会重启已停止的传输。 */
    @Override public void onTimeout(int startId, int foregroundServiceType) {
        if (runtime != null) runtime.cancel(runtime.engine.activeId(), true);
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
    }
    @Override public void onDestroy() {
        running = false; handler.removeCallbacksAndMessages(null);
        if (runtime != null && runtime.busy()) runtime.cancel(runtime.engine.activeId(), false);
        ready(new IllegalStateException("前台传输服务已结束")); super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
