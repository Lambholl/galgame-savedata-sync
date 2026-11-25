package io.github.galgame.savedatasync;

import java.util.Map;

/**
 * 带 schemaVersion 的结构化数据的迁移链和执行函数，规则与 shared 的 migrateData 相同。
 *
 * <p>迁移步骤只操作 {@link TransferJson#parse} 解析出的值，不读写存储。
 */
final class DataMigration {

  private DataMigration() {}

  /** 把版本 n 的数据变成版本 n+1；输入不合格式时抛错。 */
  interface Step {
    Object apply(Map<String, Object> value) throws Exception;
  }

  /** 一种数据的迁移链。 */
  static final class Chain {

    /** 1.0 写入的格式版本；更低的版本属于 0.x，按读不懂处理。 */
    final int baseVersion;
    /** 当前格式版本。 */
    final int currentVersion;
    /** 键是起始版本 n，从 baseVersion 到 currentVersion - 1 各有一步。 */
    final Map<Integer, Step> steps;

    Chain(int baseVersion, int currentVersion, Map<Integer, Step> steps) {
      this.baseVersion = baseVersion;
      this.currentVersion = currentVersion;
      this.steps = Map.copyOf(steps);
    }
  }

  /**
   * 把旧版本的数据逐步迁移到 chain 的当前版本。不修改 value。
   *
   * @param value {@link TransferJson#parse} 的结果。
   * @return 迁移后的数据，是否符合当前格式由调用方校验；value 不是带整数 schemaVersion 的 JSON 对象、版本不低于当前版本或低于基线、
   *     某一步抛错或没有把版本加一时返回 null。
   */
  static Object migrate(Object value, Chain chain) {
    if (!(value instanceof Map) || !(((Map<?, ?>) value).get("schemaVersion") instanceof Long)) {
      return null;
    }
    long version = (Long) ((Map<?, ?>) value).get("schemaVersion");
    if (version < chain.baseVersion || version >= chain.currentVersion) {
      return null;
    }
    Object current;
    try {
      current = TransferJson.copy(value);
      for (int from = (int) version; from < chain.currentVersion; from++) {
        Step step = chain.steps.get(from);
        if (step == null) {
          return null;
        }
        // 重新编码一次，步骤里写的 Integer 和解析出的 Long 统一成 Long。
        current = TransferJson.copy(step.apply(TransferJson.map(current)));
        // 每一步都要把版本号加一，否则后面的步骤会拿错格式。
        if (
          !(current instanceof Map) ||
          !Long.valueOf(from + 1).equals(((Map<?, ?>) current).get("schemaVersion"))
        ) {
          return null;
        }
      }
    } catch (Exception unreadable) {
      // 步骤只在数据不合它认的旧格式时抛错，这份数据和损坏的数据一样由调用方删除。
      return null;
    }
    return current;
  }
}
