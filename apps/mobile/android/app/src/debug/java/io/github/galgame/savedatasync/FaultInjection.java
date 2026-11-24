package io.github.galgame.savedatasync;

import java.io.Closeable;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.WeakHashMap;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 调试版的故障注入开关，默认全部关闭。
 *
 * <p>发布版的同名类在 src/release，只有前三个方法且不改变行为；两者的签名必须一致。开关可以从任意线程读写。
 */
final class FaultInjection {

  /** 同步的目标目录所在的存储。 */
  static final String TARGET = "target";
  /** 应用专属外部目录里的备份。 */
  static final String BACKUP = "backup";
  /** 本机接收内容时暂存归档的私有缓存。 */
  static final String CACHE = "cache";
  static final List<String> AREAS = Collections.unmodifiableList(
    Arrays.asList(TARGET, BACKUP, CACHE)
  );

  private static final Map<String, Long> AVAILABLE_BYTES = new ConcurrentHashMap<>();
  private static final Map<String, Long> WRITE_DELAY_MS = new ConcurrentHashMap<>();
  // 弱引用：连接关闭、不再被别处引用后自动移出，不需要显式注销。由集合自身的锁保护。
  private static final Set<Closeable> CONNECTIONS = Collections.synchronizedSet(
    Collections.newSetFromMap(new WeakHashMap<>())
  );

  private FaultInjection() {}

  /** 返回 area 的可用容量：设置了 {@link #setAvailableBytes} 时返回设置值，否则返回 actual。 */
  static Long availableBytes(String area, Long actual) {
    Long value = AVAILABLE_BYTES.get(area);
    return value == null ? actual : value;
  }

  /**
   * 设置了 area 的写入延迟时，在当前线程上等待这段时间。
   *
   * @throws InterruptedIOException 等待时线程被中断；中断状态保留。
   */
  static void beforeWrite(String area) throws InterruptedIOException {
    Long delay = WRITE_DELAY_MS.get(area);
    if (delay == null) {
      return;
    }
    try {
      Thread.sleep(delay);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      throw new InterruptedIOException("Interrupted during an injected write delay.");
    }
  }

  /** 登记一条网络连接，{@link #dropConnections} 会关闭它。 */
  static void trackConnection(Closeable connection) {
    if (connection != null) {
      CONNECTIONS.add(connection);
    }
  }

  /** 设置 area 报告的可用容量；bytes 为 null 时恢复实际值。 */
  static void setAvailableBytes(String area, Long bytes) {
    set(AVAILABLE_BYTES, area, bytes);
  }

  /** 设置 area 每次写入前的等待毫秒数；milliseconds 为 null 时取消。 */
  static void setWriteDelay(String area, Long milliseconds) {
    set(WRITE_DELAY_MS, area, milliseconds);
  }

  /**
   * 直接关闭登记过的全部网络连接，不发 WebSocket 关闭帧，对方和本机的读写随即失败。
   *
   * @return 关闭的连接数，包括已经关闭过的。
   */
  static int dropConnections() {
    List<Closeable> connections;
    synchronized (CONNECTIONS) {
      connections = new ArrayList<>(CONNECTIONS);
      CONNECTIONS.clear();
    }
    for (Closeable connection : connections) {
      try {
        connection.close();
      } catch (IOException ignored) {
        // 连接已经断开，目的已经达到。
      }
    }
    return connections.size();
  }

  /** 关闭全部故障。 */
  static void reset() {
    AVAILABLE_BYTES.clear();
    WRITE_DELAY_MS.clear();
  }

  /** 当前开着的故障：{availableBytes: {area: 字节}, writeDelayMs: {area: 毫秒}}。 */
  static Map<String, Object> state() {
    return TransferJson.object(
      "availableBytes",
      new TreeMap<String, Object>(AVAILABLE_BYTES),
      "writeDelayMs",
      new TreeMap<String, Object>(WRITE_DELAY_MS)
    );
  }

  private static void set(Map<String, Long> values, String area, Long value) {
    if (!AREAS.contains(area)) {
      throw new IllegalArgumentException("Unknown area: " + area);
    }
    if (value == null) {
      values.remove(area);
    } else {
      values.put(area, value);
    }
  }
}
