package io.github.galgame.savedatasync;

import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 严格且有界的 JSON 边界；不依赖 Android 宽松解析器，重复键、坏 UTF-8/代理项均拒绝。 */
final class TransferJson {
    static final int MAX_BYTES = 8388608;
    private final String text;
    private int offset;
    private TransferJson(String text) { this.text = text; }
    static Object parse(byte[] bytes) throws Exception {
        if (bytes.length > MAX_BYTES) throw fail("resource-limit");
        String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        TransferJson parser = new TransferJson(text); Object value = parser.value(0); parser.space();
        if (parser.offset != text.length()) throw fail("invalid-request");
        return value;
    }
    static byte[] bytes(Object value) throws Exception {
        StringBuilder out = new StringBuilder(); encode(value, out, 0);
        byte[] bytes = out.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) throw fail("resource-limit");
        return bytes;
    }
    static Object copy(Object value) throws Exception { return parse(bytes(value)); }
    static Map<String, Object> object(Object... pairs) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) result.put((String) pairs[i], pairs[i + 1]);
        return result;
    }
    @SuppressWarnings("unchecked")
    static Map<String, Object> map(Object value) throws ArchiveFailure {
        if (!(value instanceof Map)) throw fail("invalid-request");
        return (Map<String, Object>) value;
    }
    @SuppressWarnings("unchecked")
    static List<Object> list(Object value) throws ArchiveFailure {
        if (!(value instanceof List)) throw fail("invalid-request");
        return (List<Object>) value;
    }
    static ArchiveFailure fail(String code) { return new ArchiveFailure(code, "传输数据或协议状态无效，请重新核实本次操作"); }
    private void space() { while (offset < text.length() && " \r\n\t".indexOf(text.charAt(offset)) >= 0) offset++; }
    private Object value(int depth) throws Exception {
        if (depth > 32) throw fail("resource-limit");
        space(); if (offset == text.length()) throw fail("invalid-request");
        char c = text.charAt(offset);
        if (c == '"') return string();
        if (c == '{' || c == '[') {
            offset++; space();
            Map<String, Object> map = new LinkedHashMap<>(); List<Object> list = new ArrayList<>();
            char end = c == '{' ? '}' : ']';
            if (offset < text.length() && text.charAt(offset) == end) { offset++; return c == '{' ? map : list; }
            int count = 0;
            while (true) {
                if (++count > 65536) throw fail("resource-limit");
                if (c == '{') {
                    space(); String key = string(); space();
                    if (offset == text.length() || text.charAt(offset++) != ':' || map.containsKey(key)) throw fail("invalid-request");
                    map.put(key, value(depth + 1));
                } else list.add(value(depth + 1));
                space(); if (offset == text.length()) throw fail("invalid-request");
                char next = text.charAt(offset++);
                if (next == end) return c == '{' ? map : list;
                if (next != ',') throw fail("invalid-request");
            }
        }
        for (String literal : new String[] {"true", "false", "null"}) if (text.startsWith(literal, offset)) {
            offset += literal.length(); return literal.equals("null") ? null : literal.equals("true");
        }
        int start = offset;
        while (offset < text.length() && "-+0123456789.eE".indexOf(text.charAt(offset)) >= 0) offset++;
        String token = text.substring(start, offset);
        if (token.length() > 128 || !token.matches("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")) throw fail("invalid-request");
        try {
            long number = new BigDecimal(token).longValueExact();
            if (number < -9007199254740991L || number > 9007199254740991L) throw fail("invalid-request");
            return number;
        } catch (ArithmeticException | NumberFormatException cause) { throw fail("invalid-request"); }
    }
    private String string() throws Exception {
        if (offset == text.length() || text.charAt(offset++) != '"') throw fail("invalid-request");
        StringBuilder result = new StringBuilder(); boolean ended = false;
        while (offset < text.length()) {
            char c = text.charAt(offset++);
            if (c == '"') { ended = true; break; }
            if (c < 32) throw fail("invalid-request");
            if (c == '\\') {
                if (offset == text.length()) throw fail("invalid-request"); c = text.charAt(offset++);
                int escape = "\"\\/bfnrt".indexOf(c);
                if (escape >= 0) c = "\"\\/\b\f\n\r\t".charAt(escape);
                else if (c == 'u' && offset + 4 <= text.length()) {
                    String hex = text.substring(offset, offset + 4);
                    if (!hex.matches("[a-fA-F0-9]{4}")) throw fail("invalid-request");
                    c = (char) Integer.parseInt(hex, 16); offset += 4;
                } else throw fail("invalid-request");
            }
            result.append(c);
        }
        if (!ended) throw fail("invalid-request");
        validString(result.toString()); return result.toString();
    }
    private static void validString(String value) throws ArchiveFailure {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (++i == value.length() || !Character.isLowSurrogate(value.charAt(i))) throw fail("invalid-request");
            } else if (Character.isLowSurrogate(c)) throw fail("invalid-request");
        }
    }
    private static void encode(Object value, StringBuilder out, int depth) throws Exception {
        if (depth > 32 || out.length() > MAX_BYTES) throw fail("resource-limit");
        if (value == null || value instanceof Boolean) { out.append(value); return; }
        if (value instanceof Number) {
            long n = ((Number) value).longValue();
            if (((Number) value).doubleValue() != n || Math.abs((double) n) > 9007199254740991d) throw fail("invalid-request");
            out.append(n); return;
        }
        if (value instanceof String) {
            String string = (String) value; validString(string); out.append('"');
            for (int i = 0; i < string.length(); i++) {
                char c = string.charAt(i);
                if (c == '"' || c == '\\') out.append('\\').append(c);
                else if (c < 32) out.append(String.format(java.util.Locale.ROOT, "\\u%04x", (int) c));
                else out.append(c);
            }
            out.append('"'); return;
        }
        boolean map = value instanceof Map;
        out.append(map ? '{' : '['); boolean first = true;
        if (map) {
            for (Map.Entry<String, Object> entry : TransferJson.map(value).entrySet()) {
                if (!first) out.append(','); first = false;
                encode(entry.getKey(), out, depth + 1); out.append(':'); encode(entry.getValue(), out, depth + 1);
            }
        } else for (Object item : list(value)) {
            if (!first) out.append(','); first = false; encode(item, out, depth + 1);
        }
        out.append(map ? '}' : ']');
    }
}
