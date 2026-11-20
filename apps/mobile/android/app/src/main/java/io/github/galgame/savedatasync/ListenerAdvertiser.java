package io.github.galgame.savedatasync;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Handler;
import android.os.Looper;
import java.nio.charset.StandardCharsets;

/**
 * 用 NsdManager 在局域网广播本机服务（`_savedata-sync._tcp`），TXT 与电脑相同：v（协议版本）、id（设备 ID）、pf（android）。
 * 注册失败时状态为 failed，之后自动重试。状态只在主线程上改变，变化时在主线程调用 Listener；{@link #status} 可在任意线程读取。
 */
final class ListenerAdvertiser {

  /** 广播状态变化；在主线程调用。 */
  interface Listener {
    void changed();
  }

  static final String SERVICE_TYPE = "_savedata-sync._tcp";
  private static final long RETRY_MS = 30000;
  private static final int MAX_INSTANCE_NAME_BYTES = 63;
  private final NsdManager nsd;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final Listener listener;
  private final Runnable retryTask = this::retry;
  private volatile String status = "off";
  private NsdServiceInfo info;
  private NsdManager.RegistrationListener registration;

  ListenerAdvertiser(Context context, Listener listener) {
    this.nsd = (NsdManager) context.getSystemService(Context.NSD_SERVICE);
    this.listener = listener;
  }

  /** 当前状态：off、starting、advertising 或 failed。 */
  String status() {
    return status;
  }

  /** 开始广播；已在广播时先注销旧的注册。 */
  void start(String displayName, String deviceId, int port) {
    NsdServiceInfo next = new NsdServiceInfo();
    next.setServiceName(instanceName(displayName));
    next.setServiceType(SERVICE_TYPE);
    next.setPort(port);
    next.setAttribute("v", "3");
    next.setAttribute("id", deviceId);
    next.setAttribute("pf", "android");
    main.post(() -> {
      unregister();
      info = next;
      register();
    });
  }

  /** 停止广播并注销服务。 */
  void stop() {
    main.post(() -> {
      info = null;
      unregister();
      setStatus("off");
    });
  }

  private void register() {
    if (info == null) {
      return;
    }
    NsdServiceInfo current = info;
    NsdManager.RegistrationListener created = new NsdManager.RegistrationListener() {
      @Override
      public void onServiceRegistered(NsdServiceInfo service) {
        main.post(() -> {
          if (registration == this) {
            setStatus("advertising");
          }
        });
      }

      @Override
      public void onRegistrationFailed(NsdServiceInfo service, int errorCode) {
        main.post(() -> {
          if (registration == this) {
            registration = null;
            setStatus("failed");
            main.postDelayed(retryTask, RETRY_MS);
          }
        });
      }

      @Override
      public void onServiceUnregistered(NsdServiceInfo service) {
        // 注销由 unregister 发起，状态已经在那里改好。
      }

      @Override
      public void onUnregistrationFailed(NsdServiceInfo service, int errorCode) {
        // 系统在服务进程退出时也会清掉注册；这里没有可以重试的事。
      }
    };
    registration = created;
    setStatus("starting");
    try {
      nsd.registerService(current, NsdManager.PROTOCOL_DNS_SD, created);
    } catch (RuntimeException rejected) {
      registration = null;
      setStatus("failed");
      main.postDelayed(retryTask, RETRY_MS);
    }
  }

  private void retry() {
    if (info != null && registration == null) {
      register();
    }
  }

  private void unregister() {
    main.removeCallbacks(retryTask);
    NsdManager.RegistrationListener current = registration;
    registration = null;
    if (current != null) {
      try {
        nsd.unregisterService(current);
      } catch (RuntimeException notRegistered) {
        // 注册还没完成或已经失败时系统不认这个监听器，没有需要注销的服务。
      }
    }
  }

  private void setStatus(String value) {
    if (!value.equals(status)) {
      status = value;
      listener.changed();
    }
  }

  /**
   * 把设备名转成 DNS-SD 实例名：去掉首尾空白，按 Unicode 码位截到 {@link #MAX_INSTANCE_NAME_BYTES} 个
   * UTF-8 字节以内，规则同共享 createDiscoveryInstanceName。
   */
  static String instanceName(String displayName) {
    StringBuilder name = new StringBuilder();
    int bytes = 0;
    String trimmed = displayName.trim();
    for (int i = 0; i < trimmed.length(); ) {
      int codePoint = trimmed.codePointAt(i);
      String character = new String(Character.toChars(codePoint));
      bytes += character.getBytes(StandardCharsets.UTF_8).length;
      if (bytes > MAX_INSTANCE_NAME_BYTES) {
        break;
      }
      name.append(character);
      i += Character.charCount(codePoint);
    }
    return name.toString();
  }
}
