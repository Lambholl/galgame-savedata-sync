package io.github.galgame.savedatasync;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.IOException;
import java.util.UUID;

/** 本机的设备 ID，保存在应用私有 SharedPreferences {@link #FILE} 的 {@link #KEY}，和目录登记分开存放。线程安全。 */
final class DeviceIdentity {

  static final String FILE = "device-identity";
  static final String KEY = "deviceId";
  private static final Object LOCK = new Object();

  private DeviceIdentity() {}

  static SharedPreferences store(Context context) {
    return context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
  }

  /** 判断已保存的值是不是有效的设备 ID。 */
  static boolean isValid(Object value) {
    return DocumentValues.isId(value);
  }

  /**
   * 读取设备 ID；还没有保存过时生成新的并保存。
   *
   * @throws IOException 新 ID 保存失败时抛出。
   * @throws IllegalStateException 已保存的值不是有效的设备 ID 时抛出，原值保留。
   */
  static String load(Context context) throws IOException {
    synchronized (LOCK) {
      SharedPreferences store = store(context);
      Object saved = store.getAll().get(KEY);
      if (saved == null) {
        String deviceId = UUID.randomUUID().toString();
        if (!store.edit().putString(KEY, deviceId).commit()) {
          throw new IOException("The device ID cannot be saved.");
        }
        return deviceId;
      }
      if (!isValid(saved)) {
        throw new IllegalStateException("The saved device ID is invalid.");
      }
      return (String) saved;
    }
  }
}
