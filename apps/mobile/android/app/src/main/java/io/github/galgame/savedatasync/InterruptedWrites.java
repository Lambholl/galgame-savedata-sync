package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.bytes;
import static io.github.galgame.savedatasync.TransferJson.object;
import static io.github.galgame.savedatasync.TransferJson.parse;
import static io.github.galgame.savedatasync.TransferSchema.directory;
import static io.github.galgame.savedatasync.TransferSchema.id;
import static io.github.galgame.savedatasync.TransferSchema.number;
import static io.github.galgame.savedatasync.TransferSchema.parent;
import static io.github.galgame.savedatasync.TransferSchema.require;
import static io.github.galgame.savedatasync.TransferSchema.shape;

import android.content.Context;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 目标目录写入的中断标记：begin 创建标记并落盘，end 删除标记，list 返回被中断的写入。
 *
 * <p>本进程所有实例共享正在写的标记集合，list 不返回这些标记。
 */
final class InterruptedWrites {

  private static final int LIMIT = 16;
  // 复制和恢复各有一个实例，正在写的标记要在实例之间共享。
  private static final Set<String> active = ConcurrentHashMap.newKeySet();
  private final File directory;

  InterruptedWrites(Context context) {
    directory = new File(context.getApplicationContext().getFilesDir(), "interrupted-writes");
  }

  private File file(String writeId) throws Exception {
    return new File(directory, id(writeId) + ".json");
  }

  /**
   * 为一次写入创建标记并落盘。
   *
   * @throws Exception 标记没能落盘。
   */
  void begin(String writeId, String projectId, String rootId, Object backupId) throws Exception {
    if (!directory.isDirectory() && !directory.mkdirs()) {
      throw new ArchiveFailure("io-failure", "The write marker directory could not be created.");
    }
    File file = file(writeId);
    active.add(writeId);
    try (FileOutputStream output = new FileOutputStream(file)) {
      output.write(
        bytes(
          object(
            "id",
            writeId,
            "projectId",
            projectId,
            "rootId",
            rootId,
            "backupId",
            backupId,
            "startedAt",
            System.currentTimeMillis()
          )
        )
      );
      output.getFD().sync();
    } catch (Exception cause) {
      end(writeId);
      throw cause;
    }
  }

  /** 删除一次写入的标记；删除失败时忽略。 */
  void end(String writeId) {
    try {
      Files.deleteIfExists(file(writeId).toPath());
    } catch (Exception ignored) {
      /* 只会多提示一次。 */
    }
    active.remove(writeId);
  }

  /** 返回之前进程留下的标记，最早的在前；读不懂的标记文件会被删除。 */
  List<Object> list() {
    File[] files = directory.listFiles();
    if (files == null) {
      return new ArrayList<>();
    }
    Arrays.sort(files, Comparator.comparingLong(File::lastModified));
    List<Object> writes = new ArrayList<>();
    for (File file : files) {
      String name = file.getName();
      String writeId = name.endsWith(".json") ? name.substring(0, name.length() - 5) : name;
      if (active.contains(writeId) || writes.size() >= LIMIT) {
        continue;
      }
      try {
        Map<String, Object> value = shape(
          parse(Files.readAllBytes(file.toPath())),
          "id",
          "projectId",
          "rootId",
          "backupId",
          "startedAt"
        );
        require(writeId.equals(id(value.get("id"))));
        id(value.get("projectId"));
        id(value.get("rootId"));
        parent(value.get("backupId"));
        number(value.get("startedAt"), Long.MIN_VALUE, Long.MAX_VALUE);
        writes.add(value);
      } catch (Exception invalid) {
        file.delete();
      }
    }
    return writes;
  }

  void dismiss(String writeId) throws Exception {
    if (active.contains(writeId)) {
      return;
    }
    Files.deleteIfExists(file(writeId).toPath());
  }
}
