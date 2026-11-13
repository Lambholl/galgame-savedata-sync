package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.copy;
import static io.github.galgame.savedatasync.TransferJson.fail;
import static io.github.galgame.savedatasync.TransferJson.list;
import static io.github.galgame.savedatasync.TransferJson.map;
import static io.github.galgame.savedatasync.TransferJson.object;
import static io.github.galgame.savedatasync.TransferSchema.id;
import static io.github.galgame.savedatasync.TransferSchema.selection;
import static io.github.galgame.savedatasync.TransferSchema.shape;
import static io.github.galgame.savedatasync.TransferSchema.string;
import static io.github.galgame.savedatasync.TransferSchema.targets;

import android.content.Context;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** 进程内共享的批量传输引擎；任务只保存在内存里。 */
final class TransferRuntime {

  private static TransferRuntime instance;
  final TransferEngine engine;
  final NewFilePublisher publisher;
  private final Context context;
  private final ExecutorService controls = Executors.newSingleThreadExecutor();
  private final List<WeakReference<TransferEngine.Listener>> listeners =
    new CopyOnWriteArrayList<>();
  private volatile boolean isStarting;
  private volatile String pendingId;
  private volatile boolean isUploadPending;

  static synchronized TransferRuntime get(Context context) throws Exception {
    if (instance == null) {
      instance = new TransferRuntime(context.getApplicationContext());
    }
    return instance;
  }

  static synchronized TransferRuntime peek() {
    return instance;
  }

  private TransferRuntime(Context context) throws Exception {
    this.context = context;
    DirectoryStore store = DirectoryRuntime.store(context);
    publisher = new NewFilePublisher(new DirectoryPublicationBackend(context, store));
    engine = new TransferEngine(
      DirectoryArchiveSource.createAdapter(context),
      publisher,
      new TransferEngine.Local() {
        @Override
        public String deviceId() {
          return store.deviceId();
        }

        @Override
        public List<ArchiveModel.Source> sources(String rootId, List<Object> selections)
          throws Exception {
          List<ArchiveModel.Source> result = new ArrayList<>();
          for (Object selection : selections) {
            result.add(
              new DirectoryArchiveSource(store, rootId, string(map(selection).get("entryId")))
            );
          }
          return result;
        }
      },
      value -> {
        for (WeakReference<TransferEngine.Listener> reference : listeners) {
          TransferEngine.Listener listener = reference.get();
          if (listener == null) {
            listeners.remove(reference);
          } else {
            listener.state(value);
          }
        }
      }
    );
  }

  void attach(TransferEngine.Listener listener) {
    listeners.add(new WeakReference<>(listener));
  }

  void detach(TransferEngine.Listener listener) {
    listeners.removeIf(reference -> reference.get() == null || reference.get() == listener);
  }

  Object start(Object options, boolean isUpload) throws Exception {
    Map<String, Object> value = shape(copy(options), "request", "targetRootId", "targets");
    Map<String, Object> request = selection(value.get("request"));
    id(value.get("targetRootId"));
    targets(value.get("targets"), list(request.get("files")).size());
    synchronized (this) {
      if (isStarting || engine.hasWork() || TargetOperation.hasWork()) {
        throw fail("busy");
      }
      if (!TransferService.notificationsAllowed(context)) {
        throw fail("permission-denied");
      }
      isStarting = true;
      pendingId = string(request.get("transferId"));
      isUploadPending = isUpload;
    }
    try {
      // 目录选择已保存系统读写权限；每次接收前重新核实并恢复进程内发布授权。
      if (!isUpload) {
        publisher.grant(string(value.get("targetRootId")));
      }
      // 必须先确认系统已接受前台服务和持续通知，再开始文件/网络任务。
      TransferService.launch(context).get(10, TimeUnit.SECONDS);
      return engine.start(value, isUpload);
    } finally {
      isStarting = false;
    }
  }

  boolean busy() {
    return isStarting || engine.hasWork();
  }

  Map<String, Object> notice() {
    Map<String, Object> value = engine.notice();
    return value == null && isStarting
      ? object(
          "transferId",
          pendingId,
          "upload",
          isUploadPending,
          "running",
          true,
          "stage",
          "preparing",
          "progress",
          null
        )
      : value;
  }

  void cancel(String id, boolean isTimeout) {
    controls.execute(() -> engine.cancelActive(id, isTimeout));
  }

  void retry(String id) {
    controls.execute(() -> {
      if (id != null && id.equals(engine.activeId())) {
        engine.retryCleanup();
      }
    });
  }
}
