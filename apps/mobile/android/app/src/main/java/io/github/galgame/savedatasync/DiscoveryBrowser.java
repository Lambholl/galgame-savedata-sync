package io.github.galgame.savedatasync;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.annotation.RequiresApi;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 用 NsdManager 在局域网搜索监听方广播的 DNS-SD 服务，解析出实例名、端口、IPv4 地址和 TXT 字段。
 *
 * <p>页面要求搜索并且 Activity 处于前台时才实际搜索；Activity 停止后暂停，回到前台时重新搜索并清空上一轮结果。
 * API 34 及以上对每个服务注册 ServiceInfoCallback，地址变化时持续更新；更低版本只能逐个调用 resolveService，
 * 同一时间只解析一个服务，解析后的结果不再更新。
 *
 * <p>全部状态只在内部单线程 worker 上读写；NsdManager 回调先转到 worker 再处理。结果变化时在 worker 线程调用
 * {@link Listener}。
 */
final class DiscoveryBrowser {

  /** 搜索结果变化的通知，在 worker 线程调用，参数是 {@link #snapshot()} 的结果。 */
  interface Listener {
    void onChanged(JSONObject snapshot);
  }

  /** 与 shared 的 DISCOVERY_SERVICE.type 一致。 */
  private static final String SERVICE_TYPE = "_savedata-sync._tcp";

  /** API 34 以下 resolveService 偶尔不回调，超过这个时间就跳过该服务、解析下一个。 */
  private static final long RESOLVE_TIMEOUT_MS = 10_000;

  /** 系统里同一应用已有解析在进行（FAILURE_ALREADY_ACTIVE）时，隔这么久再试。 */
  private static final long RESOLVE_RETRY_DELAY_MS = 1_000;

  private static final int MAX_RESOLVE_ATTEMPTS = 3;

  private final NsdManager nsd;
  private final Listener listener;
  private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();

  /**
   * 交给 NsdManager 的回调执行器。worker 结束后 NsdManager 仍可能送来已在途的回调，直接交给 worker 会在系统线程抛出
   * RejectedExecutionException 使应用崩溃，经过 post 时这些回调被丢弃。
   */
  private final Executor callbacks = this::post;

  /** 页面是否要求搜索；只在 worker 线程读写。 */
  private boolean isRequested;

  /** Activity 是否处于前台；只在 worker 线程读写。 */
  private boolean isForeground = true;

  /** 正在进行的一轮搜索；没有搜索时为 null。只在 worker 线程读写。 */
  private Session session;

  DiscoveryBrowser(Context context, Listener listener) {
    this.nsd = (NsdManager) context.getSystemService(Context.NSD_SERVICE);
    this.listener = listener;
  }

  /** 页面要求开始搜索；已在搜索时保持当前结果，上一轮失败时重新搜索。完成后在 worker 线程回调当前结果。 */
  void start(Listener done) {
    post(() -> {
      isRequested = true;
      apply();
      done.onChanged(snapshot());
    });
  }

  /** 页面不再需要搜索：停止搜索并清空结果。完成后在 worker 线程回调当前结果。 */
  void stop(Listener done) {
    post(() -> {
      isRequested = false;
      apply();
      done.onChanged(snapshot());
    });
  }

  /** 由 Activity 的 onStart 和 onStop 调用；回到前台时如果页面仍要求搜索，就重新开始一轮。 */
  void setForeground(boolean isForeground) {
    post(() -> {
      this.isForeground = isForeground;
      apply();
    });
  }

  /** 停止搜索并结束 worker 线程，之后的调用都被忽略。由插件在 Activity 销毁时调用。 */
  void close() {
    post(() -> {
      isRequested = false;
      apply();
      worker.shutdown();
    });
  }

  private void post(Runnable task) {
    try {
      worker.execute(task);
    } catch (RejectedExecutionException closed) {
      /* close 之后 worker 已结束，搜索也已停止，不再处理新的请求。 */
    }
  }

  /** 按页面要求和前台状态开始或停止搜索，状态有变化时通知监听器。 */
  private void apply() {
    boolean shouldSearch = isRequested && isForeground;
    if (shouldSearch && session == null) {
      session = new Session();
      try {
        nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, session.discovery);
      } catch (IllegalArgumentException | IllegalStateException failure) {
        session = null;
      }
      listener.onChanged(snapshot());
    } else if (!shouldSearch && session != null) {
      session.close();
      session = null;
      listener.onChanged(snapshot());
    }
  }

  /**
   * 当前搜索状态和已解析的服务。
   *
   * <p>status 取值：searching 正在搜索；stopped 页面没有要求搜索；paused Activity 在后台；failed 系统拒绝开始搜索，
   * 页面再次调用 start 或 Activity 回到前台时重试。services 只包含已解析出端口和至少一个 IPv4 地址的服务，每项为
   * name（实例名）、port、addresses（IPv4 字符串）和 txt（键到 UTF-8 文本值，没有值或值不是合法 UTF-8 的键被省略）。
   */
  JSONObject snapshot() {
    String status =
      session != null
        ? "searching"
        : !isRequested
          ? "stopped"
          : !isForeground
            ? "paused"
            : "failed";
    JSONArray services = new JSONArray();
    if (session != null) {
      for (Service service : session.services.values()) {
        if (service.port > 0 && !service.addresses.isEmpty()) {
          services.put(service.toJson());
        }
      }
    }
    try {
      return new JSONObject().put("status", status).put("services", services);
    } catch (JSONException impossible) {
      throw new IllegalStateException(impossible);
    }
  }

  /** 一轮搜索：持有 NsdManager 的发现监听器、找到的服务和 API 34 以下的解析队列。只在 worker 线程读写。 */
  private final class Session {

    private final Map<String, Service> services = new LinkedHashMap<>();
    private final Deque<Service> pendingResolves = new ArrayDeque<>();
    private Service resolving;
    private boolean isClosed;

    /** NsdManager 在自己的线程回调，这里只把事件转到 worker；本轮结束后到达的事件被丢弃。 */
    private final NsdManager.DiscoveryListener discovery = new NsdManager.DiscoveryListener() {
      @Override
      public void onStartDiscoveryFailed(String serviceType, int errorCode) {
        post(() -> {
          if (session == Session.this) {
            close();
            session = null;
            listener.onChanged(snapshot());
          }
        });
      }

      @Override
      public void onStopDiscoveryFailed(String serviceType, int errorCode) {
        /* 本轮已经从 worker 状态里移除，系统没能停止只影响它自己的资源。 */
      }

      @Override
      public void onDiscoveryStarted(String serviceType) {
        /* 开始搜索时状态已是 searching。 */
      }

      @Override
      public void onDiscoveryStopped(String serviceType) {
        /* 停止由 worker 发起，状态已更新。 */
      }

      @Override
      public void onServiceFound(NsdServiceInfo info) {
        post(() -> found(info));
      }

      @Override
      public void onServiceLost(NsdServiceInfo info) {
        post(() -> lost(info.getServiceName()));
      }
    };

    /** 同一实例名只解析一次；系统在多块网卡上各报告一次时，后到的被忽略。 */
    private void found(NsdServiceInfo info) {
      String name = info.getServiceName();
      if (isClosed || name == null || services.containsKey(name)) {
        return;
      }
      Service service = new Service(info);
      services.put(name, service);
      if (Build.VERSION.SDK_INT >= 34) {
        watch(service);
      } else {
        pendingResolves.addLast(service);
        resolveNext();
      }
    }

    private void lost(String name) {
      Service service = services.remove(name);
      if (isClosed || service == null) {
        return;
      }
      pendingResolves.remove(service);
      service.unwatch();
      if (service.port > 0) {
        listener.onChanged(snapshot());
      }
    }

    @RequiresApi(34)
    private void watch(Service service) {
      service.callback = new NsdManager.ServiceInfoCallback() {
        @Override
        public void onServiceInfoCallbackRegistrationFailed(int errorCode) {
          /* 这个服务保持未解析，不出现在结果里。 */
        }

        @Override
        public void onServiceUpdated(@NonNull NsdServiceInfo info) {
          if (isClosed || services.get(service.name) != service) {
            return;
          }
          service.update(info.getPort(), info.getHostAddresses(), info.getAttributes());
          listener.onChanged(snapshot());
        }

        @Override
        public void onServiceLost() {
          lost(service.name);
        }

        @Override
        public void onServiceInfoCallbackUnregistered() {
          /* 取消注册由 worker 发起，结果已经移除。 */
        }
      };
      try {
        nsd.registerServiceInfoCallback(service.found, callbacks, service.callback);
      } catch (IllegalArgumentException failure) {
        service.callback = null;
      }
    }

    /** API 34 以下系统只允许同时进行一个解析，这里按找到的顺序逐个解析。 */
    @SuppressWarnings("deprecation")
    private void resolveNext() {
      if (isClosed || resolving != null || pendingResolves.isEmpty()) {
        return;
      }
      Service service = pendingResolves.removeFirst();
      resolving = service;
      service.attempts++;
      try {
        nsd.resolveService(
          service.found,
          new NsdManager.ResolveListener() {
            @Override
            public void onResolveFailed(NsdServiceInfo info, int errorCode) {
              post(() -> resolveFailed(service, errorCode));
            }

            @Override
            public void onServiceResolved(NsdServiceInfo info) {
              post(() -> resolved(service, info));
            }
          }
        );
      } catch (IllegalArgumentException failure) {
        resolveFinished(service);
        return;
      }
      worker.schedule(
        () -> {
          if (resolving == service) {
            resolveFinished(service);
          }
        },
        RESOLVE_TIMEOUT_MS,
        TimeUnit.MILLISECONDS
      );
    }

    @SuppressWarnings("deprecation")
    private void resolved(Service service, NsdServiceInfo info) {
      if (!isClosed && services.get(service.name) == service) {
        InetAddress host = info.getHost();
        service.update(
          info.getPort(),
          host == null ? Collections.emptyList() : Collections.singletonList(host),
          info.getAttributes()
        );
        listener.onChanged(snapshot());
      }
      resolveFinished(service);
    }

    private void resolveFailed(Service service, int errorCode) {
      if (
        errorCode == NsdManager.FAILURE_ALREADY_ACTIVE &&
        service.attempts < MAX_RESOLVE_ATTEMPTS &&
        services.get(service.name) == service
      ) {
        worker.schedule(
          () -> {
            if (!isClosed && services.get(service.name) == service) {
              pendingResolves.addLast(service);
              resolveNext();
            }
          },
          RESOLVE_RETRY_DELAY_MS,
          TimeUnit.MILLISECONDS
        );
      }
      resolveFinished(service);
    }

    /** 超时后才到的回调对应的服务已不是 resolving，只更新它自己的结果，不影响队列。 */
    private void resolveFinished(Service service) {
      if (resolving == service) {
        resolving = null;
        resolveNext();
      }
    }

    /** 停止搜索并注销全部 ServiceInfoCallback；API 34 以下正在进行的解析无法取消，回调到达后被丢弃。 */
    private void close() {
      isClosed = true;
      for (Service service : services.values()) {
        service.unwatch();
      }
      services.clear();
      pendingResolves.clear();
      resolving = null;
      try {
        nsd.stopServiceDiscovery(discovery);
      } catch (IllegalArgumentException notStarted) {
        /* 系统没有接受这次搜索（开始失败），没有需要停止的搜索。 */
      }
    }
  }

  /** 找到的一个服务及其解析结果。只在 worker 线程读写。 */
  private final class Service {

    private final NsdServiceInfo found;
    private final String name;
    private int attempts;
    private int port;
    private List<String> addresses = Collections.emptyList();
    private Map<String, String> txt = Collections.emptyMap();
    private NsdManager.ServiceInfoCallback callback;

    Service(NsdServiceInfo found) {
      this.found = found;
      this.name = found.getServiceName();
    }

    /** 只保留 IPv4 地址，监听方只发 A 记录，拨号方也只用 IPv4。 */
    void update(int port, List<InetAddress> hosts, Map<String, byte[]> attributes) {
      List<String> ipv4 = new ArrayList<>();
      for (InetAddress host : hosts) {
        if (host instanceof Inet4Address && !ipv4.contains(host.getHostAddress())) {
          ipv4.add(host.getHostAddress());
        }
      }
      Map<String, String> values = new LinkedHashMap<>();
      for (Map.Entry<String, byte[]> attribute : attributes.entrySet()) {
        String value = decodeUtf8(attribute.getValue());
        if (value != null) {
          values.put(attribute.getKey(), value);
        }
      }
      this.port = port;
      this.addresses = ipv4;
      this.txt = values;
    }

    void unwatch() {
      if (callback != null && Build.VERSION.SDK_INT >= 34) {
        try {
          nsd.unregisterServiceInfoCallback(callback);
        } catch (IllegalArgumentException notRegistered) {
          /* 注册失败的回调没有需要注销的内容。 */
        }
      }
      callback = null;
    }

    JSONObject toJson() {
      try {
        return new JSONObject()
          .put("name", name)
          .put("port", port)
          .put("addresses", new JSONArray(addresses))
          .put("txt", new JSONObject(txt));
      } catch (JSONException impossible) {
        throw new IllegalStateException(impossible);
      }
    }
  }

  /** TXT 值按 UTF-8 严格解码；没有值（只有键）或不是合法 UTF-8 时返回 null。 */
  private static String decodeUtf8(byte[] value) {
    if (value == null) {
      return null;
    }
    try {
      return StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(value))
        .toString();
    } catch (CharacterCodingException invalid) {
      return null;
    }
  }
}
