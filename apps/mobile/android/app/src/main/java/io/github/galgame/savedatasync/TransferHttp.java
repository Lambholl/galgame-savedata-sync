package io.github.galgame.savedatasync;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import static io.github.galgame.savedatasync.TransferJson.*;

/** 可注入 HTTP 边界；文件仅为原生有限流，控制 JSON 单独限额，任何副作用都不自动重放。 */
interface TransferHttp {
    Object json(String method, String path, String session, Object body, int expected, ArchiveControl control) throws Exception;
    InputStream download(String path, String session, ArchiveModel.Descriptor archive, ArchiveControl control, ArchiveModel.Progress progress) throws Exception;
    Object upload(String path, String session, ArchiveModel.Descriptor archive, InputStream input, ArchiveControl control, ArchiveModel.Progress progress) throws Exception;

    /** 默认无代理、无缓存、无重定向、Accept-Encoding identity；固定长度写流禁止认证/重定向重放。 */
    final class Client implements TransferHttp {
        private static final ScheduledExecutorService WATCH = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "transfer-network-deadlines"); t.setDaemon(true); return t;
        });
        private final String address;
        private final int idleMillis;
        Client(String address) throws Exception { this(address, 60000); }
        Client(String address, int idleMillis) throws Exception {
            this.address = address(address); if (idleMillis <= 0 || idleMillis > 60000) throw new IllegalArgumentException("Invalid idle budget");
            this.idleMillis = idleMillis;
        }
        static String address(String value) throws Exception {
            if (value == null || value.length() > 256) throw fail("invalid-request");
            URI uri = new URI(value); String host = uri.getHost();
            if (!"http".equals(uri.getScheme()) || host == null || uri.getUserInfo() != null || uri.getRawQuery() != null || uri.getFragment() != null ||
                (uri.getRawPath() != null && !uri.getRawPath().isEmpty() && !uri.getRawPath().equals("/")) || uri.getPort() == 0 || uri.getPort() > 65535) throw fail("invalid-request");
            if (host.startsWith("[")) host = host.substring(1, host.length() - 1);
            if (host.contains(":")) {
                if (!host.matches("[a-fA-F0-9:]+") || !(java.net.InetAddress.getByName(host) instanceof java.net.Inet6Address)) throw fail("invalid-request");
            } else {
                if (!host.matches("(?:0|[1-9][0-9]{0,2})(?:\\.(?:0|[1-9][0-9]{0,2})){3}")) throw fail("invalid-request");
                for (String part : host.split("\\.")) if (Integer.parseInt(part) > 255) throw fail("invalid-request");
            }
            return new URI("http", null, host, uri.getPort(), null, null, null).toASCIIString();
        }
        private final class Call implements Closeable {
            final HttpURLConnection connection;
            final ArchiveControl control;
            final ScheduledFuture<?> watchdog;
            volatile long lastProgress = System.nanoTime();
            volatile boolean timedOut;
            private volatile boolean closed;
            Call(String method, String path, String session, ArchiveControl control) throws Exception {
                if (!path.startsWith("/v1/") || path.contains("#") || path.contains("\r") || path.contains("\n")) throw fail("invalid-request");
                this.control = control; control.check();
                connection = (HttpURLConnection) new URI(address + path).toURL().openConnection(Proxy.NO_PROXY);
                connection.setConnectTimeout(idleMillis); connection.setReadTimeout(idleMillis);
                connection.setInstanceFollowRedirects(false); connection.setUseCaches(false); connection.setRequestMethod(method);
                connection.setRequestProperty("Accept-Encoding", "identity"); connection.setRequestProperty("Cache-Control", "no-store");
                connection.setRequestProperty("Connection", "close");
                if (session != null) { TransferSchema.id(session); connection.setRequestProperty("x-sync-session-id", session); }
                watchdog = WATCH.scheduleAtFixedRate(() -> {
                    try { control.check(); }
                    catch (ArchiveFailure cause) { connection.disconnect(); return; }
                    if (System.nanoTime() - lastProgress >= TimeUnit.MILLISECONDS.toNanos(idleMillis)) { timedOut = true; connection.disconnect(); }
                }, 100, 100, TimeUnit.MILLISECONDS);
                control.track(this);
            }
            void progressed() throws ArchiveFailure { control.check(); lastProgress = System.nanoTime(); if (timedOut) throw fail("timeout"); }
            ArchiveFailure failure(Exception cause) {
                try { control.check(); } catch (ArchiveFailure cancelled) { return cancelled; }
                if (timedOut || cause instanceof java.net.SocketTimeoutException) return fail("timeout");
                if (cause instanceof ArchiveFailure) return (ArchiveFailure) cause;
                return new ArchiveFailure("network-failure", "网络连接中断，请查询并核实实际结果", false, cause);
            }
            InputStream ownedInput(InputStream input) {
                Thread owner = Thread.currentThread();
                return new FilterInputStream(input) {
                    @Override public void close() throws IOException {
                        // Android Okio 的缓冲源不能与 read 并发 close；取消线程只断开 socket。
                        Call.this.close(); if (Thread.currentThread() == owner) super.close();
                    }
                };
            }
            OutputStream ownedOutput(OutputStream output) {
                Thread owner = Thread.currentThread();
                return new java.io.FilterOutputStream(output) {
                    @Override public void write(byte[] bytes, int offset, int length) throws IOException { out.write(bytes, offset, length); }
                    @Override public void close() throws IOException {
                        if (Thread.currentThread() == owner) super.close(); else Call.this.close();
                    }
                };
            }
            String header(String key, boolean required) throws Exception {
                List<String> found = new ArrayList<>();
                for (Map.Entry<String, List<String>> e : connection.getHeaderFields().entrySet()) if (key.equalsIgnoreCase(e.getKey())) found.addAll(e.getValue());
                if (found.isEmpty() && !required) return null;
                if (found.size() != 1) throw fail("invalid-request");
                String value = found.get(0); if (value == null || value.contains("\r") || value.contains("\n")) throw fail("invalid-request"); return value;
            }
            void headers(boolean content, ArchiveModel.Descriptor archive) throws Exception {
                if (header("Content-Encoding", false) != null) throw fail("invalid-request");
                String cache = header("Cache-Control", true);
                if (!java.util.Arrays.asList(cache.toLowerCase(java.util.Locale.ROOT).split("\\s*,\\s*")).contains("no-store")) throw fail("invalid-request");
                String length = header("Content-Length", false), transfer = header("Transfer-Encoding", false);
                if (length != null && (!length.matches("0|[1-9][0-9]*") || length.length() > 12)) throw fail("invalid-request");
                if (transfer != null && (length != null || !transfer.equalsIgnoreCase("chunked") || content)) throw fail("invalid-request");
                if (content) {
                    if (!"application/gzip".equals(header("Content-Type", true)) || length == null || Long.parseLong(length) != archive.sizeBytes ||
                        !archive.sha256.equals(header("x-archive-sha256", true))) throw fail("invalid-request");
                } else {
                    String type = header("Content-Type", true).toLowerCase(java.util.Locale.ROOT).replace(" ", "");
                    if (!type.equals("application/json") && !type.equals("application/json;charset=utf-8")) throw fail("invalid-request");
                    if (length != null && Long.parseLong(length) > MAX_BYTES) throw fail("resource-limit");
                }
            }
            Object response(int expected) throws Exception {
                int status = connection.getResponseCode(); progressed(); headers(false, null);
                InputStream raw = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                if (raw == null) throw fail("invalid-request"); InputStream input = ownedInput(raw); Object parsed;
                try (InputStream stream = control.track(input); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[65536]; int n;
                    while ((n = stream.read(buffer)) >= 0) {
                        if (n == 0) throw fail("network-failure"); progressed();
                        if (bytes.size() > MAX_BYTES - n) throw fail("resource-limit"); bytes.write(buffer, 0, n);
                    }
                    parsed = parse(bytes.toByteArray());
                } finally { control.untrack(input); }
                Map<String, Object> envelope = map(parsed);
                if (status != expected) {
                    if (status < 400 || !"error".equals(envelope.get("status"))) throw fail("invalid-request");
                    TransferSchema.shape(envelope, "status", "error"); Map<String, Object> error = TransferSchema.error(envelope.get("error"));
                    String code = TransferSchema.string(error.get("code")); if (errorStatus(code) != status) throw fail("invalid-request");
                    throw fail(code);
                }
                return TransferSchema.unwrap(envelope);
            }
            @Override public void close() { if (!closed) { closed = true; watchdog.cancel(false); connection.disconnect(); control.untrack(this); } }
        }
        @Override public Object json(String method, String path, String session, Object body, int expected, ArchiveControl control) throws Exception {
            Call call = new Call(method, path, session, control);
            try {
                if (body != null) {
                    byte[] bytes = bytes(body); call.connection.setDoOutput(true); call.connection.setFixedLengthStreamingMode(bytes.length);
                    call.connection.setRequestProperty("Content-Type", "application/json");
                    OutputStream output = control.track(call.ownedOutput(call.connection.getOutputStream()));
                    try (OutputStream stream = output) { for (int offset = 0; offset < bytes.length;) {
                        control.check(); int n = Math.min(65536, bytes.length - offset); stream.write(bytes, offset, n); offset += n; call.progressed();
                    } } finally { control.untrack(output); }
                }
                return call.response(expected);
            } catch (Exception cause) { throw call.failure(cause); } finally { call.close(); }
        }
        @Override public InputStream download(String path, String session, ArchiveModel.Descriptor archive, ArchiveControl control, ArchiveModel.Progress progress) throws Exception {
            Call call = new Call("GET", path, session, control);
            try {
                if (call.connection.getResponseCode() != 200) { call.response(200); throw fail("invalid-request"); }
                call.progressed(); call.headers(true, archive); InputStream input = call.ownedInput(call.connection.getInputStream());
                return new FilterInputStream(input) {
                    private long count;
                    @Override public int read() throws IOException { byte[] one = new byte[1]; int n = read(one, 0, 1); return n < 0 ? -1 : one[0] & 255; }
                    @Override public int read(byte[] bytes, int offset, int length) throws IOException {
                        try {
                            control.check(); int n = in.read(bytes, offset, Math.min(length, 65536));
                            if (n > 0) { count += n; if (count > archive.sizeBytes) throw fail("checksum-mismatch"); call.progressed(); if (progress != null) progress.update("transferring", count, archive.sizeBytes); }
                            if (n < 0 && count != archive.sizeBytes) throw fail("checksum-mismatch"); return n;
                        } catch (Exception cause) { throw call.failure(cause); }
                    }
                    @Override public void close() throws IOException { try { super.close(); } finally { call.close(); } }
                };
            } catch (Exception cause) { call.close(); throw call.failure(cause); }
        }
        @Override public Object upload(String path, String session, ArchiveModel.Descriptor archive, InputStream input, ArchiveControl control, ArchiveModel.Progress progress) throws Exception {
            Call call = new Call("PUT", path, session, control);
            try {
                call.connection.setDoOutput(true); call.connection.setFixedLengthStreamingMode(archive.sizeBytes);
                call.connection.setRequestProperty("Content-Type", "application/gzip"); call.connection.setRequestProperty("x-archive-sha256", archive.sha256);
                InputStream source = control.track(input);
                try {
                    OutputStream output = control.track(call.ownedOutput(call.connection.getOutputStream()));
                    try (OutputStream stream = output) {
                        byte[] buffer = new byte[65536]; long count = 0; java.security.MessageDigest hash = ArchiveFormat.sha256(); int n;
                        while ((n = source.read(buffer)) >= 0) {
                            control.check(); if (n == 0 || count > archive.sizeBytes - n) throw fail("checksum-mismatch");
                            stream.write(buffer, 0, n); count += n; hash.update(buffer, 0, n); call.progressed();
                            if (progress != null) progress.update("transferring", count, archive.sizeBytes);
                        }
                        if (count != archive.sizeBytes || !archive.sha256.equals(ArchiveFormat.hex(hash.digest()))) throw fail("checksum-mismatch");
                    } finally { control.untrack(output); }
                } finally { try { source.close(); } finally { control.untrack(source); } }
                return call.response(202);
            } catch (Exception cause) { throw call.failure(cause); } finally { call.close(); }
        }
        private static int errorStatus(String code) {
            switch (code) {
                case "invalid-request": return 400;
                case "protocol-mismatch": case "session-mismatch": case "task-conflict": case "name-conflict": case "source-changed": return 409;
                case "permission-denied": case "authorization-expired": case "not-readable": case "path-outside-root": return 403;
                case "not-found": case "result-unknown": return 404;
                case "invalid-archive": case "checksum-mismatch": return 422;
                case "resource-limit": return 413;
                case "busy": return 429;
                case "timeout": return 408;
                case "unsupported-operation": return 501;
                case "insufficient-space": return 507;
                case "io-failure": case "cleanup-failed": return 500;
                default: return -1;
            }
        }
    }
}
