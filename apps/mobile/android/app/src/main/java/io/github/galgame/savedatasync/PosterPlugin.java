package io.github.galgame.savedatasync;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.PickVisualMediaRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 封面的原生插件：执行封面接口请求和图片下载，经系统照片选择器选图，读写应用私有目录里的封面文件。
 *
 * <p>网络请求在后台线程池执行；封面文件的读写和选中图片的读取在单个后台线程串行执行。插件销毁时停止两个线程池。
 */
@CapacitorPlugin(name = "Poster")
public class PosterPlugin extends Plugin {

  private static final String TAG = "PosterPlugin";
  /** 同时执行的网络请求数；候选网格会同时下载多张图片。 */
  private static final int NETWORK_THREADS = 4;
  private static final Set<String> PICKED_IMAGE_TYPES = Set.of(
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif"
  );

  private final ExecutorService network = Executors.newFixedThreadPool(NETWORK_THREADS);
  private final ExecutorService files = Executors.newSingleThreadExecutor();
  private final AtomicBoolean picking = new AtomicBoolean();
  private PosterHttp http;
  private PosterStore store;

  private interface Work {
    Object run() throws Exception;
  }

  @Override
  public void load() {
    Context context = getContext();
    http = new PosterHttp(PosterRules.userAgent(appVersion(context)));
    store = new PosterStore(new File(context.getFilesDir(), "posters"));
    // 排在文件线程的第一个，之后的保存不会和删除交错。
    files.execute(() -> prune(context));
  }

  private static String appVersion(Context context) {
    try {
      PackageManager manager = context.getPackageManager();
      String packageName = context.getPackageName();
      return Build.VERSION.SDK_INT >= 33
        ? manager.getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(0)).versionName
        : legacyPackageInfo(manager, packageName).versionName;
    } catch (PackageManager.NameNotFoundException cause) {
      // 应用自己的包一定存在。
      throw new IllegalStateException(cause);
    }
  }

  @SuppressWarnings("deprecation")
  private static PackageInfo legacyPackageInfo(PackageManager manager, String packageName)
    throws PackageManager.NameNotFoundException {
    return manager.getPackageInfo(packageName, 0);
  }

  /** 删掉游戏库没有引用的封面文件；游戏库读不懂时什么都不删。 */
  private void prune(Context context) {
    Set<String> kept = new HashSet<>();
    String library = AppStoragePlugin.readLibrary(context);
    try {
      if (library != null) {
        JSONArray games = new JSONObject(library).getJSONArray("games");
        for (int i = 0; i < games.length(); i++) {
          JSONObject game = games.getJSONObject(i);
          String posterHash = game.optString("posterHash", null);
          if (posterHash != null) {
            kept.addAll(PosterStore.fileNames(game.getString("id"), posterHash));
          }
        }
      }
      store.prune(kept);
    } catch (JSONException | IOException cause) {
      // 留下的文件不影响使用，下次启动再删。
      Log.w(TAG, "Unused poster files were not deleted.", cause);
    }
  }

  private void submit(ExecutorService executor, PluginCall call, Work work) {
    try {
      executor.execute(() -> {
        try {
          call.resolve(success(work.run()));
        } catch (PosterFailure failure) {
          call.resolve(failure(failure));
        } catch (Exception cause) {
          call.resolve(
            failure(new PosterFailure("internal-error", "The poster operation failed.", cause))
          );
        }
      });
    } catch (RejectedExecutionException cause) {
      call.resolve(
        failure(new PosterFailure("internal-error", "The app is closed. Open it again.", cause))
      );
    }
  }

  private static JSObject success(Object value) {
    JSObject result = new JSObject();
    result.put("status", "success");
    result.put("value", value);
    return result;
  }

  private static JSObject failure(PosterFailure failure) {
    JSObject error = new JSObject();
    error.put("code", failure.code);
    error.put("message", failure.getMessage());
    error.put("canRetry", false);
    JSObject result = new JSObject();
    result.put("status", "error");
    result.put("error", error);
    return result;
  }

  private static PosterFailure invalid() {
    return new PosterFailure("invalid-request", "The poster parameters are invalid.");
  }

  private static JSObject image(String mimeType, byte[] data) {
    JSObject value = new JSObject();
    value.put("mimeType", mimeType);
    value.put("data", Base64.getEncoder().encodeToString(data));
    return value;
  }

  private static String stringOrNull(JSONObject object, String key) throws PosterFailure {
    Object value = object.opt(key);
    if (value == JSONObject.NULL) {
      return null;
    }
    if (!(value instanceof String)) {
      throw invalid();
    }
    return (String) value;
  }

  private static String requiredString(JSONObject object, String key) throws PosterFailure {
    Object value = object.opt(key);
    if (!(value instanceof String)) {
      throw invalid();
    }
    return (String) value;
  }

  private static Map<String, String> headers(JSONObject request) throws PosterFailure {
    JSONObject source = request.optJSONObject("headers");
    if (source == null) {
      throw invalid();
    }
    Map<String, String> headers = new HashMap<>();
    Iterator<String> names = source.keys();
    while (names.hasNext()) {
      String name = names.next();
      headers.put(name, requiredString(source, name));
    }
    return headers;
  }

  @PluginMethod
  public void request(PluginCall call) {
    submit(network, call, () -> {
      JSONObject request = call.getData().optJSONObject("request");
      if (request == null) {
        throw invalid();
      }
      PosterHttp.TextResponse response = http.request(
        requiredString(request, "method"),
        requiredString(request, "url"),
        headers(request),
        stringOrNull(request, "body")
      );
      JSObject value = new JSObject();
      value.put("status", response.status);
      value.put("contentType", response.contentType == null ? JSObject.NULL : response.contentType);
      value.put("body", response.body);
      return value;
    });
  }

  @PluginMethod
  public void downloadImage(PluginCall call) {
    submit(network, call, () -> {
      PosterHttp.ImageResponse response = http.downloadImage(requiredString(call.getData(), "url"));
      return image(response.mimeType, response.data);
    });
  }

  @PluginMethod
  public void pickImage(PluginCall call) {
    if (!picking.compareAndSet(false, true)) {
      call.resolve(
        failure(
          new PosterFailure("unsupported-operation", "Complete the current image selection first.")
        )
      );
      return;
    }
    getActivity().runOnUiThread(() -> {
      try {
        Intent intent = new ActivityResultContracts.PickVisualMedia().createIntent(
          getContext(),
          new PickVisualMediaRequest.Builder()
            .setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly.INSTANCE)
            .build()
        );
        startActivityForResult(call, intent, "onImagePicked");
      } catch (RuntimeException cause) {
        picking.set(false);
        call.resolve(
          failure(new PosterFailure("internal-error", "The photo picker cannot be opened.", cause))
        );
      }
    });
  }

  /** 读取照片选择器返回的图片；取消时 value 为 null。JS 调用已丢失时忽略结果。 */
  @ActivityCallback
  private void onImagePicked(PluginCall call, ActivityResult activityResult) {
    picking.set(false);
    if (call == null) {
      return;
    }
    Uri uri = new ActivityResultContracts.PickVisualMedia().parseResult(
      activityResult.getResultCode(),
      activityResult.getData()
    );
    if (activityResult.getResultCode() == Activity.RESULT_CANCELED || uri == null) {
      call.resolve(success(JSObject.NULL));
      return;
    }
    submit(files, call, () -> readPickedImage(uri));
  }

  /**
   * 读出用户选中的图片。
   *
   * @throws PosterFailure 类型不是 JPEG、PNG、WebP 或 GIF，或内容为空时 code 为 invalid-request；超过
   *     {@link PosterRules#MAX_IMAGE_BYTES} 时为 resource-limit；图片已不存在时为 not-found；读取失败时为
   *     io-failure。
   */
  private JSObject readPickedImage(Uri uri) throws PosterFailure {
    String mimeType = getContext().getContentResolver().getType(uri);
    if (mimeType == null || !PICKED_IMAGE_TYPES.contains(mimeType)) {
      throw new PosterFailure("invalid-request", "The selected file is not a supported image.");
    }
    try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
      if (input == null) {
        throw new FileNotFoundException("The content provider returned no stream.");
      }
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      byte[] buffer = new byte[64 * 1024];
      int read;
      while ((read = input.read(buffer)) != -1) {
        if (output.size() + read > PosterRules.MAX_IMAGE_BYTES) {
          throw new PosterFailure("resource-limit", "The selected image is too large.");
        }
        output.write(buffer, 0, read);
      }
      if (output.size() == 0) {
        throw new PosterFailure("invalid-request", "The selected image is empty.");
      }
      return image(mimeType, output.toByteArray());
    } catch (FileNotFoundException cause) {
      throw new PosterFailure("not-found", "The selected image does not exist.", cause);
    } catch (IOException | SecurityException cause) {
      throw new PosterFailure("io-failure", "Failed to read the selected image.", cause);
    }
  }

  @PluginMethod
  public void save(PluginCall call) {
    submit(files, call, () -> {
      String gameId = requiredString(call.getData(), "gameId");
      byte[] content;
      try {
        content = Base64.getDecoder().decode(requiredString(call.getData(), "data"));
      } catch (IllegalArgumentException cause) {
        throw new PosterFailure("invalid-request", "The poster data is not base64.", cause);
      }
      JSObject value = new JSObject();
      value.put("posterHash", store.save(gameId, content));
      return value;
    });
  }

  @PluginMethod
  public void read(PluginCall call) {
    submit(files, call, () -> {
      byte[] content = store.read(
        requiredString(call.getData(), "gameId"),
        requiredString(call.getData(), "posterHash")
      );
      JSObject value = new JSObject();
      value.put("data", Base64.getEncoder().encodeToString(content));
      return value;
    });
  }

  @Override
  protected void handleOnDestroy() {
    network.shutdownNow();
    files.shutdownNow();
  }
}
