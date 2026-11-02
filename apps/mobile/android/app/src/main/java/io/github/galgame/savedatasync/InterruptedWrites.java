package io.github.galgame.savedatasync;

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
import static io.github.galgame.savedatasync.TransferJson.*;
import static io.github.galgame.savedatasync.TransferSchema.*;

/**
 * 写入标记：开始写目标目录前落盘，写入结束时删除。上一个进程留下的标记说明那次写入被中断。
 * 本进程正在写的标记不算中断，用静态集合排除，因为复制和恢复各有一个 SyncWriter。
 */
final class InterruptedWrites {
    private static final int LIMIT = 16;
    private static final Set<String> active = ConcurrentHashMap.newKeySet();
    private final File directory;
    InterruptedWrites(Context context) { directory = new File(context.getApplicationContext().getFilesDir(), "interrupted-writes"); }
    private File file(String writeId) throws Exception { return new File(directory, id(writeId) + ".json"); }
    /** 落盘失败时抛出，调用者不再写目标，避免写入中断后没有提示。 */
    void begin(String writeId, String projectId, String rootId, Object backupId) throws Exception {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new ArchiveFailure("io-failure", "The write marker directory could not be created.");
        File file = file(writeId); active.add(writeId);
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(bytes(object("id", writeId, "projectId", projectId, "rootId", rootId, "backupId", backupId, "startedAt", System.currentTimeMillis())));
            output.getFD().sync();
        } catch (Exception cause) { end(writeId); throw cause; }
    }
    /** 写入结束时调用。删除失败只会多提示一次，不影响已核实的写入结果。 */
    void end(String writeId) {
        try { Files.deleteIfExists(file(writeId).toPath()); } catch (Exception ignored) { /* 只会多提示一次。 */ }
        active.remove(writeId);
    }
    /** 上个进程留下的标记，最早的在前；读不懂的文件直接删除。 */
    List<Object> list() {
        File[] files = directory.listFiles();
        if (files == null) return new ArrayList<>();
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        List<Object> writes = new ArrayList<>();
        for (File file : files) {
            String name = file.getName(), writeId = name.endsWith(".json") ? name.substring(0, name.length() - 5) : name;
            if (active.contains(writeId) || writes.size() >= LIMIT) continue;
            try {
                Map<String, Object> value = shape(parse(Files.readAllBytes(file.toPath())), "id", "projectId", "rootId", "backupId", "startedAt");
                require(writeId.equals(id(value.get("id")))); id(value.get("projectId")); id(value.get("rootId")); parent(value.get("backupId"));
                number(value.get("startedAt"), Long.MIN_VALUE, Long.MAX_VALUE);
                writes.add(value);
            } catch (Exception invalid) { file.delete(); }
        }
        return writes;
    }
    void dismiss(String writeId) throws Exception {
        if (active.contains(writeId)) return;
        Files.deleteIfExists(file(writeId).toPath());
    }
}
