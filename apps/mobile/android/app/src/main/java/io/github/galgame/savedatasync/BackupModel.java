package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.bytes;
import static io.github.galgame.savedatasync.TransferJson.copy;
import static io.github.galgame.savedatasync.TransferJson.fail;
import static io.github.galgame.savedatasync.TransferJson.list;
import static io.github.galgame.savedatasync.TransferJson.map;
import static io.github.galgame.savedatasync.TransferJson.object;
import static io.github.galgame.savedatasync.TransferSchema.fileId;
import static io.github.galgame.savedatasync.TransferSchema.id;
import static io.github.galgame.savedatasync.TransferSchema.manifest;
import static io.github.galgame.savedatasync.TransferSchema.nullable;
import static io.github.galgame.savedatasync.TransferSchema.number;
import static io.github.galgame.savedatasync.TransferSchema.one;
import static io.github.galgame.savedatasync.TransferSchema.parent;
import static io.github.galgame.savedatasync.TransferSchema.require;
import static io.github.galgame.savedatasync.TransferSchema.shape;
import static io.github.galgame.savedatasync.TransferSchema.string;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** 备份 v1 的数据校验和命名规则。 */
final class BackupModel {

  static final long MAX_FILE = 268435456L;
  static final long MAX_TOTAL = 1073741824L;
  static final long MAX_DATE = 8640000000000000L;

  private BackupModel() {}

  static List<String> path(Object raw) throws Exception {
    List<Object> values = list(raw);
    require(!values.isEmpty() && values.size() <= 64);
    List<String> result = new ArrayList<>();
    int length = -1;
    for (Object value : values) {
      String name = string(value);
      require(!name.equals(".") && !name.equals("..") && PublicationModel.portableName(name));
      result.add(name);
      length += name.length() + 1;
    }
    require(length <= 4096);
    return Collections.unmodifiableList(result);
  }

  static String key(List<String> path) throws Exception {
    List<Object> names = new ArrayList<>();
    for (String name : path) {
      names.add(Normalizer.normalize(name, Normalizer.Form.NFC).toLowerCase(Locale.ROOT));
    }
    return new String(bytes(names), java.nio.charset.StandardCharsets.UTF_8);
  }

  static int compare(List<String> left, List<String> right) {
    for (int i = 0; i < Math.min(left.size(), right.size()); i++) {
      int value = left.get(i).compareTo(right.get(i));
      if (value != 0) {
        return value;
      }
    }
    return Integer.compare(left.size(), right.size());
  }

  /** 写入前要备份的一个目标文件。 */
  static final class SourceFile {

    final String entryId;
    final List<String> path;
    final long size;
    final Long modified;

    SourceFile(Object raw) throws Exception {
      Map<String, Object> entry = shape(
        copy(raw),
        "entryId",
        "path",
        "kind",
        "sizeBytes",
        "modifiedAt",
        "error"
      );
      require("file".equals(entry.get("kind")) && entry.get("error") == null);
      entryId = id(entry.get("entryId"));
      path = path(entry.get("path"));
      size = number(entry.get("sizeBytes"), 0, MAX_FILE);
      modified = nullable(entry.get("modifiedAt"), -MAX_DATE, MAX_DATE);
    }
  }

  static List<SourceFile> sources(List<Object> values) throws Exception {
    require(values.size() <= 1024);
    List<SourceFile> result = new ArrayList<>();
    Set<String> ids = new HashSet<>();
    for (Object value : values) {
      SourceFile file = new SourceFile(value);
      require(ids.add(file.entryId));
      result.add(file);
    }
    result.sort((left, right) -> compare(left.path, right.path));
    List<Object> files = new ArrayList<>();
    for (int i = 0; i < result.size(); i++) {
      SourceFile file = result.get(i);
      files.add(
        object(
          "fileId",
          ArchiveModel.id(i),
          "path",
          file.path,
          "sizeBytes",
          file.size,
          "modifiedAt",
          file.modified
        )
      );
    }
    validateFiles(files, true);
    return Collections.unmodifiableList(result);
  }

  static List<Object> validateFiles(Object raw, boolean allowEmpty) throws Exception {
    List<Object> values = list(raw);
    require(values.size() <= 1024 && (allowEmpty || !values.isEmpty()));
    List<Object> result = new ArrayList<>();
    Set<String> paths = new HashSet<>();
    long total = 0;
    for (int i = 0; i < values.size(); i++) {
      // 磁盘上已有的备份清单里，文件项可能带 sha256 字段，读取时丢弃。
      Map<String, Object> file = map(values.get(i)).containsKey("sha256")
        ? shape(values.get(i), "fileId", "path", "sizeBytes", "sha256", "modifiedAt")
        : shape(values.get(i), "fileId", "path", "sizeBytes", "modifiedAt");
      fileId(file.get("fileId"), i);
      List<String> path = path(file.get("path"));
      require(paths.add(key(path)));
      long size = number(file.get("sizeBytes"), 0, MAX_FILE);
      total += size;
      require(total <= MAX_TOTAL);
      result.add(
        object(
          "fileId",
          ArchiveModel.id(i),
          "path",
          path,
          "sizeBytes",
          size,
          "modifiedAt",
          nullable(file.get("modifiedAt"), -MAX_DATE, MAX_DATE)
        )
      );
    }
    for (Object rawFile : result) {
      List<String> path = path(map(rawFile).get("path"));
      for (int depth = 1; depth < path.size(); depth++) {
        require(!paths.contains(key(path.subList(0, depth))));
      }
    }
    return result;
  }

  static Map<String, Object> manifest(Object raw) throws Exception {
    Map<String, Object> value = shape(
      raw,
      "schemaVersion",
      "backupId",
      "projectId",
      "deviceId",
      "rootId",
      "createdAt",
      "reason",
      "files"
    );
    require(number(value.get("schemaVersion"), 1, 1) == 1);
    one(value.get("reason"), "copy", "restore");
    return object(
      "schemaVersion",
      1,
      "backupId",
      id(value.get("backupId")),
      "projectId",
      id(value.get("projectId")),
      "deviceId",
      id(value.get("deviceId")),
      "rootId",
      id(value.get("rootId")),
      "createdAt",
      number(value.get("createdAt"), -MAX_DATE, MAX_DATE),
      "reason",
      value.get("reason"),
      "files",
      validateFiles(value.get("files"), false)
    );
  }

  /** 游戏名对应的文件夹名：换掉不能用的字符，过长截断；结果仍不可用时退回游戏 ID。 */
  static String folderName(String gameName, String projectId) {
    if (gameName != null) {
      StringBuilder name = new StringBuilder();
      int count = 0;
      for (int c : gameName.codePoints().toArray()) {
        if (count++ >= 60) {
          break;
        }
        name.appendCodePoint(c < 32 || c == 127 || "<>:\"/\\|?*".indexOf(c) >= 0 ? '_' : c);
      }
      String value = name.toString().trim().replaceAll("[. ]+$", "");
      if (!value.isEmpty() && PublicationModel.portableName(value)) {
        return value;
      }
    }
    return projectId;
  }

  /** 一份备份的文件夹名：UTC 时间，按名字排序就是按时间排序。 */
  static String roundName(long createdAt) {
    java.text.SimpleDateFormat format = new java.text.SimpleDateFormat(
      "yyyy-MM-dd_HH-mm-ss'Z'",
      Locale.ROOT
    );
    format.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
    return format.format(new java.util.Date(createdAt));
  }

  static final long KEEP_MIN = 1;
  static final long KEEP_MAX = 10;
  static final long KEEP_DEFAULT = 3;

  /** 备份设置的格式版本，与 shared 的 SyncBackupSettings.schemaVersion 保持一致。 */
  static final int SETTINGS_VERSION = 3;

  /** 没有设置文件时的设置：全局开启、保留 3 份，没有单独设置的游戏。 */
  static Map<String, Object> emptySettings() {
    return object(
      "schemaVersion",
      SETTINGS_VERSION,
      "defaults",
      policy(true, KEEP_DEFAULT),
      "projects",
      new ArrayList<>()
    );
  }

  static Map<String, Object> policy(boolean shouldBackup, long keepCount) {
    return object("shouldBackup", shouldBackup, "keepCount", keepCount);
  }

  /** 备份策略：是否备份与保留份数（1–10）。 */
  static Map<String, Object> policy(Object raw) throws Exception {
    Map<String, Object> value = shape(raw, "shouldBackup", "keepCount");
    require(value.get("shouldBackup") instanceof Boolean);
    return policy(
      (Boolean) value.get("shouldBackup"),
      number(value.get("keepCount"), KEEP_MIN, KEEP_MAX)
    );
  }

  /**
   * 校验备份设置：全局设置加按游戏的单独设置；格式不符时抛错。
   *
   * <p>v2 格式按游戏和目录单独设置，读入时转换为 v3：同一个游戏有多条时保留数组里最后一条，即最近一次修改的那条。
   *
   * @return v3 格式的设置。
   */
  static Map<String, Object> settings(Object raw) throws Exception {
    Map<String, Object> value = shape(raw, "schemaVersion", "defaults", "projects");
    final boolean isLegacy = number(value.get("schemaVersion"), 2, SETTINGS_VERSION) == 2;
    Map<String, Object> defaults = policy(value.get("defaults"));
    List<Object> projects = list(value.get("projects"));
    require(projects.size() <= 128);
    Map<String, Object> latest = new LinkedHashMap<>();
    for (Object entry : projects) {
      Map<String, Object> item = isLegacy
        ? shape(entry, "projectId", "rootId", "shouldBackup", "keepCount")
        : shape(entry, "projectId", "shouldBackup", "keepCount");
      String project = id(item.get("projectId"));
      if (isLegacy) {
        id(item.get("rootId"));
      }
      Map<String, Object> custom = policy(
        object("shouldBackup", item.get("shouldBackup"), "keepCount", item.get("keepCount"))
      );
      require(isLegacy || !latest.containsKey(project));
      latest.remove(project);
      latest.put(
        project,
        object(
          "projectId",
          project,
          "shouldBackup",
          custom.get("shouldBackup"),
          "keepCount",
          custom.get("keepCount")
        )
      );
    }
    return object(
      "schemaVersion",
      SETTINGS_VERSION,
      "defaults",
      defaults,
      "projects",
      new ArrayList<>(latest.values())
    );
  }

  /** 某个游戏实际使用的策略：有单独设置用单独设置，否则用全局设置。 */
  static Map<String, Object> resolve(Map<String, Object> settings, String projectId)
    throws Exception {
    for (Object item : list(settings.get("projects"))) {
      Map<String, Object> setting = map(item);
      if (setting.get("projectId").equals(projectId)) {
        return policy(
          (Boolean) setting.get("shouldBackup"),
          ((Number) setting.get("keepCount")).longValue()
        );
      }
    }
    return map(settings.get("defaults"));
  }

  /** 从备份清单生成恢复用的目录树快照。 */
  static Map<String, Object> snapshot(Map<String, Object> manifest) throws Exception {
    java.util.LinkedHashMap<String, Object> entries = new java.util.LinkedHashMap<>();
    for (Object raw : list(manifest.get("files"))) {
      Map<String, Object> file = map(raw);
      List<String> path = path(file.get("path"));
      for (int depth = 1; depth < path.size(); depth++) {
        List<String> parent = new ArrayList<>(path.subList(0, depth));
        String key = new String(bytes(parent), java.nio.charset.StandardCharsets.UTF_8);
        if (!entries.containsKey(key)) {
          if (entries.size() >= 10000) {
            throw fail("resource-limit");
          }
          entries.put(
            key,
            object(
              "entryId",
              "d" + (entries.size() + 1),
              "path",
              parent,
              "kind",
              "directory",
              "sizeBytes",
              null,
              "modifiedAt",
              null,
              "error",
              null
            )
          );
        }
      }
      if (entries.size() >= 10000) {
        throw fail("resource-limit");
      }
      entries.put(
        new String(bytes(path), java.nio.charset.StandardCharsets.UTF_8),
        object(
          "entryId",
          file.get("fileId"),
          "path",
          path,
          "kind",
          "file",
          "sizeBytes",
          file.get("sizeBytes"),
          "modifiedAt",
          file.get("modifiedAt"),
          "error",
          null
        )
      );
    }
    List<Object> values = new ArrayList<>(entries.values());
    values.sort((a, b) -> {
      try {
        return compare(path(map(a).get("path")), path(map(b).get("path")));
      } catch (Exception invalid) {
        throw new IllegalStateException(invalid);
      }
    });
    Map<String, Object> result = object(
      "schemaVersion",
      1,
      "scanId",
      java.util.UUID.randomUUID().toString(),
      "deviceId",
      manifest.get("deviceId"),
      "rootId",
      manifest.get("backupId"),
      "observedAt",
      System.currentTimeMillis(),
      "entries",
      values,
      "error",
      null
    );
    bytes(result);
    return result;
  }
}
