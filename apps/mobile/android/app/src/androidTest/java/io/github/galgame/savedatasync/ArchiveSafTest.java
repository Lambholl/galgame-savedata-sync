package io.github.galgame.savedatasync;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.Bundle;
import android.os.CancellationSignal;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * 归档的真机验收测试；SAF 用例必须传入已通过系统选择器 READ 授权的合成目录显示名，没有目录或授权时失败。
 * 源只读，所有写入都在应用私有缓存中。
 * 固定格式和 Windows 互通测试不需要交互，SAF 测试要先执行选择器用例。
 */
@RunWith(AndroidJUnit4.class)
public class ArchiveSafTest {

  private Context context() {
    return InstrumentationRegistry.getInstrumentation().getTargetContext();
  }

  private Context tests() {
    return InstrumentationRegistry.getInstrumentation().getContext();
  }

  private static byte[] smallBytes(InputStream input) throws Exception {
    try (InputStream stream = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[65536];
      int n;
      while ((n = stream.read(buffer)) != -1) {
        assertTrue("Only small format fixtures may be collected", out.size() + n < 16384);
        out.write(buffer, 0, n);
      }
      return out.toByteArray();
    }
  }

  private String digest(InputStream input) throws Exception {
    MessageDigest hash = ArchiveFormat.sha256();
    byte[] buffer = new byte[65536];
    try (InputStream stream = input) {
      int n;
      while ((n = stream.read(buffer)) != -1) {
        hash.update(buffer, 0, n);
      }
    }
    return ArchiveFormat.hex(hash.digest());
  }

  private static List<Long> sizes(byte[]... contents) {
    List<Long> result = new ArrayList<>();
    for (byte[] content : contents) {
      result.add((long) content.length);
    }
    return result;
  }

  private JSONObject fixture() throws Exception {
    return new JSONObject(
      new String(smallBytes(tests().getAssets().open("archive-v1.json")), StandardCharsets.UTF_8)
    );
  }

  @Test
  public void androidConsumesPythonAndWindowsNativeArchivesAndExportsJavaArchive()
    throws Exception {
    JSONObject fixture = fixture();
    ArchiveAdapter adapter = DirectoryArchiveSource.createAdapter(context());
    byte[][] contents = new byte[3][];
    for (int i = 0; i < 3; i++) {
      contents[i] = Base64.getDecoder().decode(fixture.getJSONArray("contentsBase64").getString(i));
    }
    try (
      ArchiveAdapter.Staged staged = adapter.receiveFiles(
        sizes(contents),
        new ByteArrayInputStream(Base64.getDecoder().decode(fixture.getString("archiveBase64"))),
        new ArchiveControl(),
        null
      )
    ) {
      for (int i = 0; i < 3; i++) {
        assertArrayEquals(contents[i], smallBytes(staged.openFile(ArchiveModel.id(i))));
      }
    }
    try (
      ArchiveAdapter.Staged staged = adapter.receiveFiles(
        sizes(contents),
        tests().getAssets().open("windows-archive.bin"),
        new ArchiveControl(),
        null
      )
    ) {
      for (int i = 0; i < 3; i++) {
        assertArrayEquals(contents[i], smallBytes(staged.openFile(ArchiveModel.id(i))));
      }
    }
    byte[] large = new byte[131073];
    for (int i = 0; i < large.length; i++) {
      large[i] = (byte) (i * 31 + 7);
    }
    try (
      ArchiveAdapter.Staged staged = adapter.receiveFiles(
        sizes(large),
        tests().getAssets().open("windows-large.bin"),
        new ArchiveControl(),
        null
      )
    ) {
      assertEquals(
        ArchiveFormat.hex(ArchiveFormat.sha256().digest(large)),
        digest(staged.openFile("f000001"))
      );
    }
    List<ArchiveAdapter.Outgoing> files = new ArrayList<>();
    for (int i = 0; i < 3; i++) {
      final int index = i;
      ArchiveModel.Source source = new ArchiveModel.Source() {
        @Override
        public ArchiveModel.Observation observe(ArchiveControl control) {
          return new ArchiveModel.Observation(
            "fixture-" + index,
            "fixture-" + (index + 1),
            null,
            "固定夹具",
            (long) contents[index].length,
            null
          );
        }

        @Override
        public InputStream open(ArchiveControl control) {
          return new ByteArrayInputStream(contents[index]);
        }
      };
      files.add(
        new ArchiveAdapter.Outgoing(source, "fixture-" + (i + 1), contents[i].length, null)
      );
    }
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    adapter.sendFiles(files, output, new ArchiveControl(), null);
    byte[] bytes = output.toByteArray();
    assertArrayEquals(
      Base64.getDecoder().decode(fixture.getString("tarBase64")),
      smallBytes(new java.util.zip.GZIPInputStream(new ByteArrayInputStream(bytes)))
    );
    // 保留合成格式产物，供主机上用桌面端的接收实现复验；不含真实数据。
    Files.write(context().getCacheDir().toPath().resolve("archive-device-java.gz"), bytes);
    assertCleanCache();
  }

  private final class Selected {

    final DirectoryStore store = new DirectoryStore(context());
    final String rootId;
    final String deviceId;
    final List<JSONObject> entries = new ArrayList<>();
    final List<String> nested = new ArrayList<>();

    Selected() throws Exception {
      String expected = InstrumentationRegistry.getArguments().getString("archiveExpectedName");
      assertNotNull(
        "Pass archiveExpectedName for the explicitly selected synthetic directory",
        expected
      );
      assertTrue(expected.startsWith("SaveDataSync-Archive-"));
      JSONArray roots = store.listRoots(new CancellationSignal());
      JSONObject selected = null;
      for (int i = 0; i < roots.length(); i++) {
        JSONObject root = roots.getJSONObject(i);
        if (expected.equals(root.getString("displayName"))) {
          assertNull(selected);
          selected = root;
        }
      }
      assertNotNull(
        "Select the exact synthetic directory through the system READ picker first",
        selected
      );
      assertEquals("granted", selected.getString("authorization"));
      rootId = selected.getString("rootId");
      deviceId = selected.getString("deviceId");
      JSONArray top = store
        .listDirectory(rootId, null, new CancellationSignal())
        .getJSONArray("entries");
      assertEquals(4, top.length());
      for (int i = 0; i < top.length(); i++) {
        JSONObject item = top.getJSONObject(i);
        if (item.getString("kind").equals("directory")) {
          JSONArray child = store
            .listDirectory(rootId, item.getString("entryId"), new CancellationSignal())
            .getJSONArray("entries");
          assertEquals(1, child.length());
          entries.add(child.getJSONObject(0));
          nested.add(child.getJSONObject(0).getString("entryId"));
        } else {
          entries.add(item);
        }
      }
      assertEquals(4, entries.size());
      entries.sort(Comparator.comparing(item -> item.optString("name")));
    }

    List<ArchiveAdapter.Outgoing> outgoing() throws Exception {
      List<ArchiveAdapter.Outgoing> files = new ArrayList<>();
      for (JSONObject entry : entries) {
        String entryId = entry.getString("entryId");
        files.add(
          new ArchiveAdapter.Outgoing(
            new DirectoryArchiveSource(store, rootId, entryId),
            entryId,
            entry.getLong("sizeBytes"),
            entry.isNull("modifiedAt") ? null : entry.getLong("modifiedAt")
          )
        );
      }
      return files;
    }
  }

  @Test
  public void actualSafStreamsRoundTripWithoutChangingSource() throws Exception {
    Selected selected = new Selected();
    Map<String, String> before = new HashMap<>();
    for (JSONObject entry : selected.entries) {
      before.put(
        entry.getString("entryId"),
        digest(
          selected.store.openFile(
            selected.rootId,
            entry.getString("entryId"),
            new CancellationSignal()
          )
        )
      );
    }
    ArchiveAdapter adapter = DirectoryArchiveSource.createAdapter(context());
    Path packed = context().getCacheDir().toPath().resolve("archive-saf-roundtrip.gz");
    try {
      try (OutputStream output = Files.newOutputStream(packed)) {
        adapter.sendFiles(selected.outgoing(), output, new ArchiveControl(), null);
      }
      // 保留这次合成的 SAF 归档和成员清单，供桌面端独立解包；不保存真实目录内容。
      Files.copy(
        packed,
        context().getCacheDir().toPath().resolve("archive-device-saf.gz"),
        java.nio.file.StandardCopyOption.REPLACE_EXISTING
      );
      JSONArray listing = new JSONArray();
      List<Long> sizes = new ArrayList<>();
      long total = 0;
      for (JSONObject entry : selected.entries) {
        JSONObject record = new JSONObject();
        record.put("name", entry.getString("name"));
        record.put("sizeBytes", entry.getLong("sizeBytes"));
        record.put("isNested", selected.nested.contains(entry.getString("entryId")));
        listing.put(record);
        sizes.add(entry.getLong("sizeBytes"));
        total += entry.getLong("sizeBytes");
      }
      assertEquals(131073 + 12 + 11, total);
      Files.write(
        context().getCacheDir().toPath().resolve("archive-device-saf-files.json"),
        listing.toString().getBytes(StandardCharsets.UTF_8)
      );
      try (
        ArchiveAdapter.Staged received = adapter.receiveFiles(
          sizes,
          Files.newInputStream(packed),
          new ArchiveControl(),
          null
        )
      ) {
        for (int i = 0; i < selected.entries.size(); i++) {
          assertEquals(
            before.get(selected.entries.get(i).getString("entryId")),
            digest(received.openFile(ArchiveModel.id(i)))
          );
        }
      }
      assertCleanCache();
    } finally {
      Files.deleteIfExists(packed);
      adapter.retryCleanup();
    }
    for (JSONObject entry : selected.entries) {
      assertEquals(
        before.get(entry.getString("entryId")),
        digest(
          selected.store.openFile(
            selected.rootId,
            entry.getString("entryId"),
            new CancellationSignal()
          )
        )
      );
      selected.store.archiveObservation(
        selected.rootId,
        entry.getString("entryId"),
        new CancellationSignal()
      );
    }
    report("实际 SAF 已验证：4 文件、含已有子目录，源内容和属性保持，缓存释放");
  }

  private void assertCleanCache() throws Exception {
    Path root = context().getCacheDir().toPath().resolve("transfer-archives-v1");
    try (java.nio.file.DirectoryStream<Path> entries = Files.newDirectoryStream(root)) {
      List<String> names = new ArrayList<>();
      for (Path entry : entries) {
        names.add(entry.getFileName().toString());
      }
      assertEquals(Collections.singletonList("owner"), names);
    }
  }

  private void report(String message) {
    Bundle report = new Bundle();
    report.putString("stream", message);
    InstrumentationRegistry.getInstrumentation().sendStatus(0, report);
  }
}
