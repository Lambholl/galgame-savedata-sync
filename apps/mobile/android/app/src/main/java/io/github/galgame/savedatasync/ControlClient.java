package io.github.galgame.savedatasync;

import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.handshake.ServerHandshake;
import org.java_websocket.protocols.Protocol;

/** 控制通道的客户端：用目录表交换后的会话连接监听方，收发文本 JSON；收到的消息只核对是严格的 JSON 对象。 */
final class ControlClient extends WebSocketClient {

  interface Events {
    void opened(ControlClient client);

    void message(ControlClient client, String text);

    void closed(ControlClient client, int code);
  }

  static final int MAX_BYTES = 8388608;
  private final Events events;

  ControlClient(String origin, String session, String deviceId, Events events) throws Exception {
    super(
      uri(origin),
      new Draft_6455(
        Collections.emptyList(),
        Collections.singletonList(new Protocol("")),
        MAX_BYTES
      ),
      headers(session, deviceId),
      5000
    );
    this.events = events;
    // 每 15 秒心跳，超时没有回应即关闭。
    setConnectionLostTimeout(15);
    setTcpNoDelay(true);
  }

  private static URI uri(String origin) throws Exception {
    URI http = new URI(origin);
    return new URI("ws", null, http.getHost(), http.getPort(), "/v1/control", null, null);
  }

  private static Map<String, String> headers(String session, String deviceId) throws Exception {
    Map<String, String> result = new HashMap<>();
    result.put("x-sync-session-id", TransferSchema.id(session));
    result.put("x-sync-device-id", TransferSchema.id(deviceId));
    return result;
  }

  /** 核对要发出的消息的外层格式，不符时抛错。 */
  static void check(String text) throws Exception {
    if (text == null || text.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) {
      throw TransferJson.fail("resource-limit");
    }
    Map<String, Object> value = TransferJson.map(
      TransferJson.parse(text.getBytes(StandardCharsets.UTF_8))
    );
    TransferSchema.require(TransferSchema.number(value.get("v"), 1, 1) == 1);
    TransferSchema.one(value.get("type"), "request", "response", "event");
  }

  @Override
  public void onOpen(ServerHandshake handshake) {
    events.opened(this);
  }

  @Override
  public void onMessage(String text) {
    try {
      TransferJson.map(TransferJson.parse(text.getBytes(StandardCharsets.UTF_8)));
    } catch (Exception invalid) {
      close(1007, "invalid-json");
      return;
    }
    events.message(this, text);
  }

  @Override
  public void onMessage(ByteBuffer bytes) {
    close(1003, "text-only");
  }

  @Override
  public void onClose(int code, String reason, boolean isRemote) {
    events.closed(this, code);
  }

  @Override
  public void onError(Exception cause) {
    /* onClose 随后报告断开。 */
  }
}
