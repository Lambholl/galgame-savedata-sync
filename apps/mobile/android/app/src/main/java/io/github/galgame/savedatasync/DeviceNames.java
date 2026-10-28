package io.github.galgame.savedatasync;

import android.content.Context;
import android.os.Build;
import android.provider.Settings;

/** 只读取系统名称用于首次保存设备；系统不提供名称时使用型号，不申请额外权限。 */
final class DeviceNames {
    private DeviceNames() {}

    static String current(Context context) {
        String name = null;
        try { name = Settings.Global.getString(context.getContentResolver(), Settings.Global.DEVICE_NAME); }
        catch (RuntimeException ignored) { /* 系统限制或提供者失败时使用型号。 */ }
        return choose(name, Build.MODEL);
    }

    /** catalog 名称最多 128 个 UTF-16 码元，截断时保留完整代理对。 */
    static String choose(String name, String model) {
        String value = normalized(name);
        if (value == null) value = normalized(model);
        return value == null ? "Android" : value;
    }

    private static String normalized(String value) {
        if (value == null) return null;
        String text = value.trim();
        if (text.codePoints().allMatch(point -> Character.isWhitespace(point) || Character.isSpaceChar(point))) return null;
        int end = Math.min(text.length(), 128);
        if (Character.isHighSurrogate(text.charAt(end - 1))) end--;
        return end == 0 ? null : text.substring(0, end);
    }
}
