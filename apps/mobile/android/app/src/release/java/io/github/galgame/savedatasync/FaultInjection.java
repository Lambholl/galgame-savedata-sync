package io.github.galgame.savedatasync;

import java.io.Closeable;
import java.io.InterruptedIOException;

/**
 * 发布版的故障注入：全部方法按实际情况返回，不改变任何行为。
 *
 * <p>调试版的同名类在 src/debug，两者的方法签名必须一致。
 */
final class FaultInjection {

  static final String TARGET = "target";
  static final String BACKUP = "backup";
  static final String CACHE = "cache";

  private FaultInjection() {}

  /** 返回 actual。 */
  static Long availableBytes(String area, Long actual) {
    return actual;
  }

  /** 立即返回。 */
  static void beforeWrite(String area) throws InterruptedIOException {}

  /** 不登记 connection。 */
  static void trackConnection(Closeable connection) {}
}
