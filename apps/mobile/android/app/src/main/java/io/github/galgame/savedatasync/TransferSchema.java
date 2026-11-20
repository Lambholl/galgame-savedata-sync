package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.fail;
import static io.github.galgame.savedatasync.TransferJson.list;
import static io.github.galgame.savedatasync.TransferJson.map;
import static io.github.galgame.savedatasync.TransferJson.object;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** 设备描述、目录列表、条目元数据和错误信封等传输字段的校验。 */
final class TransferSchema {

  static final String ERROR_CODES =
    "invalid-request protocol-mismatch session-mismatch task-conflict invalid-archive " +
    "resource-limit busy timeout permission-denied authorization-expired not-found " +
    "not-readable unsupported-operation name-conflict path-outside-root source-changed " +
    "checksum-mismatch network-failure insufficient-space io-failure cleanup-failed " +
    "result-unknown";

  private TransferSchema() {}

  static void require(boolean isSatisfied) throws ArchiveFailure {
    if (!isSatisfied) {
      throw fail("invalid-request");
    }
  }

  static Map<String, Object> shape(Object value, String... keys) throws ArchiveFailure {
    Map<String, Object> m = map(value);
    require(m.keySet().equals(new HashSet<>(Arrays.asList(keys))));
    return m;
  }

  static String string(Object value) throws ArchiveFailure {
    require(value instanceof String);
    return (String) value;
  }

  static String id(Object value) throws ArchiveFailure {
    require(DocumentValues.isId(value));
    return (String) value;
  }

  static String parent(Object value) throws ArchiveFailure {
    return value == null ? null : id(value);
  }

  static String text(Object value) throws ArchiveFailure {
    String result = string(value);
    require(ArchiveModel.text(result));
    return result;
  }

  static long number(Object value, long min, long max) throws ArchiveFailure {
    require(value instanceof Number);
    Number n = (Number) value;
    long result = n.longValue();
    require(n.doubleValue() == result && result >= min && result <= max);
    return result;
  }

  static Long nullable(Object value, long min, long max) throws ArchiveFailure {
    return value == null ? null : number(value, min, max);
  }

  static void one(Object value, String... values) throws ArchiveFailure {
    require(Arrays.asList(values).contains(value));
  }

  static String fileId(Object value, int index) throws ArchiveFailure {
    require(ArchiveModel.id(index).equals(value));
    return (String) value;
  }

  static Map<String, Object> limits() {
    return object(
      "maxFiles",
      1024,
      "maxFileBytes",
      268435456L,
      "maxTotalFileBytes",
      1073741824L,
      "maxTarBytes",
      1074790400L,
      "maxArchiveBytes",
      1140850688L,
      "maxJsonBytes",
      8388608,
      "maxConcurrentBatches",
      1,
      "maxTransfersPerSession",
      4096
    );
  }

  static Map<String, Object> device(Object value) throws ArchiveFailure {
    Map<String, Object> m = shape(value, "device", "sessionId", "limits");
    id(m.get("sessionId"));
    Map<String, Object> device = shape(
      m.get("device"),
      "protocolVersion",
      "deviceId",
      "displayName",
      "platform",
      "capabilities"
    );
    if (!Long.valueOf(3).equals(device.get("protocolVersion"))) {
      number(device.get("protocolVersion"), 3, 3);
    }
    id(device.get("deviceId"));
    text(device.get("displayName"));
    one(device.get("platform"), "windows", "android");
    Map<String, Object> capabilities = shape(device.get("capabilities"), "canListRoots");
    for (Object capability : capabilities.values()) {
      one(capability, "supported", "unsupported", "unknown");
    }
    Map<String, Object> limits = map(m.get("limits"));
    require(limits.keySet().equals(limits().keySet()));
    for (String key : limits().keySet()) {
      require(number(limits.get(key), 1, 2000000000L) == ((Number) limits().get(key)).longValue());
    }
    return m;
  }

  static Map<String, Object> error(Object value) throws ArchiveFailure {
    Map<String, Object> e = map(value).containsKey("device")
      ? shape(value, "code", "message", "canRetry", "device")
      : shape(value, "code", "message", "canRetry");
    require(
      !e.containsKey("device") || Arrays.asList("listener", "dialer").contains(e.get("device"))
    );
    require(Arrays.asList(ERROR_CODES.split(" ")).contains(e.get("code")));
    text(e.get("message"));
    require(e.get("canRetry") instanceof Boolean);
    if ("result-unknown".equals(e.get("code")) || "session-mismatch".equals(e.get("code"))) {
      require(Boolean.FALSE.equals(e.get("canRetry")));
    }
    return e;
  }

  /** 同 {@link #error(String)}，device 不为 null 时注明出错的目录在哪一端（listener 或 dialer）。 */
  static Map<String, Object> error(String code, String device) {
    Map<String, Object> e = error(code);
    if (device != null) {
      e.put("device", device);
    }
    return e;
  }

  static Map<String, Object> error(String code) {
    return object(
      "code",
      code,
      "message",
      "insufficient-space".equals(code)
        ? "The device has insufficient free space. Free up space and start the transfer again."
        : "The transfer is incomplete. Verify the directory and actual result.",
      "canRetry",
      false
    );
  }

  static Object unwrap(Object value) throws ArchiveFailure {
    Map<String, Object> m = map(value);
    if ("error".equals(m.get("status"))) {
      shape(m, "status", "error");
      throw fail(string(error(m.get("error")).get("code")));
    }
    shape(m, "status", "value");
    require("success".equals(m.get("status")));
    return m.get("value");
  }

  static Map<String, Object> metadata(Object value) throws ArchiveFailure {
    Map<String, Object> e = shape(
      value,
      "rootId",
      "entryId",
      "parentId",
      "name",
      "kind",
      "sizeBytes",
      "modifiedAt",
      "capabilities"
    );
    id(e.get("rootId"));
    id(e.get("entryId"));
    parent(e.get("parentId"));
    text(e.get("name"));
    require(!Objects.equals(e.get("entryId"), e.get("parentId")));
    one(e.get("kind"), "file", "directory");
    if ("directory".equals(e.get("kind"))) {
      require(e.get("sizeBytes") == null);
    } else {
      nullable(e.get("sizeBytes"), 0, 9007199254740991L);
    }
    nullable(e.get("modifiedAt"), -8640000000000000L, 8640000000000000L);
    Map<String, Object> caps = shape(
      e.get("capabilities"),
      "canRead",
      "canList",
      "canCreate",
      "canRename",
      "canDelete"
    );
    for (Object cap : caps.values()) {
      one(cap, "supported", "unsupported", "unknown");
    }
    return e;
  }

  static List<Object> roots(Object value, String deviceId) throws ArchiveFailure {
    List<Object> values = list(value);
    require(values.size() <= 32768);
    Set<String> ids = new HashSet<>();
    for (Object item : values) {
      Map<String, Object> r = map(item);
      List<String> fields = new ArrayList<>(
        Arrays.asList("rootId", "deviceId", "displayName", "authorization")
      );
      for (String field : Arrays.asList("displayPath", "parentName")) {
        if (r.containsKey(field)) {
          text(r.get(field));
          fields.add(field);
        }
      }
      shape(r, fields.toArray(new String[0]));
      require(deviceId.equals(id(r.get("deviceId"))) && ids.add(id(r.get("rootId"))));
      text(r.get("displayName"));
      one(r.get("authorization"), "granted", "expired", "unavailable", "unverified");
    }
    return values;
  }

  static Map<String, Object> directory(Object value, String root, String parent)
    throws ArchiveFailure {
    Map<String, Object> m = shape(value, "rootId", "parentId", "observedAt", "entries");
    require(root.equals(m.get("rootId")) && Objects.equals(parent, m.get("parentId")));
    number(m.get("observedAt"), -8640000000000000L, 8640000000000000L);
    List<Object> entries = list(m.get("entries"));
    require(entries.size() <= 32768);
    Set<String> ids = new HashSet<>();
    for (Object item : entries) {
      Map<String, Object> e = metadata(item);
      require(
        root.equals(e.get("rootId")) &&
          Objects.equals(parent, e.get("parentId")) &&
          ids.add(string(e.get("entryId")))
      );
    }
    return m;
  }
}
