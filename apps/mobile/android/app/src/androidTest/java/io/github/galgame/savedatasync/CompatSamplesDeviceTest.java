package io.github.galgame.savedatasync;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * 依赖 Android 框架的兼容样本核对：目录登记样本能读、读出再写回不变，以及启动检查对较新版本的判断。
 *
 * <p>只解析样本字符串，不读写应用的私有数据。
 */
@RunWith(AndroidJUnit4.class)
public class CompatSamplesDeviceTest {

  private static String sample(String path) throws Exception {
    try (
      InputStream input = InstrumentationRegistry.getInstrumentation()
        .getContext()
        .getAssets()
        .open("compat/" + path)
    ) {
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      byte[] buffer = new byte[8192];
      int count;
      while ((count = input.read(buffer)) != -1) {
        output.write(buffer, 0, count);
      }
      return output.toString(StandardCharsets.UTF_8.name());
    }
  }

  private static String withVersion(String saved, int version) throws Exception {
    return new JSONObject(saved).put("schemaVersion", version).toString();
  }

  @Test
  public void directoryRegistrySampleIsReadAndWrittenBackUnchanged() throws Exception {
    String saved = sample("android/directories/v" + DirectoryStore.REGISTRY_VERSION + ".json");
    DirectoryStore.SavedRegistry registry = DirectoryStore.SavedRegistry.parse(saved);
    assertNotNull(registry);
    assertTrue(registry.isComplete);
    assertEquals(1, registry.roots.size());
    assertEquals(saved, registry.serialize());
  }

  @Test
  public void onlyHigherSchemaVersionCountsAsNewer() throws Exception {
    String[][] samples = {
      { "android/directories", String.valueOf(DirectoryStore.REGISTRY_VERSION) },
      { "shared/library", String.valueOf(ListenerLibrary.LIBRARY_VERSION) },
      { "shared/backup-settings", String.valueOf(BackupModel.SETTINGS_VERSION) },
    };
    for (String[] item : samples) {
      int version = Integer.parseInt(item[1]);
      String saved = sample(item[0] + "/v" + version + ".json");
      assertFalse(item[0], AppDataRecovery.isNewer(saved, version));
      assertTrue(item[0], AppDataRecovery.isNewer(withVersion(saved, version + 1), version));
    }
  }
}
