package io.github.galgame.savedatasync;

/** 提供者解码与原生单元测试共用的纯边界检查。 */
final class SafValues {
    private static final long MAX_SAFE_INTEGER = 9007199254740991L;
    private static final long MAX_DATE = 8640000000000000L;

    private SafValues() {}

    static boolean isId(Object value) {
        return value instanceof String && ((String) value).matches("[A-Za-z0-9][A-Za-z0-9_-]{0,127}");
    }

    static String text(String value) {
        if (value == null || value.length() > 1024 || value.codePoints().allMatch(
            point -> Character.isWhitespace(point) || Character.isSpaceChar(point)
        )) throw new IllegalArgumentException("Invalid provider text");
        return value;
    }

    static Long size(Long value) {
        if (value == null || value < 0) return null;
        if (value > MAX_SAFE_INTEGER) throw new IllegalArgumentException("Unsafe byte count");
        return value;
    }

    static Long modified(Long value) {
        // DocumentsContract 将零定义为未知修改时间。
        if (value == null || value == 0) return null;
        if (value < -MAX_DATE || value > MAX_DATE) throw new IllegalArgumentException("Unsafe date");
        return value;
    }
}
