package io.github.galgame.savedatasync;

import static org.junit.Assert.assertEquals;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.junit.Test;

/** 校验 SyncScanner 扫描结果里的条目。 */
public class SyncScannerTest {

  private static final String ROOT = "root";

  @Test
  public void scanSkipsNomediaFilesAtEveryLevel() throws Exception {
    // 和电脑端 sync-scanner.test.mjs 用同一组条目：根目录和子目录各有一个 .nomedia。
    Map<String, List<Object>> listings = new LinkedHashMap<>();
    listings.put(null, Arrays.asList(file("n1", null, ".nomedia"), directory("d1", "save")));
    listings.put("d1", Arrays.asList(file("n2", "d1", ".nomedia"), file("f1", "d1", "a.sav")));
    try (SyncScanner scanner = new SyncScanner(source(listings))) {
      Map<String, Object> snapshot = scanner.snapshotNow(ROOT, new ArchiveControl());

      List<String> paths = new ArrayList<>();
      for (Object entry : (List<?>) snapshot.get("entries")) {
        List<?> path = (List<?>) ((Map<?, ?>) entry).get("path");
        paths.add(path.stream().map(String::valueOf).collect(Collectors.joining("/")));
      }
      assertEquals(Arrays.asList("save", "save/a.sav"), paths);
    }
  }

  private static SyncScanner.Source source(Map<String, List<Object>> listings) {
    return new SyncScanner.Source() {
      @Override
      public String deviceId() {
        return "device";
      }

      @Override
      public List<Object> list(String rootId, String parentId, ArchiveControl control) {
        return listings.get(parentId);
      }

      @Override
      public ArchiveModel.Source file(String rootId, String entryId) {
        throw new AssertionError("Listed sizes make reading file contents unnecessary");
      }
    };
  }

  private static Map<String, Object> file(String entryId, String parentId, String name) {
    return entry(entryId, parentId, name, "file", 1L);
  }

  private static Map<String, Object> directory(String entryId, String name) {
    return entry(entryId, null, name, "directory", null);
  }

  private static Map<String, Object> entry(
    String entryId,
    String parentId,
    String name,
    String kind,
    Long sizeBytes
  ) {
    Map<String, Object> capabilities = new LinkedHashMap<>();
    for (String key : new String[] {
      "canRead",
      "canList",
      "canCreate",
      "canRename",
      "canDelete",
    }) {
      capabilities.put(key, "supported");
    }
    Map<String, Object> value = new LinkedHashMap<>();
    value.put("rootId", ROOT);
    value.put("entryId", entryId);
    value.put("parentId", parentId);
    value.put("name", name);
    value.put("kind", kind);
    value.put("sizeBytes", sizeBytes);
    value.put("modifiedAt", 1000L);
    value.put("capabilities", capabilities);
    return value;
  }
}
