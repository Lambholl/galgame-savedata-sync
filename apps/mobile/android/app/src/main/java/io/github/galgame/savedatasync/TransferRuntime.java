package io.github.galgame.savedatasync;

import android.content.Context;

/** 进程内共享的拨号方连接引擎。 */
final class TransferRuntime {

  private static TransferRuntime instance;
  final TransferEngine engine;

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
    DirectoryStore store = DirectoryRuntime.store(context);
    engine = new TransferEngine(
      DirectoryArchiveSource.createAdapter(context),
      new TransferEngine.Local() {
        @Override
        public String deviceId() {
          return store.deviceId();
        }

        @Override
        public boolean hasListenerPeer() {
          ListenerRuntime listener = ListenerRuntime.peek();
          return listener != null && listener.hasPeer();
        }
      }
    );
  }
}
