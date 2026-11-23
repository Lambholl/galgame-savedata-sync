package io.github.galgame.savedatasync;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 封面执行器的白名单和上限，取值和共享包 poster-contracts.ts 的 POSTER_API_HOSTS、POSTER_IMAGE_HOSTS、
 * POSTER_LIMITS、POSTER_TIMEOUTS_MS 相同。
 */
final class PosterRules {

  /** 允许请求接口的主机。 */
  static final List<String> API_HOSTS = Collections.unmodifiableList(
    Arrays.asList(
      "api.vndb.org",
      "api.bgm.tv",
      "store.steampowered.com",
      "api.steampowered.com",
      "api.nextmoe.dev"
    )
  );
  /** 允许下载图片的主机。 */
  static final List<String> IMAGE_HOSTS = Collections.unmodifiableList(
    Arrays.asList(
      "t.vndb.org",
      "lain.bgm.tv",
      "shared.akamai.steamstatic.com",
      "image.kungal.iloveren.link"
    )
  );
  /** JSON 响应体的最大长度，单位是 UTF-16 码元。 */
  static final int MAX_JSON_CHARS = 4 * 1024 * 1024;
  /** 下载或从本机选取的图片的最大字节数。 */
  static final int MAX_IMAGE_BYTES = 20 * 1024 * 1024;
  /** 保存的封面文件的最大字节数。 */
  static final int MAX_SAVED_BYTES = 1024 * 1024;
  /** 请求头的最多条数。 */
  static final int MAX_REQUEST_HEADERS = 16;
  /** 建立连接的超时，单位毫秒。 */
  static final int CONNECT_TIMEOUT_MS = 15_000;
  /** 两次读到数据之间的超时，单位毫秒。 */
  static final int READ_TIMEOUT_MS = 20_000;
  /** 项目主页，写在 User-Agent 里。 */
  static final String PROJECT_HOMEPAGE = "https://github.com/Lambholl/galgame-savedata-sync";

  private static final Pattern HTTPS_HOST = Pattern.compile(
    "^https://([a-z0-9.-]+)(?::443)?(?:[/?#]|$)",
    Pattern.CASE_INSENSITIVE
  );
  private static final Pattern OPAQUE_ID = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$");
  private static final Pattern POSTER_HASH = Pattern.compile("^[0-9a-f]{64}$");

  private PosterRules() {}

  /** 取 https 地址的主机名（小写）；url 为 null 或不是 https 地址时返回 null。 */
  static String httpsHost(String url) {
    if (url == null) {
      return null;
    }
    Matcher matcher = HTTPS_HOST.matcher(url);
    return matcher.find() ? matcher.group(1).toLowerCase(Locale.ROOT) : null;
  }

  /** 判断接口请求是否允许：方法是 GET 或 POST，https 且主机在 API_HOSTS 里，只有 POST 带请求体。 */
  static boolean isRequestAllowed(String method, String url, String body) {
    String host = httpsHost(url);
    boolean isPost = "POST".equals(method);
    return (
      ("GET".equals(method) || isPost) &&
      host != null &&
      API_HOSTS.contains(host) &&
      isPost == (body != null)
    );
  }

  /** 判断图片地址是否允许下载：https 且主机在 IMAGE_HOSTS 里。 */
  static boolean isImageUrl(String url) {
    String host = httpsHost(url);
    return host != null && IMAGE_HOSTS.contains(host);
  }

  /** 校验游戏 ID 的格式，规则同共享包的 isOpaqueId。 */
  static boolean isOpaqueId(String value) {
    return value != null && OPAQUE_ID.matcher(value).matches();
  }

  /** 校验封面 hash：64 位小写十六进制。 */
  static boolean isPosterHash(String value) {
    return value != null && POSTER_HASH.matcher(value).matches();
  }

  /** 生成执行器使用的 User-Agent，格式和共享包的 createPosterUserAgent 相同。 */
  static String userAgent(String appVersion) {
    return "Lambholl/galgame-savedata-sync/" + appVersion + " (Android) (" + PROJECT_HOMEPAGE + ")";
  }
}
