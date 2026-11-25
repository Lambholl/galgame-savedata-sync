package io.github.galgame.savedatasync;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

/** 迁移执行函数的规则，与 shared 的 migration.test.mjs 对应。 */
public class DataMigrationTest {

  // 版本 1 是基线，1→2 给 name 加前缀，2→3 加 tags。
  private static final DataMigration.Chain CHAIN = new DataMigration.Chain(
    1,
    3,
    Map.of(
      1,
      value -> {
        if (!(value.get("name") instanceof String)) {
          throw new IllegalArgumentException("name is missing");
        }
        Map<String, Object> next = new LinkedHashMap<>(value);
        next.put("schemaVersion", 2);
        next.put("name", "game-" + value.get("name"));
        return next;
      },
      2,
      value -> {
        Map<String, Object> next = new LinkedHashMap<>(value);
        next.put("schemaVersion", 3);
        next.put("tags", List.of());
        return next;
      }
    )
  );

  private static Object json(String text) throws Exception {
    return TransferJson.parse(text.getBytes(StandardCharsets.UTF_8));
  }

  @Test
  public void oldVersionIsMigratedStepByStepWithoutChangingInput() throws Exception {
    Object saved = json("{\"schemaVersion\":1,\"name\":\"a\"}");
    assertEquals(
      json("{\"schemaVersion\":3,\"name\":\"game-a\",\"tags\":[]}"),
      DataMigration.migrate(saved, CHAIN)
    );
    assertEquals(json("{\"schemaVersion\":1,\"name\":\"a\"}"), saved);
  }

  @Test
  public void currentNewerBelowBaseAndFailedStepsAreNotMigrated() throws Exception {
    for (String text : new String[] {
      "{\"schemaVersion\":3,\"name\":\"a\",\"tags\":[]}",
      "{\"schemaVersion\":4}",
      "{\"schemaVersion\":0,\"name\":\"a\"}",
      "{\"name\":\"a\"}",
      "[]",
      // 第一步抛错。
      "{\"schemaVersion\":1}",
    }) {
      assertNull(text, DataMigration.migrate(json(text), CHAIN));
    }
    DataMigration.Chain wrongVersion = new DataMigration.Chain(2, 3, Map.of(2, value -> value));
    assertNull(DataMigration.migrate(json("{\"schemaVersion\":2}"), wrongVersion));
  }
}
