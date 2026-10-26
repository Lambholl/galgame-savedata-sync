package io.github.galgame.savedatasync;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.ArrayList;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

/** 真实回环 TCP 验证 HttpURLConnection 配置与严格响应边界，不以假的传输接口替代 IO。 */
public class TransferHttpTest {
    private static final byte[] OK = "{\"status\":\"success\",\"value\":true}".getBytes(StandardCharsets.UTF_8);
    private interface Response { void run(Socket socket, String headers, byte[] request) throws Exception; }
    private static final class Server implements AutoCloseable {
        final ServerSocket server = new ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress());
        final AtomicReference<Throwable> failure = new AtomicReference<>();
        final Thread thread;
        Server(Response response) throws Exception {
            thread = new Thread(() -> {
                try (Socket socket = server.accept()) {
                    socket.setSoTimeout(4000); InputStream input = socket.getInputStream(); ByteArrayOutputStream header = new ByteArrayOutputStream();
                    String value;
                    do { int b = input.read(); if (b < 0 || header.size() > 16384) throw new java.io.IOException("请求头无效"); header.write(b); value = header.toString("US-ASCII"); } while (!value.endsWith("\r\n\r\n"));
                    int size = 0;
                    for (String line : value.split("\r\n")) if (line.toLowerCase(java.util.Locale.ROOT).startsWith("content-length:")) size = Integer.parseInt(line.substring(15).trim());
                    assertTrue(size < 200000); ByteArrayOutputStream body = new ByteArrayOutputStream(); byte[] buffer = new byte[65536];
                    while (body.size() < size) { int n = input.read(buffer, 0, Math.min(buffer.length, size - body.size())); if (n < 0) throw new java.io.IOException("请求截断"); body.write(buffer, 0, n); }
                    response.run(socket, value, body.toByteArray());
                } catch (Throwable cause) { if (!server.isClosed()) failure.set(cause); }
            }, "raw-http-fixture"); thread.setDaemon(true); thread.start();
        }
        String address() { return "http://127.0.0.1:" + server.getLocalPort(); }
        @Override public void close() throws Exception { server.close(); thread.join(5000); assertFalse(thread.isAlive()); if (failure.get() != null) throw new AssertionError(failure.get()); }
    }
    private static byte[] response(int status, String headers, byte[] body) {
        byte[] head = ("HTTP/1.1 " + status + " Test\r\nCache-Control: no-store\r\nConnection: close\r\n" + headers + "\r\n").getBytes(StandardCharsets.US_ASCII);
        byte[] all = new byte[head.length + body.length]; System.arraycopy(head, 0, all, 0, head.length); System.arraycopy(body, 0, all, head.length, body.length); return all;
    }
    private static String jsonHeaders(byte[] bytes) { return "Content-Type: application/json\r\nContent-Length: " + bytes.length + "\r\n"; }
    @Test public void fixedJsonUsesIdentityNoProxyNoRedirectAndClosedConnection() throws Exception {
        try (Server server = new Server((socket, headers, bytes) -> {
            assertTrue(headers.contains("Accept-Encoding: identity")); assertFalse(headers.toLowerCase(java.util.Locale.ROOT).contains("transfer-encoding:"));
            assertTrue(headers.toLowerCase(java.util.Locale.ROOT).contains("x-sync-session-id: session-1"));
            assertEquals("{\"a\":1}", new String(bytes, StandardCharsets.UTF_8)); socket.getOutputStream().write(response(200, jsonHeaders(OK), OK));
        })) {
            Object result = new TransferHttp.Client(server.address()).json("POST", "/v1/test", "session-1", TransferJson.object("a", 1), 200, new ArchiveControl());
            assertEquals(Boolean.TRUE, result);
        }
    }
    @Test public void rejectsEncodingRedirectAmbiguousHeadersAndOversizedJsonBeforeConsumption() throws Exception {
        for (String header : new String[] {
            jsonHeaders(OK) + "Content-Encoding: gzip\r\n",
            jsonHeaders(OK) + "Transfer-Encoding: chunked\r\n",
            jsonHeaders(OK) + "Content-Length: 1\r\n",
            "Content-Type: application/json\r\nContent-Length: 8388609\r\n",
            "Content-Type: text/plain\r\nContent-Length: " + OK.length + "\r\n"
        }) {
            try (Server server = new Server((socket, headers, bytes) -> socket.getOutputStream().write(response(200, header, OK)))) {
                assertThrows(Exception.class, () -> new TransferHttp.Client(server.address()).json("GET", "/v1/test", null, null, 200, new ArchiveControl()));
            }
        }
        try (Server server = new Server((socket, headers, bytes) -> socket.getOutputStream().write(response(302, jsonHeaders(OK) + "Location: /v1/other\r\n", OK)))) {
            assertEquals("invalid-request", assertThrows(ArchiveFailure.class, () -> new TransferHttp.Client(server.address()).json("GET", "/v1/test", null, null, 200, new ArchiveControl())).code);
        }
    }
    @Test public void malformedUtf8AndDuplicateJsonNeverReachSchemaAsValidObjects() throws Exception {
        for (byte[] body : new byte[][] {new byte[] {(byte) 0xc0, (byte) 0xaf}, "{\"status\":\"success\",\"status\":\"success\",\"value\":true}".getBytes(StandardCharsets.UTF_8)}) {
            try (Server server = new Server((socket, headers, bytes) -> socket.getOutputStream().write(response(200, jsonHeaders(body), body)))) {
                assertThrows(Exception.class, () -> new TransferHttp.Client(server.address()).json("GET", "/v1/test", null, null, 200, new ArchiveControl()));
            }
        }
    }
    @Test public void archiveUploadHasExactLengthHashAndBoundedBuffers() throws Exception {
        byte[] content = new byte[131073]; for (int i = 0; i < content.length; i++) content[i] = (byte) (i * 31 + 7);
        String hash = ArchiveFormat.hex(ArchiveFormat.sha256().digest(content)); List<Long> progress = new ArrayList<>();
        try (Server server = new Server((socket, headers, bytes) -> {
            assertArrayEquals(content, bytes); assertTrue(headers.toLowerCase(java.util.Locale.ROOT).contains("x-archive-sha256: " + hash));
            assertTrue(headers.contains("Content-Length: 131073")); socket.getOutputStream().write(response(202, jsonHeaders(OK), OK));
        })) {
            InputStream source = new ByteArrayInputStream(content) {
                @Override public synchronized int read(byte[] bytes, int offset, int length) { assertTrue(length <= 65536); return super.read(bytes, offset, length); }
            };
            assertEquals(Boolean.TRUE, new TransferHttp.Client(server.address()).upload("/v1/transfers/id/content", "session-1", new ArchiveModel.Descriptor(content.length, 1024, hash), source,
                new ArchiveControl(), (stage, count, total) -> progress.add(count)));
            assertEquals(Long.valueOf(content.length), progress.get(progress.size() - 1));
        }
    }
    @Test public void archiveHeaderMismatchIsRejectedBeforeOpeningBody() throws Exception {
        String hash = ArchiveFormat.hex(ArchiveFormat.sha256().digest(new byte[] {1}));
        try (Server server = new Server((socket, headers, bytes) -> socket.getOutputStream().write(response(200,
            "Content-Type: application/gzip\r\nContent-Length: 1\r\nx-archive-sha256: " + "a".repeat(64) + "\r\n", new byte[] {1})))) {
            assertEquals("invalid-request", assertThrows(ArchiveFailure.class, () -> new TransferHttp.Client(server.address()).download("/v1/transfers/id/content", "session-1",
                new ArchiveModel.Descriptor(1, 1024, hash), new ArchiveControl(), null)).code);
        }
    }
    @Test public void networkIdleDeadlineAndCancellationWakeBlockedReads() throws Exception {
        try (Server server = new Server((socket, headers, bytes) -> Thread.sleep(600))) {
            assertEquals("timeout", assertThrows(ArchiveFailure.class, () -> new TransferHttp.Client(server.address(), 150).json("GET", "/v1/test", null, null, 200, new ArchiveControl())).code);
        }
        CountDownLatch waiting = new CountDownLatch(1); ArchiveControl control = new ArchiveControl(); AtomicReference<Throwable> result = new AtomicReference<>();
        try (Server server = new Server((socket, headers, bytes) -> { waiting.countDown(); Thread.sleep(600); })) {
            Thread worker = new Thread(() -> { try { new TransferHttp.Client(server.address(), 1000).json("GET", "/v1/test", null, null, 200, control); } catch (Throwable cause) { result.set(cause); } });
            worker.start(); assertTrue(waiting.await(3, TimeUnit.SECONDS)); control.cancel(); worker.join(3000); assertFalse(worker.isAlive());
            assertTrue(result.get() instanceof ArchiveFailure); assertTrue(((ArchiveFailure) result.get()).cancelled);
        }
    }
    @Test public void platformRuntimeCloseFailureCannotCrashLifecycleOrSkipOtherResources() throws Exception {
        ArchiveControl control = new ArchiveControl(); CountDownLatch closed = new CountDownLatch(1);
        control.track((java.io.Closeable) () -> { throw new IllegalStateException("模拟平台并发关闭异常"); });
        control.track((java.io.Closeable) closed::countDown); control.cancel();
        assertEquals(0, closed.getCount()); assertTrue(assertThrows(ArchiveFailure.class, control::check).cancelled);
    }
}
