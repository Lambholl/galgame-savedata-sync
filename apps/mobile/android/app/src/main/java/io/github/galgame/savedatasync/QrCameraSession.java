package io.github.galgame.savedatasync;

import android.os.SystemClock;
import android.util.Log;
import android.util.Size;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.core.resolutionselector.ResolutionSelector;
import androidx.camera.core.resolutionselector.ResolutionStrategy;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import com.google.common.util.concurrent.ListenableFuture;
import java.nio.ByteBuffer;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/**
 * 一次扫码的相机：把取景画面放在透明的 WebView 下面，并在单独的线程上逐帧识别二维码。
 * 相机绑定 Activity 的生命周期，应用退到后台时系统关闭相机，回到前台后恢复。
 * {@link #open} 和 {@link #close} 只能在主线程调用。
 */
final class QrCameraSession {

  private static final String TAG = "QrCameraSession";

  /** 分析帧的目标尺寸：8 个候选地址的二维码约 60 个模块，占画面一半时每个模块仍有足够的像素。 */
  private static final Size ANALYSIS_SIZE = new Size(1280, 720);

  /** 同一段文本在这段时间内只上报一次（毫秒），相机对准二维码时每一帧都能读出同样的内容。 */
  private static final long REPEAT_INTERVAL_MILLIS = 2000;

  private final AppCompatActivity activity;
  private final WebView webView;
  private final Consumer<String> onDetected;
  private final ExecutorService analyzerExecutor = Executors.newSingleThreadExecutor();

  // 下面三个字段只在主线程读写。
  private boolean isClosed;

  @Nullable
  private ProcessCameraProvider provider;

  @Nullable
  private PreviewView previewView;

  // 下面四个字段只在分析线程读写。
  private final QrFrameDecoder decoder = new QrFrameDecoder();
  private byte[] luminance = new byte[0];

  @Nullable
  private String lastText;

  private long lastReportMillis;

  /**
   * 创建相机会话，创建后调用 {@link #open}。
   *
   * @param activity 相机绑定的 Activity。
   * @param webView 取景画面放在它的下面，它的背景必须透明。
   * @param onDetected 在分析线程上收到识别出的文本；{@link #close} 之后可能还会收到一次。
   */
  QrCameraSession(AppCompatActivity activity, WebView webView, Consumer<String> onDetected) {
    this.activity = activity;
    this.webView = webView;
    this.onDetected = onDetected;
  }

  /**
   * 打开后置相机并开始识别。
   *
   * @param onOpened 在主线程上收到结果：true 表示相机已绑定，false 表示打不开（没有后置相机或被其他应用占用）或会话已关闭。
   */
  void open(Consumer<Boolean> onOpened) {
    ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(activity);
    future.addListener(
      () -> onOpened.accept(bindWhenReady(future)),
      ContextCompat.getMainExecutor(activity)
    );
  }

  /** 关闭相机并移除取景画面。重复调用没有效果。 */
  void close() {
    if (isClosed) {
      return;
    }
    isClosed = true;
    if (provider != null) {
      provider.unbindAll();
    }
    if (previewView != null) {
      ((ViewGroup) previewView.getParent()).removeView(previewView);
    }
    analyzerExecutor.shutdown();
  }

  private boolean bindWhenReady(ListenableFuture<ProcessCameraProvider> future) {
    if (isClosed) {
      return false;
    }
    try {
      provider = future.get();
      bindCamera(provider);
      return true;
    } catch (ExecutionException | IllegalArgumentException | IllegalStateException cause) {
      Log.w(TAG, "Failed to open the camera", cause);
      close();
      return false;
    } catch (InterruptedException cause) {
      Thread.currentThread().interrupt();
      close();
      return false;
    }
  }

  private void bindCamera(ProcessCameraProvider cameraProvider) {
    PreviewView view = new PreviewView(activity);
    // COMPATIBLE 模式用 TextureView，画面和普通 View 一样按层级合成，放在透明的 WebView 下面能直接透出来。
    view.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
    ((ViewGroup) webView.getParent()).addView(
      view,
      0,
      new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    );
    previewView = view;
    Preview preview = new Preview.Builder().build();
    preview.setSurfaceProvider(view.getSurfaceProvider());
    ImageAnalysis analysis = new ImageAnalysis.Builder()
      .setResolutionSelector(
        new ResolutionSelector.Builder()
          .setResolutionStrategy(
            new ResolutionStrategy(
              ANALYSIS_SIZE,
              ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER
            )
          )
          .build()
      )
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .build();
    analysis.setAnalyzer(analyzerExecutor, this::analyze);
    cameraProvider.bindToLifecycle(activity, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis);
  }

  private void analyze(ImageProxy image) {
    try (ImageProxy frame = image) {
      int width = frame.getWidth();
      int height = frame.getHeight();
      String text = decoder.decode(
        copyLuminance(frame.getPlanes()[0], width, height),
        width,
        height
      );
      if (text != null && shouldReport(text)) {
        onDetected.accept(text);
      }
    }
  }

  private byte[] copyLuminance(ImageProxy.PlaneProxy plane, int width, int height) {
    int size = width * height;
    if (luminance.length != size) {
      luminance = new byte[size];
    }
    ByteBuffer buffer = plane.getBuffer();
    int rowStride = plane.getRowStride();
    for (int row = 0; row < height; row++) {
      buffer.position(row * rowStride);
      buffer.get(luminance, row * width, width);
    }
    return luminance;
  }

  private boolean shouldReport(String text) {
    long now = SystemClock.elapsedRealtime();
    if (text.equals(lastText) && now - lastReportMillis < REPEAT_INTERVAL_MILLIS) {
      return false;
    }
    lastText = text;
    lastReportMillis = now;
    return true;
  }
}
