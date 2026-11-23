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
import java.util.Set;
import java.util.UUID;

/**
 * 游戏封面文件，存在一个目录里，文件名是 {@code <游戏 ID>.<posterHash>.webp}。
 *
 * <p>不加锁：同一目录的 prune 和 save 由调用方串行执行。read 可以和它们同时执行：save 先写临时文件再改名，
 * read 不会读到写了一半的文件；prune 删掉的只是调用方没有保留的文件。
 */
final class PosterStore {

  private static final String POSTER_EXTENSION = ".webp";
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

  /** 返回游戏封面的文件名；参数由调用方保证格式正确。 */
  static String fileName(String gameId, String posterHash) {
    return gameId + "." + posterHash + POSTER_EXTENSION;
  }

  /**
   * 删除不在 keptFileNames 里的文件；子目录不动，单个文件删不掉时跳过。
   *
   * @param keptFileNames 要保留的文件名，由 {@link #fileName} 生成。
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
   * @param content WebP 文件内容。
   * @return 文件内容的 SHA-256，64 位小写十六进制。
   * @throws PosterFailure gameId 不符合 {@link PosterRules#isOpaqueId} 或内容不是 WebP 时 code 为
   *     invalid-request；超过 {@link PosterRules#MAX_SAVED_BYTES} 时为 resource-limit；写入失败时为 io-failure。
   */
  String save(String gameId, byte[] content) throws PosterFailure {
    if (!PosterRules.isOpaqueId(gameId) || !isWebp(content)) {
      throw new PosterFailure("invalid-request", "The poster must be a WebP image.");
    }
    if (content.length > PosterRules.MAX_SAVED_BYTES) {
      throw new PosterFailure("resource-limit", "The poster file is too large.");
    }
    String posterHash = sha256(content);
    File target = new File(directory, fileName(gameId, posterHash));
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
   * @return WebP 文件内容。
   * @throws PosterFailure gameId 不符合 {@link PosterRules#isOpaqueId} 或 posterHash 不符合
   *     {@link PosterRules#isPosterHash} 时 code 为 invalid-request；文件不存在时为 not-found；读取失败时为
   *     io-failure。
   */
  byte[] read(String gameId, String posterHash) throws PosterFailure {
    if (!PosterRules.isOpaqueId(gameId) || !PosterRules.isPosterHash(posterHash)) {
      throw new PosterFailure("invalid-request", "The poster parameters are invalid.");
    }
    try {
      return Files.readAllBytes(new File(directory, fileName(gameId, posterHash)).toPath());
    } catch (NoSuchFileException cause) {
      throw new PosterFailure("not-found", "The poster file does not exist.", cause);
    } catch (IOException cause) {
      throw new PosterFailure("io-failure", "Failed to read the poster.", cause);
    }
  }

  private static boolean isWebp(byte[] content) {
    return (
      content.length >= 12 &&
      new String(content, 0, 4, StandardCharsets.ISO_8859_1).equals("RIFF") &&
      new String(content, 8, 4, StandardCharsets.ISO_8859_1).equals("WEBP")
    );
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
