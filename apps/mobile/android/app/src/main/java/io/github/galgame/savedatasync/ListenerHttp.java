package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.fail;
import static io.github.galgame.savedatasync.TransferJson.object;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 本机服务的 HTTP/1.1 读写：请求体支持 Content-Length 和 chunked，响应发送固定长度的 JSON、空响应和 WebSocket
 * 升级。
 */
final class ListenerHttp {

  /** 请求行最长字节数。 */
  static final int MAX_REQUEST_LINE = 8192;
  /** 全部请求头合计的最长字节数，与电脑服务的 maxHeaderSize 相同。 */
  static final int MAX_HEADER_BYTES = 16384;
  /** 请求头的最多条数。 */
  static final int MAX_HEADERS = 64;

  private static final Pattern TOKEN = Pattern.compile("[!#$%&'*+.^_`|~0-9A-Za-z-]+");
  private static final Pattern LENGTH = Pattern.compile("0|[1-9][0-9]{0,15}");
  private static final Pattern JSON_TYPE = Pattern.compile(
    "application/json(?:;\\s*charset=utf-8)?",
    Pattern.CASE_INSENSITIVE
  );
  private static final Map<Integer, String> REASONS = new HashMap<>();
  private static final byte[] CRLF = { '\r', '\n' };

  static {
    REASONS.put(101, "Switching Protocols");
    REASONS.put(200, "OK");
    REASONS.put(201, "Created");
    REASONS.put(202, "Accepted");
    REASONS.put(400, "Bad Request");
    REASONS.put(403, "Forbidden");
    REASONS.put(404, "Not Found");
    REASONS.put(408, "Request Timeout");
    REASONS.put(409, "Conflict");
    REASONS.put(413, "Payload Too Large");
    REASONS.put(422, "Unprocessable Entity");
    REASONS.put(429, "Too Many Requests");
    REASONS.put(500, "Internal Server Error");
    REASONS.put(501, "Not Implemented");
    REASONS.put(507, "Insufficient Storage");
  }

  private ListenerHttp() {}

  /** 一个已读完头部的请求；body 只能读一次。 */
  static final class Request {

    final String method;
    final String target;
    /** 原始头列表，依次为名称和值；名称保持原样，值去掉首尾空白。 */
    final List<String> rawHeaders;
    private final Map<String, String> headers;
    final InputStream body;

    Request(String method, String target, List<String> rawHeaders, InputStream body) {
      this.method = method;
      this.target = target;
      this.rawHeaders = Collections.unmodifiableList(rawHeaders);
      Map<String, String> values = new HashMap<>();
      for (int i = 0; i < rawHeaders.size(); i += 2) {
        values.putIfAbsent(rawHeaders.get(i).toLowerCase(Locale.ROOT), rawHeaders.get(i + 1));
      }
      this.headers = values;
      this.body = body;
    }

    /** 按小写名称读取头的值；同名头出现多次时返回第一个，没有时返回 null。 */
    String header(String name) {
      return headers.get(name);
    }

    /** 请求体是否已读到结尾；没有请求体时为 true。 */
    boolean isBodyComplete() {
      return !(body instanceof BodyStream) || ((BodyStream) body).isComplete();
    }
  }

  /** 解析后的路由，路径段只解码一次。 */
  static final class Route {

    final String kind;
    final String id;
    final String parentId;

    Route(String kind, String id, String parentId) {
      this.kind = kind;
      this.id = id;
      this.parentId = parentId;
    }
  }

  /**
   * 读取一个请求的请求行和头部。
   *
   * @return 连接在请求开始前正常结束时返回 null。
   * @throws ArchiveFailure 请求格式不对或超过上限时抛出 invalid-request 或 resource-limit。
   */
  static Request read(InputStream input) throws IOException {
    String line = line(input, MAX_REQUEST_LINE, true);
    if (line == null) {
      return null;
    }
    String[] parts = line.split(" ", -1);
    if (
      parts.length != 3 ||
      !TOKEN.matcher(parts[0]).matches() ||
      parts[1].isEmpty() ||
      !"HTTP/1.1".equals(parts[2])
    ) {
      throw fail("invalid-request");
    }
    List<String> raw = new ArrayList<>();
    int total = 0;
    while (true) {
      String header = line(input, MAX_HEADER_BYTES - total, false);
      if (header == null) {
        throw fail("invalid-request");
      }
      total += header.length() + 2;
      if (header.isEmpty()) {
        break;
      }
      int colon = header.indexOf(':');
      // 不接受折行：续行以空白开头，名称会是空的或带空白。
      if (colon <= 0 || !TOKEN.matcher(header.substring(0, colon)).matches()) {
        throw fail("invalid-request");
      }
      if (raw.size() / 2 >= MAX_HEADERS) {
        throw fail("resource-limit");
      }
      raw.add(header.substring(0, colon));
      raw.add(header.substring(colon + 1).trim());
    }
    Request headOnly = new Request(parts[0], parts[1], raw, null);
    String length = headOnly.header("content-length");
    String encoding = headOnly.header("transfer-encoding");
    InputStream body;
    if (encoding != null) {
      body = new ChunkedBody(input);
    } else if (length != null && LENGTH.matcher(length).matches() && !"0".equals(length)) {
      body = new LengthBody(input, Long.parseLong(length));
    } else {
      body = new LengthBody(input, 0);
    }
    return new Request(parts[0], parts[1], raw, body);
  }

  /** 读一行 ASCII 文本，去掉 CRLF；只接受 CRLF 结尾和可见字符、空格、制表符。 */
  private static String line(InputStream input, int limit, boolean canEnd) throws IOException {
    StringBuilder out = new StringBuilder();
    while (true) {
      int value = input.read();
      if (value < 0) {
        if (canEnd && out.length() == 0) {
          return null;
        }
        throw fail("invalid-request");
      }
      if (value == '\r') {
        if (input.read() != '\n') {
          throw fail("invalid-request");
        }
        return out.toString();
      }
      if ((value < 0x20 && value != '\t') || value >= 0x7f) {
        throw fail("invalid-request");
      }
      if (out.length() >= limit) {
        throw fail("resource-limit");
      }
      out.append((char) value);
    }
  }

  /**
   * 检查请求头并解析路由，规则与电脑服务相同；头名不区分大小写。
   *
   * @throws ArchiveFailure 头名重复，带 Content-Encoding、Range 或 Expect，长度和编码冲突，或路由不认识时
   *     抛出 invalid-request。
   */
  static Route route(Request request) throws ArchiveFailure {
    Set<String> names = new HashSet<>();
    for (int i = 0; i < request.rawHeaders.size(); i += 2) {
      if (!names.add(request.rawHeaders.get(i).toLowerCase(Locale.ROOT))) {
        throw fail("invalid-request");
      }
    }
    if (
      !names.contains("host") ||
      names.contains("content-encoding") ||
      names.contains("range") ||
      names.contains("expect")
    ) {
      throw fail("invalid-request");
    }
    String length = request.header("content-length");
    String encoding = request.header("transfer-encoding");
    if (length != null && !LENGTH.matcher(length).matches()) {
      throw fail("invalid-request");
    }
    if (encoding != null && (!"chunked".equals(encoding) || length != null)) {
      throw fail("invalid-request");
    }
    String url = request.target;
    if (
      !url.startsWith("/") ||
      url.startsWith("//") ||
      url.length() > 4096 ||
      Pattern.compile("[#\\\\\\s]").matcher(url).find()
    ) {
      throw fail("invalid-request");
    }
    String[] parts = url.split("\\?", -1);
    if (parts.length > 2) {
      throw fail("invalid-request");
    }
    List<String> segments = new ArrayList<>();
    String[] raw = parts[0].split("/", -1);
    for (int i = 1; i < raw.length; i++) {
      segments.add(decode(raw[i], false));
    }
    String parentId = null;
    if (parts.length == 2) {
      for (String field : parts[1].split("&", -1)) {
        String[] pair = field.split("=", -1);
        if (pair.length != 2) {
          throw fail("invalid-request");
        }
        String key = decode(pair[0], false);
        String value = decode(pair[1], true);
        if (!"parentId".equals(key) || parentId != null || !DocumentValues.isId(value)) {
          throw fail("invalid-request");
        }
        parentId = value;
      }
    }
    String method = request.method;
    String resource = segments.size() > 1 ? segments.get(1) : null;
    String id = segments.size() > 2 ? segments.get(2) : null;
    String action = segments.size() > 3 ? segments.get(3) : null;
    if (segments.isEmpty() || !"v1".equals(segments.get(0))) {
      throw fail("invalid-request");
    }
    String kind;
    if (segments.size() == 2 && "device".equals(resource) && "GET".equals(method)) {
      kind = "device";
    } else if (segments.size() == 2 && "catalog".equals(resource) && "POST".equals(method)) {
      kind = "catalog";
    } else if (segments.size() == 2 && "roots".equals(resource) && "GET".equals(method)) {
      kind = "roots";
    } else if (
      segments.size() == 4 &&
      "roots".equals(resource) &&
      "entries".equals(action) &&
      "GET".equals(method) &&
      DocumentValues.isId(id)
    ) {
      kind = "entries";
    } else if (segments.size() == 2 && "control".equals(resource) && "GET".equals(method)) {
      kind = "control";
    } else if ("sync".equals(resource)) {
      kind = syncKind(method, segments);
    } else {
      throw fail("invalid-request");
    }
    if (!"entries".equals(kind) && parentId != null) {
      throw fail("invalid-request");
    }
    boolean isContentUpload = "sync-job-content".equals(kind) && "PUT".equals(method);
    // 复制内容边打包边发送，事先不知道长度。
    if (isContentUpload && !"chunked".equals(encoding)) {
      throw fail("invalid-request");
    }
    if (
      !"catalog".equals(kind) &&
      !"sync-scans".equals(kind) &&
      !"sync-jobs".equals(kind) &&
      !isContentUpload &&
      (encoding != null || (length != null && !"0".equals(length)))
    ) {
      throw fail("invalid-request");
    }
    String routeId = "entries".equals(kind) ? id : kind.startsWith("sync-") ? action : null;
    return new Route(kind, routeId, parentId);
  }

  /** 复制接口的路由，规则与电脑服务的 inspectHttpRequest 相同；不认识时抛出 invalid-request。 */
  private static String syncKind(String method, List<String> segments) throws ArchiveFailure {
    String id = segments.size() > 2 ? segments.get(2) : null;
    boolean isRead = "GET".equals(method);
    if (segments.size() == 3 && "capabilities".equals(id) && isRead) {
      return "sync-capabilities";
    }
    if (segments.size() == 3 && "scans".equals(id) && "POST".equals(method)) {
      return "sync-scans";
    }
    if (segments.size() == 3 && "jobs".equals(id) && "POST".equals(method)) {
      return "sync-jobs";
    }
    String action = segments.size() > 3 ? segments.get(3) : null;
    if (!DocumentValues.isId(action)) {
      throw fail("invalid-request");
    }
    boolean isQuery = isRead || "DELETE".equals(method);
    if (segments.size() == 4 && "scans".equals(id) && isQuery) {
      return "sync-scan";
    }
    if (segments.size() == 4 && "projects".equals(id) && isRead) {
      return "sync-project";
    }
    if (segments.size() == 4 && "jobs".equals(id) && isQuery) {
      return "sync-job";
    }
    if (
      segments.size() == 5 &&
      "jobs".equals(id) &&
      "content".equals(segments.get(4)) &&
      (isRead || "PUT".equals(method))
    ) {
      return "sync-job-content";
    }
    throw fail("invalid-request");
  }

  /** 按 UTF-8 严格解码百分号编码；isQuery 时把 + 当作空格。 */
  private static String decode(String value, boolean isQuery) throws ArchiveFailure {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      if (c == '%') {
        if (i + 2 >= value.length()) {
          throw fail("invalid-request");
        }
        int high = Character.digit(value.charAt(i + 1), 16);
        int low = Character.digit(value.charAt(i + 2), 16);
        if (high < 0 || low < 0) {
          throw fail("invalid-request");
        }
        out.write(high * 16 + low);
        i += 2;
      } else if (isQuery && c == '+') {
        out.write(' ');
      } else if (c < 0x80) {
        out.write(c);
      } else {
        throw fail("invalid-request");
      }
    }
    try {
      return StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(out.toByteArray()))
        .toString();
    } catch (java.nio.charset.CharacterCodingException cause) {
      throw fail("invalid-request");
    }
  }

  /**
   * 读取 JSON 请求体：最多 {@link TransferJson#MAX_BYTES}，严格 UTF-8，不允许重复键。
   *
   * @throws ArchiveFailure Content-Type 不对、内容不完整或格式错误时抛出 invalid-request，超过上限时抛出 resource-limit。
   */
  static Object readJson(Request request) throws Exception {
    String type = request.header("content-type");
    if (type == null || !JSON_TYPE.matcher(type).matches()) {
      throw fail("invalid-request");
    }
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buffer = new byte[16384];
    int count;
    while ((count = request.body.read(buffer)) >= 0) {
      if (out.size() + count > TransferJson.MAX_BYTES) {
        throw fail("resource-limit");
      }
      out.write(buffer, 0, count);
    }
    return TransferJson.parse(out.toByteArray());
  }

  /** 读完并丢弃剩余的请求体，最多 limit 字节；超过时返回 false，连接不能再复用。 */
  static boolean drain(Request request, long limit) throws IOException {
    byte[] buffer = new byte[8192];
    long total = 0;
    int count;
    while ((count = request.body.read(buffer)) >= 0) {
      total += count;
      if (total > limit) {
        return false;
      }
    }
    return true;
  }

  /** 发送 JSON 响应，按 UTF-8 字节计长度；isClosing 时附 Connection: close。 */
  static void sendJson(OutputStream output, int status, Object value, boolean isClosing)
    throws Exception {
    byte[] body = TransferJson.bytes(value);
    StringBuilder head = new StringBuilder();
    head.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
    head.append("Content-Type: application/json; charset=utf-8\r\n");
    head.append("Content-Length: ").append(body.length).append("\r\n");
    head.append("Cache-Control: no-store\r\n");
    if (isClosing) {
      head.append("Connection: close\r\n");
    }
    head.append("\r\n");
    output.write(head.toString().getBytes(StandardCharsets.US_ASCII));
    output.write(body);
    output.flush();
  }

  /** 发送成功包络。 */
  static void sendSuccess(OutputStream output, int status, Object value) throws Exception {
    sendJson(output, status, object("status", "success", "value", value), false);
  }

  /**
   * 发送错误包络，状态码按错误码取，与共享 HTTP_ERROR_STATUS 一致。响应附 Connection: close，套接字由调用方关闭。
   */
  static void sendFailure(OutputStream output, String code, String message) throws Exception {
    sendJson(
      output,
      status(code),
      object(
        "status",
        "error",
        "error",
        // 与电脑服务相同不给重试提示：能否重试由客户端按错误码和任务状态判断。
        object("code", code, "message", message, "canRetry", false)
      ),
      true
    );
  }

  /** 发送只有状态行和响应头、没有响应体的响应。响应附 Connection: close，套接字由调用方关闭。 */
  static void sendEmpty(OutputStream output, int status) throws IOException {
    output.write(
      (
        "HTTP/1.1 " +
        status +
        " " +
        reason(status) +
        "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
      ).getBytes(StandardCharsets.US_ASCII)
    );
    output.flush();
  }

  /**
   * 以 chunked 编码发送 200 响应的输出流。第一次写入或 {@link #finish} 时先发响应头；close 不写结束块，也不关闭下层的流。
   */
  static final class ChunkedOutput extends OutputStream {

    private final OutputStream output;
    private final String contentType;
    private boolean isStarted;

    ChunkedOutput(OutputStream output, String contentType) {
      this.output = output;
      this.contentType = contentType;
    }

    /** 响应头是否已经发出；发出后出错只能关闭连接，不能再回错误包络。 */
    boolean isStarted() {
      return isStarted;
    }

    private void start() throws IOException {
      if (isStarted) {
        return;
      }
      isStarted = true;
      output.write(
        (
          "HTTP/1.1 200 OK\r\nContent-Type: " +
          contentType +
          "\r\nTransfer-Encoding: chunked\r\nCache-Control: no-store\r\n\r\n"
        ).getBytes(StandardCharsets.US_ASCII)
      );
    }

    @Override
    public void write(int value) throws IOException {
      write(new byte[] { (byte) value }, 0, 1);
    }

    @Override
    public void write(byte[] bytes, int offset, int length) throws IOException {
      start();
      if (length == 0) {
        return;
      }
      output.write((Integer.toHexString(length) + "\r\n").getBytes(StandardCharsets.US_ASCII));
      output.write(bytes, offset, length);
      output.write(CRLF);
    }

    @Override
    public void flush() throws IOException {
      output.flush();
    }

    /** 写结束块并刷新；之后这条连接可以接着读下一个请求。 */
    void finish() throws IOException {
      start();
      output.write("0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
      output.flush();
    }

    @Override
    public void close() {
      // 下层是连接的输出流，由连接线程管理；结束块只由 finish 写出。
    }
  }

  /** 错误码对应的 HTTP 状态；network-failure 等没有对应状态的按 500。 */
  static int status(String code) {
    switch (code) {
      case "invalid-request":
        return 400;
      case "protocol-mismatch":
      case "session-mismatch":
      case "task-conflict":
      case "plan-expired":
      case "name-conflict":
      case "source-changed":
        return 409;
      case "invalid-archive":
      case "checksum-mismatch":
        return 422;
      case "resource-limit":
        return 413;
      case "busy":
        return 429;
      case "timeout":
        return 408;
      case "permission-denied":
      case "authorization-expired":
      case "not-readable":
      case "path-outside-root":
        return 403;
      case "not-found":
      case "result-unknown":
        return 404;
      case "unsupported-operation":
        return 501;
      case "insufficient-space":
        return 507;
      default:
        return 500;
    }
  }

  private static String reason(int status) {
    String value = REASONS.get(status);
    return value == null ? "Status" : value;
  }

  /** 知道自己是否读到结尾的请求体。 */
  private abstract static class BodyStream extends InputStream {

    abstract boolean isComplete();
  }

  /** Content-Length 请求体：只读到声明的长度，提前断开时抛错。 */
  private static final class LengthBody extends BodyStream {

    private final InputStream input;
    private long remaining;

    LengthBody(InputStream input, long length) {
      this.input = input;
      this.remaining = length;
    }

    @Override
    boolean isComplete() {
      return remaining == 0;
    }

    @Override
    public int read() throws IOException {
      byte[] one = new byte[1];
      return read(one, 0, 1) < 0 ? -1 : one[0] & 0xff;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
      if (remaining == 0) {
        return -1;
      }
      int count = input.read(buffer, offset, (int) Math.min(length, remaining));
      if (count < 0) {
        throw fail("invalid-request");
      }
      remaining -= count;
      return count;
    }
  }

  /** 按 chunked 编码读取的请求体：块长度为十六进制，不接受块扩展和 trailer。 */
  private static final class ChunkedBody extends BodyStream {

    private final InputStream input;
    private long remaining;
    private boolean isDone;

    ChunkedBody(InputStream input) {
      this.input = input;
    }

    @Override
    boolean isComplete() {
      return isDone;
    }

    @Override
    public int read() throws IOException {
      byte[] one = new byte[1];
      return read(one, 0, 1) < 0 ? -1 : one[0] & 0xff;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
      if (isDone) {
        return -1;
      }
      if (remaining == 0) {
        String size = line(input, 16, false);
        if (!Pattern.compile("[0-9A-Fa-f]{1,15}").matcher(size).matches()) {
          throw fail("invalid-request");
        }
        remaining = Long.parseLong(size, 16);
        if (remaining == 0) {
          if (!line(input, 1024, false).isEmpty()) {
            throw fail("invalid-request");
          }
          isDone = true;
          return -1;
        }
      }
      int count = input.read(buffer, offset, (int) Math.min(length, remaining));
      if (count < 0) {
        throw fail("invalid-request");
      }
      remaining -= count;
      if (remaining == 0 && (input.read() != '\r' || input.read() != '\n')) {
        throw fail("invalid-request");
      }
      return count;
    }
  }
}
