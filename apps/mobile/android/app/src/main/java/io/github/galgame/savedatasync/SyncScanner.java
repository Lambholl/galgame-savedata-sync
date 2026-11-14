package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.bytes;
import static io.github.galgame.savedatasync.TransferJson.copy;
import static io.github.galgame.savedatasync.TransferJson.fail;
import static io.github.galgame.savedatasync.TransferJson.map;
import static io.github.galgame.savedatasync.TransferJson.object;
import static io.github.galgame.savedatasync.TransferSchema.error;
import static io.github.galgame.savedatasync.TransferSchema.id;
import static io.github.galgame.savedatasync.TransferSchema.metadata;
import static io.github.galgame.savedatasync.TransferSchema.require;
import static io.github.galgame.savedatasync.TransferSchema.state;
import static io.github.galgame.savedatasync.TransferSchema.string;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 只读扫描的注册表。单个工作线程遍历目录，同一层的文件由一组读线程同时计算哈希；
 * 控制线程取消查询和阻塞读；结果只存在内存里。
 */
final class SyncScanner implements AutoCloseable {

  interface Source {
    String deviceId();

    List<Object> list(String rootId, String parentId, ArchiveControl control) throws Exception;

    ArchiveModel.Source file(String rootId, String entryId) throws Exception;
  }

  static final int MAX_ENTRIES = 10000;
  static final int MAX_DEPTH = 64;
  static final int MAX_PATH = 4096;
  static final int MAX_RESULTS = 32;
  private static final long MAX_SAFE = 9007199254740991L;
  private static final int MEASURE_THREADS = 8;
  private final Source source;
  private final int maxEntries;
  private final long timeoutMillis;
  private final long retentionMillis;
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  // 提供者不报告大小时要读完文件实测。经 SAF 打开一个文件要几十毫秒，同时读几个能快几倍。
  private final ExecutorService measurers = Executors.newFixedThreadPool(MEASURE_THREADS);
  private final ScheduledExecutorService watcher = Executors.newSingleThreadScheduledExecutor();
  private final Map<String, Job> jobs = new LinkedHashMap<>();
  private Job active;
  private boolean isClosed;

  private static final class Job {

    final String id;
    final String rootId;
    final ArchiveControl control;
    final long started = System.nanoTime();
    final List<Object> entries = new ArrayList<>();
    final Set<String> ids = new HashSet<>();
    Map<String, Object> state;
    long ended;
    volatile boolean isCancelled;
    volatile boolean hasTimedOut;

    Job(String rootId, long timeout) {
      this(rootId, timeout, null);
    }

    Job(String rootId, long timeout, ArchiveControl external) {
      id = UUID.randomUUID().toString();
      this.rootId = rootId;
      control =
        external == null
          ? new ArchiveControl(System::nanoTime, TimeUnit.MILLISECONDS.toNanos(timeout))
          : external;
      state = object(
        "schemaVersion",
        1,
        "scanId",
        id,
        "rootId",
        rootId,
        "status",
        "running",
        "scannedEntries",
        0,
        "snapshot",
        null,
        "error",
        null
      );
    }
  }

  SyncScanner(Source source) {
    this(source, MAX_ENTRIES, 1800000, 600000);
  }

  /** 创建扫描器，校验来源和上限：条目数、超时和结果保留期都不能超过默认值。 */
  SyncScanner(Source source, int maxEntries, long timeoutMillis, long retentionMillis) {
    if (
      source == null ||
      !DocumentValues.isId(source.deviceId()) ||
      maxEntries < 1 ||
      maxEntries > MAX_ENTRIES ||
      timeoutMillis < 1 ||
      timeoutMillis > 1800000 ||
      retentionMillis < 1 ||
      retentionMillis > 600000
    ) {
      throw new IllegalArgumentException("Invalid scan source or limits");
    }
    this.source = source;
    this.maxEntries = maxEntries;
    this.timeoutMillis = timeoutMillis;
    this.retentionMillis = retentionMillis;
    watcher.scheduleAtFixedRate(this::tick, 25, 25, TimeUnit.MILLISECONDS);
  }

  /**
   * 开始扫描已授权的根目录。
   *
   * @return 扫描刚开始时的状态，之后的状态用 query 查询。
   * @throws Exception 已有扫描在进行（busy）。
   */
  synchronized Map<String, Object> start(String rootId) throws Exception {
    id(rootId);
    if (isClosed || active != null) {
      throw fail("busy");
    }
    // 结果数量到上限时丢掉最旧的结果：active 为空，最旧的一定已结束，只有最新一次比较的结果才可能被确认。
    purge();
    if (jobs.size() >= MAX_RESULTS) {
      jobs.remove(jobs.keySet().iterator().next());
    }
    Job job = new Job(rootId, timeoutMillis);
    jobs.put(job.id, job);
    active = job;
    try {
      worker.execute(() -> run(job));
    } catch (java.util.concurrent.RejectedExecutionException cause) {
      jobs.remove(job.id);
      active = null;
      throw fail("busy");
    }
    return map(copy(job.state));
  }

  /** 返回公开数据的深拷贝；结果在扫描结束 10 分钟后清除，查询不改变这个期限。 */
  synchronized Map<String, Object> query(String scanId) throws Exception {
    purge();
    return map(copy(find(scanId).state));
  }

  /** 在当前线程同步扫描根目录并返回快照，取消和期限由 control 控制；结果只返回给调用者。 */
  Map<String, Object> snapshotNow(String rootId, ArchiveControl control) throws Exception {
    id(rootId);
    synchronized (this) {
      if (isClosed) {
        throw fail("busy");
      }
    }
    Job job = new Job(rootId, timeoutMillis, control);
    visit(job, null, Collections.emptyList());
    check(job);
    job.entries.sort((a, b) -> comparePath(pathUnchecked(a), pathUnchecked(b)));
    Map<String, Object> result = snapshot(job, null);
    bytes(result);
    return result;
  }

  /** 请求取消并返回当前快照；取消的结束状态要等工作线程关闭源流后才能查到。 */
  Map<String, Object> cancel(String scanId) throws Exception {
    Job job;
    synchronized (this) {
      job = find(scanId);
      if (job == active) {
        job.isCancelled = true;
      }
    }
    if (job.isCancelled) {
      job.control.cancel();
    }
    return query(scanId);
  }

  private Job find(String scanId) throws ArchiveFailure {
    id(scanId);
    Job job = jobs.get(scanId);
    if (job == null) {
      throw fail("not-found");
    }
    return job;
  }

  private synchronized void purge() {
    long now = System.nanoTime();
    jobs
      .values()
      .removeIf(
        job ->
          job != active &&
          job.ended != 0 &&
          now - job.ended >= TimeUnit.MILLISECONDS.toNanos(retentionMillis)
      );
  }

  private void tick() {
    Job timed = null;
    synchronized (this) {
      purge();
      if (
        active != null &&
        System.nanoTime() - active.started >= TimeUnit.MILLISECONDS.toNanos(timeoutMillis)
      ) {
        active.hasTimedOut = true;
        timed = active;
      }
    }
    if (timed != null) {
      timed.control.cancel();
    }
  }

  private void check(Job job) throws Exception {
    if (job.hasTimedOut) {
      throw new ArchiveFailure("timeout", "The current scan timed out.");
    }
    job.control.check();
  }

  private Map<String, Object> snapshot(Job job, Object error) {
    return object(
      "schemaVersion",
      1,
      "scanId",
      job.id,
      "deviceId",
      source.deviceId(),
      "rootId",
      job.rootId,
      "observedAt",
      System.currentTimeMillis(),
      "entries",
      new ArrayList<>(job.entries),
      "error",
      error
    );
  }

  private void run(Job job) {
    Map<String, Object> snapshot = null;
    Map<String, Object> error = null;
    String status = "succeeded";
    try {
      visit(job, null, Collections.emptyList());
      check(job);
      job.entries.sort((a, b) -> comparePath(pathUnchecked(a), pathUnchecked(b)));
      snapshot = snapshot(job, null);
      if (bytes(snapshot).length > TransferJson.MAX_BYTES - 4096) {
        throw fail("resource-limit");
      }
    } catch (Exception cause) {
      if (job.isCancelled) {
        status = "cancelled";
      } else {
        status = "failed";
        String code = job.hasTimedOut
          ? "timeout"
          : cause instanceof ArchiveFailure
            ? ((ArchiveFailure) cause).code
            : "io-failure";
        error = scanError(code);
        snapshot = snapshot(job, error);
        try {
          if (bytes(snapshot).length > TransferJson.MAX_BYTES - 4096) {
            snapshot.put("entries", new ArrayList<>());
          }
        } catch (Exception tooLarge) {
          snapshot.put("entries", new ArrayList<>());
        }
      }
    } finally {
      synchronized (this) {
        job.state = object(
          "schemaVersion",
          1,
          "scanId",
          job.id,
          "rootId",
          job.rootId,
          "status",
          status,
          "scannedEntries",
          job.entries.size(),
          "snapshot",
          snapshot,
          "error",
          error
        );
        job.ended = System.nanoTime();
        active = null;
      }
    }
  }

  @SuppressWarnings("unchecked")
  private static List<String> pathUnchecked(Object entry) {
    return (List<String>) ((Map<String, Object>) entry).get("path");
  }

  private static int comparePath(List<String> a, List<String> b) {
    for (int i = 0; i < Math.min(a.size(), b.size()); i++) {
      int compared = a.get(i).compareTo(b.get(i));
      if (compared != 0) {
        return compared;
      }
    }
    return Integer.compare(a.size(), b.size());
  }

  private static void validatePath(List<String> path) throws ArchiveFailure {
    if (path.isEmpty() || path.size() > MAX_DEPTH) {
      throw fail("resource-limit");
    }
    int length = -1;
    for (String name : path) {
      if (
        name.isEmpty() ||
        name.length() > 255 ||
        name.equals(".") ||
        name.equals("..") ||
        name.indexOf(0) >= 0 ||
        name.indexOf('/') >= 0 ||
        name.indexOf('\\') >= 0
      ) {
        throw fail("name-conflict");
      }
      length += name.length() + 1;
    }
    if (length > MAX_PATH) {
      throw fail("resource-limit");
    }
  }

  private static String listingKey(List<Object> entries) throws Exception {
    List<Object> values = new ArrayList<>();
    for (Object raw : entries) {
      Map<String, Object> entry = metadata(raw);
      values.add(
        object(
          "entryId",
          entry.get("entryId"),
          "name",
          entry.get("name"),
          "kind",
          entry.get("kind"),
          "sizeBytes",
          entry.get("sizeBytes"),
          "modifiedAt",
          entry.get("modifiedAt")
        )
      );
    }
    values.sort((a, b) ->
      ((String) ((Map<?, ?>) a).get("entryId")).compareTo((String) ((Map<?, ?>) b).get("entryId"))
    );
    return new String(bytes(values), java.nio.charset.StandardCharsets.UTF_8);
  }

  private void visit(Job job, String parentId, List<String> parentPath) throws Exception {
    check(job);
    List<Object> before = source.list(job.rootId, parentId, job.control);
    check(job);
    final String key = listingKey(before);
    List<Object> ordered = new ArrayList<>(before);
    ordered.sort((a, b) ->
      ((String) ((Map<?, ?>) a).get("name")).compareTo((String) ((Map<?, ?>) b).get("name"))
    );
    Set<String> names = new HashSet<>();
    List<Map<String, Object>> files = new ArrayList<>();
    for (Object raw : ordered) {
      check(job);
      Map<String, Object> entry = metadata(raw);
      require(
        job.rootId.equals(entry.get("rootId")) && Objects.equals(parentId, entry.get("parentId"))
      );
      String entryId = id(entry.get("entryId"));
      String name = string(entry.get("name"));
      if (!names.add(name) || !job.ids.add(entryId)) {
        throw fail("name-conflict");
      }
      List<String> path = new ArrayList<>(parentPath);
      path.add(name);
      validatePath(path);
      if (job.entries.size() >= maxEntries) {
        throw fail("resource-limit");
      }
      Map<String, Object> value = object(
        "entryId",
        entryId,
        "path",
        path,
        "kind",
        entry.get("kind"),
        "sizeBytes",
        entry.get("sizeBytes"),
        "modifiedAt",
        entry.get("modifiedAt"),
        "error",
        null
      );
      job.entries.add(value);
      progress(job);
      if ("directory".equals(entry.get("kind"))) {
        try {
          visit(job, entryId, path);
        } catch (Exception cause) {
          value.put("error", scanError(errorCode(job, cause)));
          throw cause;
        }
      } else if (value.get("sizeBytes") == null) {
        files.add(value);
      }
    }
    if (files.isEmpty()) {
      return;
    }
    measureFiles(job, files);
    // 读内容期间文件可能被改名或替换，读完再列一次才能确认实测的还是列出的那个条目。
    String after = listingKey(source.list(job.rootId, parentId, job.control));
    check(job);
    if (!key.equals(after)) {
      throw new ArchiveFailure("source-changed", "The directory changed during the scan.");
    }
  }

  private synchronized void progress(Job job) {
    job.state = object(
      "schemaVersion",
      1,
      "scanId",
      job.id,
      "rootId",
      job.rootId,
      "status",
      "running",
      "scannedEntries",
      job.entries.size(),
      "snapshot",
      null,
      "error",
      null
    );
  }

  private static String errorCode(Job job, Exception cause) {
    return job.hasTimedOut
      ? "timeout"
      : cause instanceof ArchiveFailure
        ? ((ArchiveFailure) cause).code
        : "io-failure";
  }

  /** 同时实测 values 里各文件的大小，全部结束后返回；任一个失败时抛出最先的失败，还没开始读的文件跳过。 */
  private void measureFiles(Job job, List<Map<String, Object>> values) throws Exception {
    AtomicReference<Exception> failure = new AtomicReference<>();
    List<Future<Object>> tasks = new ArrayList<>();
    for (Map<String, Object> value : values) {
      tasks.add(
        measurers.submit(() -> {
          if (failure.get() != null) {
            return null;
          }
          try {
            measure(job, value);
          } catch (Exception cause) {
            value.put("error", scanError(errorCode(job, cause)));
            failure.compareAndSet(null, cause);
          }
          return null;
        })
      );
    }
    for (Future<Object> task : tasks) {
      task.get();
    }
    if (failure.get() != null) {
      throw failure.get();
    }
  }

  /** 读完 value 对应的文件，把实际大小写回 value。 */
  private void measure(Job job, Map<String, Object> value) throws Exception {
    ArchiveModel.Source file = source.file(job.rootId, string(value.get("entryId")));
    file.validateRoot(job.rootId);
    long size = 0;
    byte[] buffer = new byte[65536];
    InputStream input = job.control.track(file.open(job.control));
    try (InputStream owned = input) {
      for (int count; (count = owned.read(buffer)) != -1; ) {
        check(job);
        if (count == 0) {
          continue;
        }
        if (size > MAX_SAFE - count) {
          throw fail("resource-limit");
        }
        size += count;
      }
    } finally {
      job.control.untrack(input);
    }
    check(job);
    // 读的过程中被改写由读完整层后再列一次目录发现。
    value.put("sizeBytes", size);
  }

  static Map<String, Object> scanError(String code) {
    String message;
    switch (code) {
      case "source-changed":
        message = "The directory or file changed during the scan. Scan again.";
        break;
      case "permission-denied":
      case "authorization-expired":
        message = "Directory permission expired. Select the directory again.";
        break;
      case "resource-limit":
        message = "Scan entries, paths, or results exceed the limit.";
        break;
      case "not-found":
        message = "The scan or directory reference does not exist. Read it again.";
        break;
      case "timeout":
        message = "The current scan timed out. Scan again.";
        break;
      case "name-conflict":
        message = "The directory contains duplicate or unusable names.";
        break;
      case "busy":
        message = "Another scan is running or the scanner stopped.";
        break;
      default:
        message = "The current directory scan failed. Read it again.";
    }
    return object("code", code, "message", message, "canRetry", false);
  }

  /** 取消进行中的读取，等工作线程释放资源后清空内存里的结果。 */
  @Override
  public void close() throws Exception {
    Job job;
    synchronized (this) {
      isClosed = true;
      job = active;
      if (job != null) {
        job.isCancelled = true;
      }
    }
    if (job != null) {
      job.control.cancel();
    }
    worker.shutdown();
    if (!worker.awaitTermination(30, TimeUnit.SECONDS)) {
      throw new ArchiveFailure("timeout", "Scan reading has not finished.");
    }
    measurers.shutdown();
    watcher.shutdownNow();
    synchronized (this) {
      jobs.clear();
    }
  }
}
