package io.github.galgame.savedatasync;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * 游戏封面文件，存在一个目录里，文件名是 {@code <游戏 ID>.<posterHash>.<扩展名>}，扩展名按文件格式：WebP 为
 * {@code .webp}，JPEG 为 {@code .jpg}，PNG 为 {@code .png}。
 *
 * <p>不加锁：同一目录的 prune 和 save 由调用方串行执行。read 可以和它们同时执行：save 先写临时文件再改名，
 * read 不会读到写了一半的文件；prune 删掉的只是调用方没有保留的文件。
 */
final class PosterStore {

  private static final List<String> POSTER_EXTENSIONS = List.of(".webp", ".jpg", ".png");
  private static final byte[] PNG_SIGNATURE = {
    (byte) 0x89,
    'P',
    'N',
    'G',
    '\r',
    '\n',
    0x1a,
    '\n',
  };
  private static final char[] HEX = "0123456789abcdef".toCharArray();

  private final File directory;

  /**
   * 创建封面文件存储。
   *
   * @param directory 存放封面的目录，不存在时 prune 和 save 会创建。
   */
  PosterStore(File directory) {
    this.directory = directory;
  }

  /**
   * 返回游戏封面可能的文件名，每种格式一个；参数由调用方保证格式正确。
   *
   * <p>posterHash 是文件内容的 hash，同一个 posterHash 实际只有其中一个文件。
   */
  static List<String> fileNames(String gameId, String posterHash) {
    List<String> names = new ArrayList<>();
    for (String extension : POSTER_EXTENSIONS) {
      names.add(gameId + "." + posterHash + extension);
    }
    return names;
  }

  /**
   * 删除不在 keptFileNames 里的文件；子目录不动，单个文件删不掉时跳过。
   *
   * @param keptFileNames 要保留的文件名，由 {@link #fileNames} 生成。
   * @throws IOException 目录建不了或列不出来时抛出。
   */
  void prune(Set<String> keptFileNames) throws IOException {
    Files.createDirectories(directory.toPath());
    File[] entries = directory.listFiles();
    if (entries == null) {
      throw new IOException("The poster directory cannot be listed.");
    }
    for (File entry : entries) {
      if (!entry.isFile() || keptFileNames.contains(entry.getName())) {
        continue;
      }
      try {
        Files.deleteIfExists(entry.toPath());
      } catch (IOException ignored) {
        /* 留下的文件不影响使用，下次启动再删。 */
      }
    }
  }

  /**
   * 保存一个游戏的封面；同样内容的文件已存在时覆盖。
   *
   * @param content 封面文件内容，格式按开头的字节判断。
   * @return 文件内容的 SHA-256，64 位小写十六进制。
   * @throws PosterFailure gameId 不符合 {@link PosterRules#isOpaqueId} 或内容不是 WebP、JPEG、PNG 时 code 为
   *     invalid-request；超过 {@link PosterRules#MAX_SAVED_BYTES} 时为 resource-limit；写入失败时为 io-failure。
   */
  String save(String gameId, byte[] content) throws PosterFailure {
    String extension = extensionOf(content);
    if (!PosterRules.isOpaqueId(gameId) || extension == null) {
      throw new PosterFailure("invalid-request", "The poster must be a WebP, JPEG or PNG image.");
    }
    if (content.length > PosterRules.MAX_SAVED_BYTES) {
      throw new PosterFailure("resource-limit", "The poster file is too large.");
    }
    String posterHash = sha256(content);
    File target = new File(directory, gameId + "." + posterHash + extension);
    File temporary = new File(directory, target.getName() + "." + UUID.randomUUID() + ".tmp");
    try {
      Files.createDirectories(directory.toPath());
      Files.write(temporary.toPath(), content, StandardOpenOption.CREATE_NEW);
      Files.move(
        temporary.toPath(),
        target.toPath(),
        StandardCopyOption.REPLACE_EXISTING,
        StandardCopyOption.ATOMIC_MOVE
      );
    } catch (IOException cause) {
      try {
        Files.deleteIfExists(temporary.toPath());
      } catch (IOException ignored) {
        /* 临时文件不在任何游戏的引用里，下次 prune 会删掉。 */
      }
      throw new PosterFailure("io-failure", "Failed to save the poster.", cause);
    }
    return posterHash;
  }

  /**
   * 读出一个游戏的封面。
   *
   * @return 封面文件内容。
   * @throws PosterFailure gameId 不符合 {@link PosterRules#isOpaqueId} 或 posterHash 不符合
   *     {@link PosterRules#isPosterHash} 时 code 为 invalid-request；文件不存在时为 not-found；读取失败时为
   *     io-failure。
   */
  byte[] read(String gameId, String posterHash) throws PosterFailure {
    if (!PosterRules.isOpaqueId(gameId) || !PosterRules.isPosterHash(posterHash)) {
      throw new PosterFailure("invalid-request", "The poster parameters are invalid.");
    }
    for (String name : fileNames(gameId, posterHash)) {
      try {
        return Files.readAllBytes(new File(directory, name).toPath());
      } catch (NoSuchFileException ignored) {
        /* 换下一种格式的文件名。 */
      } catch (IOException cause) {
        throw new PosterFailure("io-failure", "Failed to read the poster.", cause);
      }
    }
    throw new PosterFailure("not-found", "The poster file does not exist.");
  }

  /** 按文件开头的字节返回封面格式对应的扩展名；不是 WebP、JPEG、PNG 时返回 null。 */
  private static String extensionOf(byte[] content) {
    if (
      content.length >= 12 &&
      new String(content, 0, 4, StandardCharsets.ISO_8859_1).equals("RIFF") &&
      new String(content, 8, 4, StandardCharsets.ISO_8859_1).equals("WEBP")
    ) {
      return ".webp";
    }
    if (
      content.length >= 3 &&
      content[0] == (byte) 0xff &&
      content[1] == (byte) 0xd8 &&
      content[2] == (byte) 0xff
    ) {
      return ".jpg";
    }
    if (
      content.length >= PNG_SIGNATURE.length &&
      Arrays.equals(Arrays.copyOf(content, PNG_SIGNATURE.length), PNG_SIGNATURE)
    ) {
      return ".png";
    }
    return null;
  }

  private static String sha256(byte[] content) {
    byte[] digest;
    try {
      digest = MessageDigest.getInstance("SHA-256").digest(content);
    } catch (NoSuchAlgorithmException cause) {
      // Java 平台规范要求每个实现都提供 SHA-256。
      throw new IllegalStateException(cause);
    }
    char[] text = new char[digest.length * 2];
    for (int i = 0; i < digest.length; i++) {
      text[i * 2] = HEX[(digest[i] >> 4) & 0xf];
      text[i * 2 + 1] = HEX[digest[i] & 0xf];
    }
    return new String(text);
  }
}
