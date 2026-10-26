package io.github.galgame.savedatasync;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PushbackInputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Locale;
import java.util.zip.CRC32;
import java.util.zip.DataFormatException;
import java.util.zip.GZIPOutputStream;
import java.util.zip.Inflater;

/** 受限 USTAR 与单 member gzip；所有显式缓冲至多 64 KiB，不展开归档路径。 */
final class ArchiveFormat {
    private ArchiveFormat() {}

    static byte[] header(String id, long size) {
        byte[] h = new byte[512];
        ascii(h, 0, id);
        octal(h, 100, 8, 0600); octal(h, 108, 8, 0); octal(h, 116, 8, 0);
        octal(h, 124, 12, size); octal(h, 136, 12, 0);
        Arrays.fill(h, 148, 156, (byte) 32);
        h[156] = '0'; ascii(h, 257, "ustar\0"); ascii(h, 263, "00");
        octal(h, 329, 8, 0); octal(h, 337, 8, 0);
        long sum = 0;
        for (byte b : h) sum += b & 255;
        ascii(h, 148, String.format(Locale.ROOT, "%06o\0 ", sum));
        return h;
    }
    private static void ascii(byte[] target, int offset, String value) {
        byte[] bytes = value.getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(bytes, 0, target, offset, bytes.length);
    }
    private static void octal(byte[] target, int offset, int width, long value) {
        ascii(target, offset, String.format(Locale.ROOT, "%0" + (width - 1) + "o\0", value));
    }
    static MessageDigest sha256() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException cause) { throw new AssertionError(cause); }
    }
    static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) result.append(String.format(Locale.ROOT, "%02x", b & 255));
        return result.toString();
    }
    static void exact(InputStream in, byte[] buffer, int length, ArchiveControl control) throws IOException {
        int offset = 0;
        while (offset < length) {
            control.check();
            int n = in.read(buffer, offset, length - offset);
            if (n <= 0) throw invalid("归档内容截断或读取无进展");
            offset += n;
        }
    }
    static void zeros(byte[] bytes, int length) throws ArchiveFailure {
        for (int i = 0; i < length; i++) if (bytes[i] != 0) throw invalid("tar 填充或结束块非法");
    }
    static ArchiveFailure invalid(String message) { return new ArchiveFailure("invalid-archive", message); }

    /** 使用 JDK/Android 内置压缩器，明确设置 level 1；close 负责结束并释放原生压缩器。 */
    static final class GzipWriter extends GZIPOutputStream {
        GzipWriter(OutputStream out) throws IOException {
            super(out, ArchiveModel.BUFFER);
            def.setLevel(1);
        }
    }

    /**
     * 不使用默许拼接的 GZIPInputStream。持有原始 inflater，结束时回收未消费输入，
     * 精确校验 CRC/ISIZE 和物理 EOF；调用者必须读到 EOF 后才可接受，且必须 close。
     */
    static final class GzipReader extends InputStream {
        private final PushbackInputStream input;
        private final Inflater inflater = new Inflater(true);
        private final CRC32 crc = new CRC32();
        private final byte[] compressed = new byte[ArchiveModel.BUFFER];
        private final ArchiveControl control;
        private final long maximum;
        private long count;
        private int lastInput;
        private boolean ended, closed;

        GzipReader(InputStream source, long maximum, ArchiveControl control) throws IOException {
            input = new PushbackInputStream(source, ArchiveModel.BUFFER);
            this.maximum = maximum; this.control = control;
            byte[] h = new byte[10];
            try {
                exact(input, h, h.length, control);
                if ((h[0] & 255) != 31 || (h[1] & 255) != 139 || h[2] != 8 ||
                    h[3] != 0 || h[4] != 0 || h[5] != 0 || h[6] != 0 || h[7] != 0) {
                    throw invalid("gzip 头不符合单 member 协议");
                }
            } catch (IOException | RuntimeException failure) { inflater.end(); throw failure; }
        }
        @Override public int read() throws IOException {
            byte[] one = new byte[1];
            return read(one, 0, 1) < 0 ? -1 : one[0] & 255;
        }
        @Override public int read(byte[] buffer, int offset, int length) throws IOException {
            if (closed) throw new IOException("Closed archive stream");
            if (offset < 0 || length < 0 || offset > buffer.length - length) throw new IndexOutOfBoundsException();
            if (length == 0) return 0;
            control.check();
            if (ended) return -1;
            try {
                for (;;) {
                    control.check();
                    if (inflater.finished()) { finishMember(); return -1; }
                    if (inflater.needsInput()) {
                        lastInput = input.read(compressed);
                        if (lastInput <= 0) throw invalid("DEFLATE 内容被截断");
                        inflater.setInput(compressed, 0, lastInput);
                    }
                    int n = inflater.inflate(buffer, offset, Math.min(length, ArchiveModel.BUFFER));
                    if (n > 0) {
                        ArchiveModel.limit(count <= maximum - n);
                        count += n; crc.update(buffer, offset, n);
                        return n;
                    }
                    if (inflater.needsDictionary() || (!inflater.needsInput() && !inflater.finished())) {
                        throw invalid("DEFLATE 无法继续解码");
                    }
                }
            } catch (DataFormatException cause) {
                throw new ArchiveFailure("invalid-archive", "DEFLATE 数据非法", false, cause);
            }
        }
        private void finishMember() throws IOException {
            int remaining = inflater.getRemaining();
            if (remaining > 0) input.unread(compressed, lastInput - remaining, remaining);
            byte[] footer = new byte[8];
            exact(input, footer, 8, control);
            if (little(footer, 0) != crc.getValue() || little(footer, 4) != (count & 0xffffffffL)) {
                throw invalid("gzip CRC32 或 ISIZE 校验失败");
            }
            control.check();
            if (input.read() != -1) throw invalid("gzip 结束后有拼接 member 或尾随内容");
            ended = true;
        }
        private long little(byte[] bytes, int offset) {
            long value = 0;
            for (int i = 0; i < 4; i++) value |= (long) (bytes[offset + i] & 255) << (8 * i);
            return value;
        }
        @Override public void close() throws IOException {
            if (closed) return;
            closed = true;
            try { inflater.end(); } finally { input.close(); }
        }
    }
}
