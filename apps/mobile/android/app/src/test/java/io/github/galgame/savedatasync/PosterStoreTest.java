package io.github.galgame.savedatasync;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.io.File;
import java.nio.file.Files;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** 封面文件的保存、读取和清理。 */
public class PosterStoreTest {

  // 各格式只要文件开头的标识字节对，后面的内容不影响存取。
  private static final Map<String, byte[]> IMAGES = new LinkedHashMap<>();

  static {
    IMAGES.put("webp", new byte[] { 'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'E', 'B', 'P', 1, 2 });
    IMAGES.put("jpeg", new byte[] { (byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0, 1, 2 });
    IMAGES.put("png", new byte[] { (byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 1, 2 });
  }

  @Rule
  public TemporaryFolder folder = new TemporaryFolder();

  @Test
  public void savedPostersReadBackInEveryFormat() throws Exception {
    PosterStore store = new PosterStore(folder.getRoot());
    for (byte[] image : IMAGES.values()) {
      String posterHash = store.save("game-1", image);
      assertArrayEquals(image, store.read("game-1", posterHash));
    }
  }

  @Test
  public void contentThatIsNotWebpJpegOrPngIsRejected() {
    PosterStore store = new PosterStore(folder.getRoot());
    PosterFailure failure = assertThrows(PosterFailure.class, () ->
      store.save("game-1", new byte[] { 'G', 'I', 'F', '8', '9', 'a' })
    );
    assertEquals("invalid-request", failure.code);
    assertEquals(0, folder.getRoot().list().length);
  }

  @Test
  public void earlierWebpFilesStayReadable() throws Exception {
    byte[] image = IMAGES.get("webp");
    // 借另一个目录算出 posterHash，再按以前的文件名直接写入。
    String posterHash = new PosterStore(folder.newFolder("scratch")).save("game-1", image);
    File directory = folder.newFolder("posters");
    Files.write(new File(directory, "game-1." + posterHash + ".webp").toPath(), image);
    assertArrayEquals(image, new PosterStore(directory).read("game-1", posterHash));
  }

  @Test
  public void pruneKeepsReferencedPostersOfEveryFormat() throws Exception {
    PosterStore store = new PosterStore(folder.getRoot());
    Map<String, String> games = new LinkedHashMap<>();
    Set<String> kept = new HashSet<>();
    for (Map.Entry<String, byte[]> image : IMAGES.entrySet()) {
      String gameId = "game-" + image.getKey();
      String posterHash = store.save(gameId, image.getValue());
      games.put(gameId, posterHash);
      kept.addAll(PosterStore.fileNames(gameId, posterHash));
    }
    String unused = store.save("game-unused", IMAGES.get("png"));
    store.prune(kept);
    for (Map.Entry<String, String> game : games.entrySet()) {
      store.read(game.getKey(), game.getValue());
    }
    PosterFailure failure = assertThrows(PosterFailure.class, () ->
      store.read("game-unused", unused)
    );
    assertEquals("not-found", failure.code);
    assertEquals(games.size(), folder.getRoot().list().length);
  }
}
