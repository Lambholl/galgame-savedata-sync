package io.github.galgame.savedatasync;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Locale;

/**
 * 控制通道的 WebSocket 服务端连接（RFC 6455）：只收文本消息，处理分片、掩码、ping/pong 和关闭；单条消息最多 {@link #MAX_MESSAGE_BYTES}。
 * 写操作线程安全，读循环由 {@link #run} 在调用线程上执行。
 */
final class ListenerSocket {

  /** 收到的事件；回调在读线程上执行。 */
  interface Events {
    void message(ListenerSocket socket, String text);

    void pong(ListenerSocket socket);

    /** 连接结束；code 是对方发来或本机发出的关闭码，连接直接断开时为 1006。 */
    void closed(ListenerSocket socket, int code);
  }

  static final int MAX_MESSAGE_BYTES = 8388608;
  /** 本机发出关闭帧后等对方回应的最长时间（毫秒）。 */
  static final int CLOSE_WAIT_MS = 2000;
  private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  private final Socket socket;
  private final InputStream input;
  private final OutputStream output;
  private final Events events;
  private final Object writing = new Object();
  private boolean isCloseSent;
  private int closeCode = 1006;

  ListenerSocket(Socket socket, InputStream input, OutputStream output, Events events) {
    this.socket = socket;
    this.input = input;
    this.output = output;
    this.events = events;
  }

  /**
   * 核对升级请求的 WebSocket 头，返回 Sec-WebSocket-Accept 的值。
   *
   * @return 头不符合 RFC 6455 时返回 null。
   */
  static String accept(ListenerHttp.Request request) {
    String upgrade = request.header("upgrade");
    String connection = request.header("connection");
    String key = request.header("sec-websocket-key");
    if (
      upgrade == null ||
      !"websocket".equals(upgrade.toLowerCase(Locale.ROOT)) ||
      connection == null ||
      !hasToken(connection, "upgrade") ||
      !"13".equals(request.header("sec-websocket-version")) ||
      key == null
    ) {
      return null;
    }
    try {
      if (Base64.getDecoder().decode(key).length != 16) {
        return null;
      }
      MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
      return Base64.getEncoder().encodeToString(
        sha1.digest((key + GUID).getBytes(StandardCharsets.US_ASCII))
      );
    } catch (Exception invalid) {
      return null;
    }
  }

  private static boolean hasToken(String value, String token) {
    for (String part : value.split(",")) {
      if (token.equals(part.trim().toLowerCase(Locale.ROOT))) {
        return true;
      }
    }
    return false;
  }

  /** 发送 101 响应，之后连接按 WebSocket 帧读写。 */
  static void sendHandshake(OutputStream output, String accept) throws IOException {
    output.write(
      (
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: " +
        accept +
        "\r\n\r\n"
      ).getBytes(StandardCharsets.US_ASCII)
    );
    output.flush();
  }

  /** 读取帧直到连接结束；返回前一定调用一次 Events.closed，并关闭套接字。 */
  void run() {
    try {
      ByteArrayOutputStream message = null;
      while (true) {
        int first = readByte();
        int second = readByte();
        boolean isFinal = (first & 0x80) != 0;
        int opcode = first & 0x0f;
        if ((first & 0x70) != 0 || (second & 0x80) == 0) {
          // 扩展位没有协商；客户端发来的帧必须带掩码。
          close(1002, "protocol-error");
          break;
        }
        long length = second & 0x7f;
        if (length == 126) {
          length = ((long) readByte() << 8) | readByte();
        } else if (length == 127) {
          length = 0;
          for (int i = 0; i < 8; i++) {
            length = (length << 8) | readByte();
          }
          if (length < 0) {
            close(1002, "protocol-error");
            break;
          }
        }
        boolean isControl = (opcode & 0x08) != 0;
        if (isControl && (!isFinal || length > 125)) {
          close(1002, "protocol-error");
          break;
        }
        long buffered = message == null ? 0 : message.size();
        if (!isControl && buffered + length > MAX_MESSAGE_BYTES) {
          close(1009, "too-large");
          break;
        }
        byte[] mask = new byte[4];
        readFully(mask);
        byte[] payload = new byte[(int) length];
        readFully(payload);
        for (int i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i & 3];
        }
        if (opcode == 0x8) {
          int code = payload.length >= 2 ? ((payload[0] & 0xff) << 8) | (payload[1] & 0xff) : 1005;
          synchronized (writing) {
            if (closeCode == 1006) {
              closeCode = code;
            }
          }
          // 对方先发关闭时回同一个关闭码；本机先发的关闭在这里收到回应，直接结束。
          close(payload.length >= 2 ? code : 1000, "");
          break;
        }
        if (opcode == 0x9) {
          send(0xA, payload);
          continue;
        }
        if (opcode == 0xA) {
          events.pong(this);
          continue;
        }
        if (
          opcode == 0x2 || (opcode == 0x0 && message == null) || (opcode == 0x1 && message != null)
        ) {
          close(opcode == 0x2 ? 1003 : 1002, opcode == 0x2 ? "text-only" : "protocol-error");
          break;
        }
        if (opcode != 0x0 && opcode != 0x1) {
          close(1002, "protocol-error");
          break;
        }
        if (message == null) {
          message = new ByteArrayOutputStream();
        }
        message.write(payload);
        if (isFinal) {
          String text;
          try {
            text = StandardCharsets.UTF_8.newDecoder()
              .onMalformedInput(CodingErrorAction.REPORT)
              .onUnmappableCharacter(CodingErrorAction.REPORT)
              .decode(ByteBuffer.wrap(message.toByteArray()))
              .toString();
          } catch (CharacterCodingException invalid) {
            close(1007, "invalid-utf8");
            break;
          }
          message = null;
          events.message(this, text);
        }
      }
    } catch (IOException ended) {
      /* 对方断开或本机关闭了套接字；按 closeCode 报告。 */
    } finally {
      terminate();
      events.closed(this, closeCode);
    }
  }

  private int readByte() throws IOException {
    int value = input.read();
    if (value < 0) {
      throw new EOFException();
    }
    return value;
  }

  private void readFully(byte[] buffer) throws IOException {
    int offset = 0;
    while (offset < buffer.length) {
      int count = input.read(buffer, offset, buffer.length - offset);
      if (count < 0) {
        throw new EOFException();
      }
      offset += count;
    }
  }

  /** 发送一条文本消息。 */
  void sendText(String text) throws IOException {
    send(0x1, text.getBytes(StandardCharsets.UTF_8));
  }

  /** 发送 ping。 */
  void ping() throws IOException {
    send(0x9, new byte[0]);
  }

  /** 发送关闭帧；已经发过时不再发送。对方回应关闭帧或 CLOSE_WAIT_MS 后读循环关闭套接字。 */
  void close(int code, String reason) {
    byte[] text = reason.getBytes(StandardCharsets.UTF_8);
    byte[] payload = new byte[2 + Math.min(text.length, 123)];
    payload[0] = (byte) (code >> 8);
    payload[1] = (byte) code;
    System.arraycopy(text, 0, payload, 2, payload.length - 2);
    synchronized (writing) {
      if (isCloseSent) {
        return;
      }
      isCloseSent = true;
      if (closeCode == 1006) {
        closeCode = code;
      }
      try {
        frame(0x8, payload);
        // 不立即关闭套接字：对方要先读到关闭码，才能按 ListenerControl.CLOSE_DISCONNECTED、CLOSE_REPLACED 决定是否重连。
        socket.setSoTimeout(CLOSE_WAIT_MS);
      } catch (IOException ignored) {
        // 对方已断开，直接关闭套接字。
        terminate();
      }
    }
  }

  /** 不发关闭帧，直接关闭套接字；读循环随后结束并报告 1006。 */
  void terminate() {
    try {
      socket.close();
    } catch (IOException ignored) {
      /* 套接字已经关闭。 */
    }
  }

  private void send(int opcode, byte[] payload) throws IOException {
    synchronized (writing) {
      if (isCloseSent) {
        throw new IOException("closed");
      }
      frame(opcode, payload);
    }
  }

  private void frame(int opcode, byte[] payload) throws IOException {
    int length = payload.length;
    byte[] head;
    if (length <= 125) {
      head = new byte[] { (byte) (0x80 | opcode), (byte) length };
    } else if (length <= 0xffff) {
      head = new byte[] { (byte) (0x80 | opcode), 126, (byte) (length >> 8), (byte) length };
    } else {
      head = new byte[10];
      head[0] = (byte) (0x80 | opcode);
      head[1] = 127;
      for (int i = 0; i < 8; i++) {
        head[9 - i] = (byte) ((long) length >> (8 * i));
      }
    }
    output.write(head);
    output.write(payload);
    output.flush();
  }
}
