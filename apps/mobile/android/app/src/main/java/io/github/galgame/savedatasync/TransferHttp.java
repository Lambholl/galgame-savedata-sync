package io.github.galgame.savedatasync;

import static io.github.galgame.savedatasync.TransferJson.MAX_BYTES;
import static io.github.galgame.savedatasync.TransferJson.bytes;
import static io.github.galgame.savedatasync.TransferJson.fail;
import static io.github.galgame.savedatasync.TransferJson.map;
import static io.github.galgame.savedatasync.TransferJson.parse;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/** 传输用的 HTTP 接口：文件走有限长度的原生流，控制 JSON 单独限额；有副作用的请求只发一次。 */
interface TransferHttp {
  /** 返回复制任务用的客户端：地址相同，带设备头，网络期限 60 秒；默认实现返回自身。 */
  default TransferHttp forSync(String localDeviceId) throws Exception {
    TransferSchema.id(localDeviceId);
    return this;
  }

  /** 返回控制通道连接的地址；没有实际地址时返回 null。 */
  default String origin() {
    return null;
  }

  Object json(
    String method,
    String path,
    String session,
    Object body,
    int expected,
    ArchiveControl control
  ) throws Exception;

  default Object json(
    String method,
    String path,
    String session,
    Object body,
    int expected,
    ArchiveControl control,
    boolean isNewConnection
  ) throws Exception {
    return json(method, path, session, body, expected, control);
  }

  InputStream download(
    String path,
    String session,
    ArchiveModel.Descriptor archive,
    ArchiveControl control,
    ArchiveModel.Progress progress
  ) throws Exception;

  Object upload(
    String path,
    String session,
    ArchiveModel.Descriptor archive,
    InputStream input,
    ArchiveControl control,
    ArchiveModel.Progress progress
  ) throws Exception;

  /** 把内容写进请求体的回调。 */
  interface ContentWriter {
    void write(OutputStream output) throws Exception;
  }

  /** GET 长度不定的 application/gzip 内容；返回的流由调用方关闭。 */
  default InputStream downloadStream(String path, String session, ArchiveControl control)
    throws Exception {
    throw fail("unsupported-operation");
  }

  /** 以 chunked 方式 PUT writer 写出的 application/gzip 内容，返回 202 响应的值。writer 失败时断开连接，接收端收到的请求体不完整。 */
  default Object uploadStream(
    String path,
    String session,
    ContentWriter writer,
    ArchiveControl control
  ) throws Exception {
    throw fail("unsupported-operation");
  }

  /** HTTP 客户端：直连，关闭缓存和重定向，Accept-Encoding 为 identity；请求体用固定长度流发送，只发一次。 */
  final class Client implements TransferHttp {

    private static final ScheduledExecutorService WATCH =
      Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "transfer-network-deadlines");
        t.setDaemon(true);
        return t;
      });
    private final String address;
    private final int idleMillis;
    private final String syncDeviceId;

    Client(String address) throws Exception {
      this(address, 5000);
    }

    Client(String address, int idleMillis) throws Exception {
      this(address, idleMillis, null);
    }

    private Client(String address, int idleMillis, String syncDeviceId) throws Exception {
      this.address = address(address);
      if (idleMillis <= 0 || idleMillis > 60000) {
        throw new IllegalArgumentException("Invalid idle budget");
      }
      this.idleMillis = idleMillis;
      this.syncDeviceId = syncDeviceId;
    }

    @Override
    public TransferHttp forSync(String localDeviceId) throws Exception {
      return new Client(address, 60000, TransferSchema.id(localDeviceId));
    }

    @Override
    public String origin() {
      return address;
    }

    static String address(String value) throws Exception {
      if (value == null || value.length() > 256) {
        throw fail("invalid-request");
      }
      URI uri = new URI(value);
      String host = uri.getHost();
      if (
        !"http".equals(uri.getScheme()) ||
        host == null ||
        uri.getUserInfo() != null ||
        uri.getRawQuery() != null ||
        uri.getFragment() != null ||
        (uri.getRawPath() != null &&
          !uri.getRawPath().isEmpty() &&
          !uri.getRawPath().equals("/")) ||
        uri.getPort() == 0 ||
        uri.getPort() > 65535
      ) {
        throw fail("invalid-request");
      }
      if (host.startsWith("[")) {
        host = host.substring(1, host.length() - 1);
      }
      if (host.contains(":")) {
        if (
          !host.matches("[a-fA-F0-9:]+") ||
          !(java.net.InetAddress.getByName(host) instanceof java.net.Inet6Address)
        ) {
          throw fail("invalid-request");
        }
      } else {
        if (!host.matches("(?:0|[1-9][0-9]{0,2})(?:\\.(?:0|[1-9][0-9]{0,2})){3}")) {
          throw fail("invalid-request");
        }
        for (String part : host.split("\\.")) {
          if (Integer.parseInt(part) > 255) {
            throw fail("invalid-request");
          }
        }
      }
      return new URI("http", null, host, uri.getPort(), null, null, null).toASCIIString();
    }

    private final class Call implements Closeable {

      final HttpURLConnection connection;
      final ArchiveControl control;
      final ScheduledFuture<?> watchdog;
      volatile long lastProgress = System.nanoTime();
      volatile boolean hasTimedOut;
      private volatile boolean isClosed;

      Call(String method, String path, String session, ArchiveControl control) throws Exception {
        if (
          !path.startsWith("/v1/") ||
          path.contains("#") ||
          path.contains("\r") ||
          path.contains("\n")
        ) {
          throw fail("invalid-request");
        }
        this.control = control;
        control.check();
        connection = (HttpURLConnection) new URI(address + path)
          .toURL()
          .openConnection(Proxy.NO_PROXY);
        connection.setConnectTimeout(Math.min(idleMillis, 5000));
        connection.setReadTimeout(idleMillis);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestMethod(method);
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setRequestProperty("Cache-Control", "no-store");
        connection.setRequestProperty("Connection", "close");
        if (session != null) {
          TransferSchema.id(session);
          connection.setRequestProperty("x-sync-session-id", session);
        }
        if (syncDeviceId != null && path.startsWith("/v1/sync/")) {
          connection.setRequestProperty("x-sync-device-id", syncDeviceId);
        }
        watchdog = WATCH.scheduleAtFixedRate(
          () -> {
            try {
              control.check();
            } catch (ArchiveFailure cause) {
              connection.disconnect();
              return;
            }
            if (System.nanoTime() - lastProgress >= TimeUnit.MILLISECONDS.toNanos(idleMillis)) {
              hasTimedOut = true;
              connection.disconnect();
            }
          },
          100,
          100,
          TimeUnit.MILLISECONDS
        );
        control.track(this);
      }

      void progressed() throws ArchiveFailure {
        control.check();
        lastProgress = System.nanoTime();
        if (hasTimedOut) {
          throw fail("timeout");
        }
      }

      ArchiveFailure failure(Exception cause) {
        try {
          control.check();
        } catch (ArchiveFailure cancelled) {
          return new ArchiveFailure(cancelled.code, cancelled.code, cancelled.isCancelled, cause);
        }
        if (hasTimedOut || cause instanceof java.net.SocketTimeoutException) {
          return new ArchiveFailure("timeout", "timeout", false, cause);
        }
        if (cause instanceof ArchiveFailure) {
          return (ArchiveFailure) cause;
        }
        return new ArchiveFailure(
          "network-failure",
          "The network connection was interrupted. Query and verify the actual result.",
          false,
          cause
        );
      }

      InputStream ownedInput(InputStream input) {
        Thread owner = Thread.currentThread();
        return new FilterInputStream(input) {
          @Override
          public void close() throws IOException {
            // Android Okio 的缓冲源不能与 read 并发 close；取消线程只断开 socket。
            Call.this.close();
            if (Thread.currentThread() == owner) {
              super.close();
            }
          }
        };
      }

      OutputStream ownedOutput(OutputStream output) {
        Thread owner = Thread.currentThread();
        return new java.io.FilterOutputStream(output) {
          @Override
          public void write(byte[] bytes, int offset, int length) throws IOException {
            out.write(bytes, offset, length);
          }

          @Override
          public void close() throws IOException {
            if (Thread.currentThread() == owner) {
              super.close();
            } else {
              Call.this.close();
            }
          }
        };
      }

      String header(String key, boolean isRequired) throws Exception {
        List<String> found = new ArrayList<>();
        for (Map.Entry<String, List<String>> e : connection.getHeaderFields().entrySet()) {
          if (key.equalsIgnoreCase(e.getKey())) {
            found.addAll(e.getValue());
          }
        }
        if (found.isEmpty() && !isRequired) {
          return null;
        }
        if (found.size() != 1) {
          throw fail("invalid-request");
        }
        String value = found.get(0);
        if (value == null || value.contains("\r") || value.contains("\n")) {
          throw fail("invalid-request");
        }
        return value;
      }

      void headers(boolean hasContent, ArchiveModel.Descriptor archive) throws Exception {
        if (header("Content-Encoding", false) != null) {
          throw fail("invalid-request");
        }
        String cache = header("Cache-Control", true);
        if (
          !java.util.Arrays.asList(
            cache.toLowerCase(java.util.Locale.ROOT).split("\\s*,\\s*")
          ).contains("no-store")
        ) {
          throw fail("invalid-request");
        }
        String length = header("Content-Length", false);
        String transfer = header("Transfer-Encoding", false);
        if (length != null && (!length.matches("0|[1-9][0-9]*") || length.length() > 12)) {
          throw fail("invalid-request");
        }
        if (
          transfer != null &&
          (length != null ||
            !transfer.equalsIgnoreCase("chunked") ||
            (hasContent && archive != null))
        ) {
          throw fail("invalid-request");
        }
        if (hasContent) {
          if (!"application/gzip".equals(header("Content-Type", true))) {
            throw fail("invalid-request");
          }
          // 复制内容长度不定，完整性由 gzip 的 CRC 和长度保证；批量传输的定长内容还要核对长度和哈希。
          if (
            archive != null &&
            (length == null ||
              Long.parseLong(length) != archive.sizeBytes ||
              !archive.sha256.equals(header("x-archive-sha256", true)))
          ) {
            throw fail("invalid-request");
          }
        } else {
          String type = header("Content-Type", true)
            .toLowerCase(java.util.Locale.ROOT)
            .replace(" ", "");
          if (!type.equals("application/json") && !type.equals("application/json;charset=utf-8")) {
            throw fail("invalid-request");
          }
          if (length != null && Long.parseLong(length) > MAX_BYTES) {
            throw fail("resource-limit");
          }
        }
      }

      Object response(int expected) throws Exception {
        int status = connection.getResponseCode();
        progressed();
        headers(false, null);
        InputStream raw = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        if (raw == null) {
          throw fail("invalid-request");
        }
        InputStream input = ownedInput(raw);
        Object parsed;
        try (
          InputStream stream = control.track(input);
          ByteArrayOutputStream bytes = new ByteArrayOutputStream()
        ) {
          byte[] buffer = new byte[65536];
          int n;
          while ((n = stream.read(buffer)) >= 0) {
            if (n == 0) {
              throw fail("network-failure");
            }
            progressed();
            if (bytes.size() > MAX_BYTES - n) {
              throw fail("resource-limit");
            }
            bytes.write(buffer, 0, n);
          }
          parsed = parse(bytes.toByteArray());
        } finally {
          control.untrack(input);
        }
        Map<String, Object> envelope = map(parsed);
        if (status != expected) {
          if (status < 400 || !"error".equals(envelope.get("status"))) {
            throw fail("invalid-request");
          }
          TransferSchema.shape(envelope, "status", "error");
          Map<String, Object> error = TransferSchema.error(envelope.get("error"));
          String code = TransferSchema.string(error.get("code"));
          if (errorStatus(code) != status) {
            throw fail("invalid-request");
          }
          throw new ArchiveFailure(code, code, false, null, "HTTP " + status + " / " + code);
        }
        return TransferSchema.unwrap(envelope);
      }

      @Override
      public void close() {
        if (!isClosed) {
          isClosed = true;
          watchdog.cancel(false);
          connection.disconnect();
          control.untrack(this);
        }
      }
    }

    @Override
    public Object json(
      String method,
      String path,
      String session,
      Object body,
      int expected,
      ArchiveControl control
    ) throws Exception {
      return json(method, path, session, body, expected, control, false);
    }

    @Override
    public Object json(
      String method,
      String path,
      String session,
      Object body,
      int expected,
      ArchiveControl control,
      boolean isNewConnection
    ) throws Exception {
      Call call = new Call(method, path, session, control);
      try {
        if (isNewConnection) {
          call.connection.setRequestProperty("x-sync-connect", "1");
        }
        if (body != null) {
          byte[] bytes = bytes(body);
          call.connection.setDoOutput(true);
          call.connection.setFixedLengthStreamingMode(bytes.length);
          call.connection.setRequestProperty("Content-Type", "application/json");
          OutputStream output = control.track(call.ownedOutput(call.connection.getOutputStream()));
          try (OutputStream stream = output) {
            for (int offset = 0; offset < bytes.length; ) {
              control.check();
              int n = Math.min(65536, bytes.length - offset);
              stream.write(bytes, offset, n);
              offset += n;
              call.progressed();
            }
          } finally {
            control.untrack(output);
          }
        }
        return call.response(expected);
      } catch (Exception cause) {
        throw call.failure(cause);
      } finally {
        call.close();
      }
    }

    @Override
    public InputStream download(
      String path,
      String session,
      ArchiveModel.Descriptor archive,
      ArchiveControl control,
      ArchiveModel.Progress progress
    ) throws Exception {
      Call call = new Call("GET", path, session, control);
      try {
        if (call.connection.getResponseCode() != 200) {
          call.response(200);
          throw fail("invalid-request");
        }
        call.progressed();
        call.headers(true, archive);
        InputStream input = call.ownedInput(call.connection.getInputStream());
        return new FilterInputStream(input) {
          private long count;

          @Override
          public int read() throws IOException {
            byte[] one = new byte[1];
            int n = read(one, 0, 1);
            return n < 0 ? -1 : one[0] & 255;
          }

          @Override
          public int read(byte[] bytes, int offset, int length) throws IOException {
            try {
              control.check();
              int n = in.read(bytes, offset, Math.min(length, 65536));
              if (n > 0) {
                count += n;
                if (count > archive.sizeBytes) {
                  throw fail("checksum-mismatch");
                }
                call.progressed();
                if (progress != null) {
                  progress.update("transferring", count, archive.sizeBytes);
                }
              }
              if (n < 0 && count != archive.sizeBytes) {
                throw fail("checksum-mismatch");
              }
              return n;
            } catch (Exception cause) {
              throw call.failure(cause);
            }
          }

          @Override
          public void close() throws IOException {
            try {
              super.close();
            } finally {
              call.close();
            }
          }
        };
      } catch (Exception cause) {
        call.close();
        throw call.failure(cause);
      }
    }

    @Override
    public Object upload(
      String path,
      String session,
      ArchiveModel.Descriptor archive,
      InputStream input,
      ArchiveControl control,
      ArchiveModel.Progress progress
    ) throws Exception {
      Call call = new Call("PUT", path, session, control);
      try {
        call.connection.setDoOutput(true);
        call.connection.setFixedLengthStreamingMode(archive.sizeBytes);
        call.connection.setRequestProperty("Content-Type", "application/gzip");
        call.connection.setRequestProperty("x-archive-sha256", archive.sha256);
        InputStream source = control.track(input);
        try {
          OutputStream output = control.track(call.ownedOutput(call.connection.getOutputStream()));
          try (OutputStream stream = output) {
            byte[] buffer = new byte[65536];
            long count = 0;
            java.security.MessageDigest hash = ArchiveFormat.sha256();
            int n;
            while ((n = source.read(buffer)) >= 0) {
              control.check();
              if (n == 0 || count > archive.sizeBytes - n) {
                throw fail("checksum-mismatch");
              }
              stream.write(buffer, 0, n);
              count += n;
              hash.update(buffer, 0, n);
              call.progressed();
              if (progress != null) {
                progress.update("transferring", count, archive.sizeBytes);
              }
            }
            if (
              count != archive.sizeBytes || !archive.sha256.equals(ArchiveFormat.hex(hash.digest()))
            ) {
              throw fail("checksum-mismatch");
            }
          } finally {
            control.untrack(output);
          }
        } finally {
          try {
            source.close();
          } finally {
            control.untrack(source);
          }
        }
        return call.response(202);
      } catch (Exception cause) {
        throw call.failure(cause);
      } finally {
        call.close();
      }
    }

    @Override
    public InputStream downloadStream(String path, String session, ArchiveControl control)
      throws Exception {
      Call call = new Call("GET", path, session, control);
      try {
        if (call.connection.getResponseCode() != 200) {
          call.response(200);
          throw fail("invalid-request");
        }
        call.progressed();
        call.headers(true, null);
        InputStream input = call.ownedInput(call.connection.getInputStream());
        return new FilterInputStream(input) {
          @Override
          public int read() throws IOException {
            byte[] one = new byte[1];
            int n = read(one, 0, 1);
            return n < 0 ? -1 : one[0] & 255;
          }

          @Override
          public int read(byte[] bytes, int offset, int length) throws IOException {
            try {
              control.check();
              int n = in.read(bytes, offset, Math.min(length, 65536));
              if (n > 0) {
                call.progressed();
              }
              return n;
            } catch (Exception cause) {
              throw call.failure(cause);
            }
          }

          @Override
          public void close() throws IOException {
            try {
              super.close();
            } finally {
              call.close();
            }
          }
        };
      } catch (Exception cause) {
        call.close();
        throw call.failure(cause);
      }
    }

    @Override
    public Object uploadStream(
      String path,
      String session,
      ContentWriter writer,
      ArchiveControl control
    ) throws Exception {
      Call call = new Call("PUT", path, session, control);
      try {
        call.connection.setDoOutput(true);
        call.connection.setChunkedStreamingMode(65536);
        call.connection.setRequestProperty("Content-Type", "application/gzip");
        OutputStream output = control.track(call.ownedOutput(call.connection.getOutputStream()));
        try {
          writer.write(
            new java.io.FilterOutputStream(output) {
              @Override
              public void write(byte[] bytes, int offset, int length) throws IOException {
                try {
                  control.check();
                  out.write(bytes, offset, length);
                  call.progressed();
                } catch (Exception cause) {
                  throw call.failure(cause);
                }
              }

              @Override
              public void close() {
                // writer 关闭输出时只刷新：提前发出结尾的空块会让接收端以为请求体已经完整。
              }
            }
          );
        } catch (Exception cause) {
          // 先断开连接再关闭输出，接收端看到的是中断的请求体，而不是提前结束的完整请求。
          call.close();
          throw cause;
        } finally {
          try {
            output.close();
          } catch (IOException ignored) {
            /* 已断开的连接关闭时可能再报错，原因以上面的异常为准。 */
          } finally {
            control.untrack(output);
          }
        }
        return call.response(202);
      } catch (Exception cause) {
        throw call.failure(cause);
      } finally {
        call.close();
      }
    }

    private static int errorStatus(String code) {
      switch (code) {
        case "invalid-request":
          return 400;
        case "protocol-mismatch":
        case "session-mismatch":
        case "task-conflict":
        case "name-conflict":
        case "source-changed":
          return 409;
        case "permission-denied":
        case "authorization-expired":
        case "not-readable":
        case "path-outside-root":
          return 403;
        case "not-found":
        case "result-unknown":
          return 404;
        case "invalid-archive":
        case "checksum-mismatch":
          return 422;
        case "resource-limit":
          return 413;
        case "busy":
          return 429;
        case "timeout":
          return 408;
        case "unsupported-operation":
          return 501;
        case "insufficient-space":
          return 507;
        case "io-failure":
        case "cleanup-failed":
          return 500;
        default:
          return -1;
      }
    }
  }
}
