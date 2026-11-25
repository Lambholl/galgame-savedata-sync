package io.github.galgame.savedatasync;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.io.InputStream;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.After;
import org.junit.Test;

/**
 * 按格式版本冻结的兼容样本：当前版本都有样本，全部样本都能读，当前版本读出再写回不变。
 *
 * <p>样本在 desktop/test/fixtures/compat，和电脑端测试共用；Android 目录登记的读取依赖 Android 框架，由设备测试核对。
 */
public class CompatSamplesTest {

  private static final Pattern VERSION = Pattern.compile("^v(\\d+)\\.json$");
  private final List<BackupStore> stores = new ArrayList<>();
  private final List<Path> temporary = new ArrayList<>();

  @After
  public void cleanUp() throws Exception {
    for (BackupStore store : stores) {
      store.close();
    }
    for (Path path : temporary) {
      try (Stream<Path> walk = Files.walk(path)) {
        for (Path item : walk.sorted(Comparator.reverseOrder()).toList()) {
          Files.delete(item);
        }
      }
    }
  }

  private static Path compat(String relative) throws Exception {
    URL url = CompatSamplesTest.class.getResource("/compat/" + relative);
    assertNotNull("Missing compat sample: " + relative, url);
    return Paths.get(url.toURI());
  }

  /** 一个数据项的全部样本，按版本从旧到新。 */
  private static List<Path> samples(String directory) throws Exception {
    List<Path> result = new ArrayList<>();
    try (Stream<Path> paths = Files.list(compat(directory))) {
      paths
        .filter(path -> VERSION.matcher(path.getFileName().toString()).matches())
        .sorted(Comparator.comparingLong(CompatSamplesTest::version))
        .forEach(result::add);
    }
    return result;
  }

  private static long version(Path sample) {
    Matcher match = VERSION.matcher(sample.getFileName().toString());
    return match.matches() ? Long.parseLong(match.group(1)) : -1;
  }

  private static Object json(Path path) throws Exception {
    return TransferJson.parse(Files.readAllBytes(path));
  }

  /** 样本按迁移链迁移到当前版本后的内容；已是当前版本时原样返回。 */
  private static Object migrated(Path sample, DataMigration.Chain chain) throws Exception {
    Object value = json(sample);
    Object next = DataMigration.migrate(value, chain);
    return next != null ? next : value;
  }

  /** 按 JSON 重新解析，比较时不区分 Integer 和 Long。 */
  private static Object normalized(Object value) throws Exception {
    return TransferJson.parse(TransferJson.bytes(value));
  }

  private Path temporaryDirectory() throws Exception {
    Path path = Files.createTempDirectory("savedata-compat-test-");
    temporary.add(path);
    return path;
  }

  /** 在 privateDirectory 打开备份存储，备份库是 location/backups，本机设备 ID 为 deviceId。 */
  private BackupStore store(Path privateDirectory, Path location, String deviceId)
    throws Exception {
    BackupStore.Location place = new BackupStore.Location() {
      @Override
      public Path directory() {
        return location;
      }

      @Override
      public String gameName(String projectId) {
        return null;
      }
    };
    SyncScanner.Source source = new SyncScanner.Source() {
      @Override
      public String deviceId() {
        return deviceId;
      }

      @Override
      public List<Object> list(String rootId, String parentId, ArchiveControl control) {
        throw new UnsupportedOperationException();
      }

      @Override
      public ArchiveModel.Source file(String rootId, String entryId) {
        throw new UnsupportedOperationException();
      }
    };
    // 测试在 Windows 上也会运行：那里没有 fileKey 和 unix:nlink，改用真实路径和单链接。
    BackupFiles.Io io = new BackupFiles.Io() {
      @Override
      public Object identity(Path path, BasicFileAttributes value) throws Exception {
        return value.fileKey() != null ? value.fileKey() : path.toRealPath().toString();
      }

      @Override
      public long links(Path path) {
        return 1;
      }
    };
    BackupStore store = new BackupStore(privateDirectory, place, source, io);
    stores.add(store);
    return store;
  }

  private static void copyTree(Path from, Path to) throws Exception {
    try (Stream<Path> walk = Files.walk(from)) {
      for (Path item : walk.toList()) {
        Path target = to.resolve(from.relativize(item).toString());
        if (Files.isDirectory(item)) {
          Files.createDirectories(target);
        } else {
          Files.copy(item, target);
        }
      }
    }
  }

  /** 返回备份库 backups 里唯一一个游戏文件夹下唯一的一轮备份文件夹。 */
  private static Path round(Path backups) throws Exception {
    try (Stream<Path> games = Files.list(backups)) {
      Path game = games.findFirst().orElseThrow();
      try (Stream<Path> rounds = Files.list(game)) {
        return rounds.findFirst().orElseThrow();
      }
    }
  }

  private static String sha256(InputStream input) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    byte[] buffer = new byte[ArchiveModel.BUFFER];
    int count;
    while ((count = input.read(buffer)) != -1) {
      digest.update(buffer, 0, count);
    }
    return HexFormat.of().formatHex(digest.digest());
  }

  @Test
  public void everyVersionedFormatHasSampleForCurrentVersion() throws Exception {
    assertTrue(
      Files.isRegularFile(compat("shared/library/v" + ListenerLibrary.LIBRARY_VERSION + ".json"))
    );
    assertTrue(
      Files.isRegularFile(
        compat("shared/backup-settings/v" + BackupModel.SETTINGS_VERSION + ".json")
      )
    );
    assertTrue(
      Files.isRegularFile(
        compat("android/directories/v" + DirectoryStore.REGISTRY_VERSION + ".json")
      )
    );
    assertTrue(Files.isDirectory(compat("shared/backup/v" + BackupModel.MANIFEST_VERSION)));
  }

  @Test
  public void everyMigrationChainHasOneStepPerVersionFromBaseToCurrent() {
    Map<String, DataMigration.Chain> chains = Map.of(
      "library",
      ListenerLibrary.LIBRARY_MIGRATIONS,
      "backup-settings",
      BackupModel.SETTINGS_MIGRATIONS,
      "directories",
      DirectoryStore.REGISTRY_MIGRATIONS
    );
    Map<String, Integer> current = Map.of(
      "library",
      ListenerLibrary.LIBRARY_VERSION,
      "backup-settings",
      BackupModel.SETTINGS_VERSION,
      "directories",
      DirectoryStore.REGISTRY_VERSION
    );
    for (Map.Entry<String, DataMigration.Chain> entry : chains.entrySet()) {
      DataMigration.Chain chain = entry.getValue();
      assertEquals(entry.getKey(), (int) current.get(entry.getKey()), chain.currentVersion);
      Set<Integer> expected = new HashSet<>();
      for (int from = chain.baseVersion; from < chain.currentVersion; from++) {
        expected.add(from);
      }
      assertEquals(entry.getKey(), expected, chain.steps.keySet());
    }
  }

  @Test
  public void everyLibrarySampleIsReadable() throws Exception {
    for (Path sample : samples("shared/library")) {
      ListenerLibrary.checkConfig(migrated(sample, ListenerLibrary.LIBRARY_MIGRATIONS));
    }
  }

  @Test
  public void everyBackupSettingsSampleIsReadAndCurrentOneIsWrittenBackUnchanged()
    throws Exception {
    for (Path sample : samples("shared/backup-settings")) {
      Path privateDirectory = temporaryDirectory();
      Files.write(
        privateDirectory.resolve(BackupStore.SETTINGS_FILE),
        TransferJson.bytes(migrated(sample, BackupModel.SETTINGS_MIGRATIONS))
      );
      BackupStore store = store(privateDirectory, privateDirectory, UUID.randomUUID().toString());
      Map<String, Object> settings = store.settings();
      if (version(sample) == BackupModel.SETTINGS_VERSION) {
        Files.delete(privateDirectory.resolve(BackupStore.SETTINGS_FILE));
        store.setKeepCount(((Number) settings.get("keepCount")).longValue());
        assertEquals(json(sample), json(privateDirectory.resolve(BackupStore.SETTINGS_FILE)));
      }
    }
  }

  @Test
  public void everyBackupSampleIsListedAndReadsSameFiles() throws Exception {
    try (Stream<Path> versions = Files.list(compat("shared/backup"))) {
      for (Path version : versions.toList()) {
        Path location = temporaryDirectory();
        copyTree(version, location.resolve("backups"));
        Path round = round(location.resolve("backups"));
        Map<String, Object> manifest = TransferJson.map(json(round.resolve("backup.json")));
        if (((Number) manifest.get("schemaVersion")).longValue() == BackupModel.MANIFEST_VERSION) {
          assertEquals(normalized(manifest), normalized(BackupModel.manifest(manifest)));
        }
        String projectId = (String) manifest.get("projectId");
        String backupId = (String) manifest.get("backupId");
        BackupStore store = store(location, location, (String) manifest.get("deviceId"));

        Map<String, Object> listing = store.list(projectId);
        List<Object> backups = TransferJson.list(listing.get("backups"));
        assertEquals(1, backups.size());
        assertEquals(backupId, TransferJson.map(backups.get(0)).get("backupId"));
        assertTrue(TransferJson.list(listing.get("incomplete")).isEmpty());
        try (BackupStore.Handle handle = store.acquire(projectId, backupId, new ArchiveControl())) {
          for (Object raw : TransferJson.list(manifest.get("files"))) {
            Map<String, Object> file = TransferJson.map(raw);
            Path content = round.resolve("files");
            for (Object name : TransferJson.list(file.get("path"))) {
              content = content.resolve((String) name);
            }
            String expected;
            try (InputStream input = Files.newInputStream(content)) {
              expected = sha256(input);
            }
            try (
              InputStream input = handle
                .source((String) file.get("fileId"))
                .open(new ArchiveControl())
            ) {
              assertEquals(expected, sha256(input));
            }
          }
        }
      }
    }
  }

  @Test
  public void newerBackupIsNeitherListedNorRotatedAway() throws Exception {
    Path location = temporaryDirectory();
    Path backups = location.resolve("backups");
    copyTree(compat("shared/backup/v" + BackupModel.MANIFEST_VERSION), backups);
    Path current = round(backups);
    Map<String, Object> manifest = TransferJson.map(json(current.resolve("backup.json")));
    // 同一游戏再放一份更新的备份，清单版本更高、时间更晚；按份数轮换时它若被算进去，旧的那份就会被删。
    Path newer = current.resolveSibling(current.getFileName() + "-newer");
    copyTree(current, newer);
    Map<String, Object> future = TransferJson.map(TransferJson.copy(manifest));
    future.put("schemaVersion", BackupModel.MANIFEST_VERSION + 1);
    future.put("backupId", UUID.randomUUID().toString());
    future.put("createdAt", ((Number) manifest.get("createdAt")).longValue() + 1);
    byte[] futureBytes = TransferJson.bytes(future);
    Files.write(newer.resolve("backup.json"), futureBytes);
    String projectId = (String) manifest.get("projectId");
    BackupStore store = store(location, location, (String) manifest.get("deviceId"));
    store.setKeepCount(1);

    store.rotate(projectId);

    Map<String, Object> listing = store.list(projectId);
    List<Object> listed = TransferJson.list(listing.get("backups"));
    assertEquals(1, listed.size());
    assertEquals(manifest.get("backupId"), TransferJson.map(listed.get(0)).get("backupId"));
    assertTrue(TransferJson.list(listing.get("incomplete")).isEmpty());
    assertTrue(Files.isRegularFile(current.resolve("backup.json")));
    assertEquals(
      HexFormat.of().formatHex(futureBytes),
      HexFormat.of().formatHex(Files.readAllBytes(newer.resolve("backup.json")))
    );
  }
}
