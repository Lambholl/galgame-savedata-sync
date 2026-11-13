package io.github.galgame.savedatasync;

import android.content.Context;
import android.os.CancellationSignal;
import java.io.Closeable;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * 以已枚举的目录文件作为归档的读取源，只使用已有授权；查询和打开必须在后台工作线程调用。
 *
 * <p>控制器取消时同时取消提供者查询并关闭读流。
 */
final class DirectoryArchiveSource implements ArchiveModel.Source {

  private final DirectoryStore store;
  private final String rootId;
  private final String entryId;

  DirectoryArchiveSource(DirectoryStore store, String rootId, String entryId)
    throws ArchiveFailure {
    ArchiveModel.require(
      store != null && DocumentValues.isId(rootId) && DocumentValues.isId(entryId)
    );
    this.store = store;
    this.rootId = rootId;
    this.entryId = entryId;
  }

  /**
   * 创建以应用私有缓存目录为缓存的归档适配器。
   *
   * @throws IOException 缓存目录的真实路径解析失败。
   */
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
