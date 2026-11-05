package io.github.galgame.savedatasync;

import android.content.Context;
import android.os.CancellationSignal;
import java.io.Closeable;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * 把已枚举的 SAF 引用接入归档模块；参数不含 URI 和路径，也不申请新授权。
 * 查询和打开必须在后台工作线程调用。控制器取消时同时取消提供者查询并关闭读流；
 * 流关闭后注销信号，所有权由 prepare 的工作线程回收。
 */
final class SafArchiveSource implements ArchiveModel.Source {

  private final SafDirectoryStore store;
  private final String rootId;
  private final String entryId;

  SafArchiveSource(SafDirectoryStore store, String rootId, String entryId) throws ArchiveFailure {
    ArchiveModel.require(store != null && SafValues.isId(rootId) && SafValues.isId(entryId));
    this.store = store;
    this.rootId = rootId;
    this.entryId = entryId;
  }

  /** 创建使用应用私有缓存的归档适配器；文件字节都留在原生层。 */
  static ArchiveAdapter createAdapter(Context context) throws IOException {
    // Android 的 /data/user/0 可能是系统别名，所以先解析真实路径；
    // 缓存管理器仍拒绝真实根以下的链接和归属变化。
    return new ArchiveAdapter(
      new ArchiveCache(context.getApplicationContext().getCacheDir().getCanonicalFile().toPath())
    );
  }

  @Override
  public ArchiveModel.Observation observe(ArchiveControl control) throws Exception {
    CancellationSignal signal = new CancellationSignal();
    Closeable cancellation = control.track((Closeable) signal::cancel);
    try {
      control.check();
      return store.archiveObservation(rootId, entryId, signal);
    } finally {
      control.untrack(cancellation);
    }
  }

  @Override
  public void validateRoot(String batchRootId) throws ArchiveFailure {
    ArchiveModel.require(rootId.equals(batchRootId));
  }

  @Override
  public InputStream open(ArchiveControl control) throws Exception {
    CancellationSignal signal = new CancellationSignal();
    Closeable cancellation = control.track((Closeable) signal::cancel);
    try {
      InputStream input = store.openFile(rootId, entryId, signal);
      return new FilterInputStream(input) {
        @Override
        public void close() throws IOException {
          try {
            super.close();
          } finally {
            control.untrack(cancellation);
          }
        }
      };
    } catch (Exception failure) {
      control.untrack(cancellation);
      throw failure;
    }
  }
}
