package io.github.galgame.savedatasync;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/** 封面接口和图片的 https 执行器；方法会阻塞到读完响应，在后台线程调用。 */
final class PosterHttp {

  /** 一个 UTF-16 码元按 UTF-8 编码最多占 3 字节，用来在解码前限制 JSON 响应体的字节数。 */
  private static final int MAX_JSON_BYTES = PosterRules.MAX_JSON_CHARS * 3;

  private static final Pattern IMAGE_MIME_TYPE = Pattern.compile("^image/[a-z0-9.+-]+$");

  /** 接口响应。 */
  static final class TextResponse {

    final int status;
    /** 响应没有 Content-Type 时为 null。 */
    final String contentType;
    final String body;

    TextResponse(int status, String contentType, String body) {
      this.status = status;
      this.contentType = contentType;
      this.body = body;
    }
  }

  /** 下载的图片。 */
  static final class ImageResponse {

    /** 小写、不带参数的 MIME 类型，如 image/jpeg。 */
    final String mimeType;
    final byte[] data;

    ImageResponse(String mimeType, byte[] data) {
      this.mimeType = mimeType;
      this.data = data;
    }
  }

  private static final class RawResponse {

    final int status;
    final String contentType;
    final byte[] body;

    RawResponse(int status, String contentType, byte[] body) {
      this.status = status;
      this.contentType = contentType;
      this.body = body;
    }
  }

  /** 响应体超过调用方给的字节上限。 */
  private static final class BodyTooLargeException extends IOException {

    BodyTooLargeException() {
      super("The response body is too large.");
    }
  }

  private final String userAgent;

  /**
   * 创建执行器。
   *
   * @param userAgent 每个请求都带的 User-Agent，即 {@link PosterRules#userAgent} 的结果。
   */
  PosterHttp(String userAgent) {
    this.userAgent = userAgent;
  }

  /**
   * 执行接口请求，收到任意 HTTP 状态码都返回响应。
   *
   * @param body GET 时为 null，POST 时为 UTF-8 请求体。
   * @throws PosterFailure 请求不符合 {@link PosterRules#isRequestAllowed}、请求头超过
   *     {@link PosterRules#MAX_REQUEST_HEADERS} 条或不合法时 code 为 invalid-request；连不上、超时或响应体超过
   *     {@link PosterRules#MAX_JSON_CHARS} 时为 network-failure。
   */
  TextResponse request(String method, String url, Map<String, String> headers, String body)
    throws PosterFailure {
    if (
      !PosterRules.isRequestAllowed(method, url, body) ||
      headers.size() > PosterRules.MAX_REQUEST_HEADERS
    ) {
      throw new PosterFailure("invalid-request", "The poster request is not allowed.");
    }
    RawResponse response;
    try {
      response = send(url, method, headers, body, MAX_JSON_BYTES);
    } catch (IllegalArgumentException cause) {
      // HttpURLConnection 对不合法的请求头名称或值抛 IllegalArgumentException。
      throw new PosterFailure("invalid-request", "The poster request headers are invalid.", cause);
    } catch (IOException cause) {
      throw networkFailure(cause);
    }
    String text = new String(response.body, StandardCharsets.UTF_8);
    if (text.length() > PosterRules.MAX_JSON_CHARS) {
      throw networkFailure(new BodyTooLargeException());
    }
    return new TextResponse(response.status, response.contentType, text);
  }

  /**
   * 下载图片。
   *
   * @throws PosterFailure 地址不符合 {@link PosterRules#isImageUrl} 时 code 为 invalid-request；HTTP 404 时为
   *     not-found；超过 {@link PosterRules#MAX_IMAGE_BYTES} 时为 resource-limit；连不上、超时、其他非 2xx
   *     状态、响应不是图片或响应体为空时为 network-failure。
   */
  ImageResponse downloadImage(String url) throws PosterFailure {
    if (!PosterRules.isImageUrl(url)) {
      throw new PosterFailure("invalid-request", "The image address is not allowed.");
    }
    RawResponse response;
    try {
      response = send(url, "GET", Map.of("Accept", "image/*"), null, PosterRules.MAX_IMAGE_BYTES);
    } catch (BodyTooLargeException cause) {
      throw new PosterFailure("resource-limit", "The image is too large.", cause);
    } catch (IOException cause) {
      throw networkFailure(cause);
    }
    if (response.status == 404) {
      throw new PosterFailure("not-found", "The image no longer exists.");
    }
    String mimeType =
      response.contentType == null
        ? ""
        : response.contentType.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
    if (
      response.status < 200 ||
      response.status > 299 ||
      !IMAGE_MIME_TYPE.matcher(mimeType).matches() ||
      response.body.length == 0
    ) {
      throw networkFailure(
        new IOException("Unexpected image response: HTTP " + response.status + " " + mimeType)
      );
    }
    return new ImageResponse(mimeType, response.body);
  }

  private static PosterFailure networkFailure(Throwable cause) {
    return new PosterFailure("network-failure", "The poster source is unreachable.", cause);
  }

  /**
   * 发一次 https 请求并读完响应体；不跟随重定向，3xx 原样返回。
   *
   * @throws BodyTooLargeException 响应体超过 maxBytes 时抛出。
   * @throws IOException 连接超时、读取超时、连接中断或响应体经过压缩时抛出。
   */
  private RawResponse send(
    String url,
    String method,
    Map<String, String> headers,
    String body,
    int maxBytes
  ) throws IOException {
    HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
    try {
      connection.setInstanceFollowRedirects(false);
      connection.setUseCaches(false);
      connection.setConnectTimeout(PosterRules.CONNECT_TIMEOUT_MS);
      // 读超时作用于等待响应头和两次读到数据之间。
      connection.setReadTimeout(PosterRules.READ_TIMEOUT_MS);
      connection.setRequestMethod(method);
      for (Map.Entry<String, String> header : headers.entrySet()) {
        connection.setRequestProperty(header.getKey(), header.getValue());
      }
      connection.setRequestProperty("User-Agent", userAgent);
      // 不写这个头时 HttpURLConnection 会自己请求 gzip 并透明解压，字节上限就管不住解压后的大小。
      connection.setRequestProperty("Accept-Encoding", "identity");
      if (body != null) {
        byte[] content = body.getBytes(StandardCharsets.UTF_8);
        connection.setDoOutput(true);
        connection.setFixedLengthStreamingMode(content.length);
        try (OutputStream output = connection.getOutputStream()) {
          output.write(content);
        }
      }
      int status = connection.getResponseCode();
      String encoding = connection.getContentEncoding();
      if (encoding != null && !encoding.equalsIgnoreCase("identity")) {
        throw new IOException("The response uses an unsupported encoding: " + encoding);
      }
      if (connection.getContentLengthLong() > maxBytes) {
        throw new BodyTooLargeException();
      }
      // 4xx、5xx 的响应体要从 getErrorStream 读；没有响应体时它返回 null。
      InputStream stream =
        status >= 400 ? connection.getErrorStream() : connection.getInputStream();
      byte[] content = stream == null ? new byte[0] : readAll(stream, maxBytes);
      return new RawResponse(status, connection.getContentType(), content);
    } finally {
      connection.disconnect();
    }
  }

  private static byte[] readAll(InputStream stream, int maxBytes) throws IOException {
    try (InputStream input = stream) {
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      byte[] buffer = new byte[64 * 1024];
      int size = 0;
      int read;
      while ((read = input.read(buffer)) != -1) {
        size += read;
        if (size > maxBytes) {
          throw new BodyTooLargeException();
        }
        output.write(buffer, 0, read);
      }
      return output.toByteArray();
    }
  }
}
