package io.github.galgame.savedatasync;

import android.animation.ValueAnimator;
import android.annotation.SuppressLint;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.drawable.AdaptiveIconDrawable;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.view.animation.LinearInterpolator;
import android.widget.FrameLayout;
import androidx.appcompat.content.res.AppCompatResources;
import androidx.core.splashscreen.SplashScreenViewProvider;

/**
 * 接管系统图标的位置和尺寸，眨眼时扩大圆形遮罩露出立绘，再淡出背景并让角色保持不透明滑出。
 * 只在 Activity 的主线程使用；每个实例只播放一次，stop 释放动画、延迟任务和开屏 View，
 * 再次播放时由 MainActivity 创建新实例。
 */
final class LaunchAnimation {

  private static final int FRAME_MS = 25;
  private static final int BETWEEN_BLINKS_MS = 150;
  private static final int REVEAL_START_MS = 8 * FRAME_MS;
  private static final int REVEAL_END_MS = 700;
  private static final int AFTER_REVEAL_MS = 250;
  private static final int SLIDE_MS = 400;
  private static final int EXIT_MS = REVEAL_END_MS + AFTER_REVEAL_MS + SLIDE_MS;
  private static final int MAX_WAIT_MS = 5000;
  private static final int[] FRAMES = {
    R.drawable.splash_open,
    R.drawable.splash_slight,
    R.drawable.splash_half,
    R.drawable.splash_near,
    R.drawable.splash_closed,
    R.drawable.splash_near,
    R.drawable.splash_half,
    R.drawable.splash_slight,
    R.drawable.splash_open,
    R.drawable.splash_slight,
    R.drawable.splash_half,
    R.drawable.splash_near,
    R.drawable.splash_closed,
    R.drawable.splash_near,
    R.drawable.splash_half,
    R.drawable.splash_slight,
    R.drawable.splash_open,
  };
  private static final int BLINK_MS = (FRAMES.length - 1) * FRAME_MS + BETWEEN_BLINKS_MS;

  private final Handler handler = new Handler(Looper.getMainLooper());
  private final Runnable timeout = this::stop;
  private final ViewTreeObserver.OnPreDrawListener insetsListener = this::moveInsetsToContent;
  private ValueAnimator animator;
  private int iconWidth;
  private int iconHeight;
  private AvatarView avatar;
  private ViewGroup window;
  private View content;
  private final int[] contentPadding = new int[4];
  private final int[] windowPadding = new int[4];
  private boolean hasMovedInsets;
  private BlinkDrawable blink;
  private boolean isContentReady;
  private boolean shouldSkip;
  private int elapsedMs;
  private boolean isStopped;
  private boolean hasExitStarted;
  private boolean hasBlinkStarted;

  /** 在 Activity 首帧之前准备覆盖层，使系统开屏移除后，同一位置已经显示睁眼头像。 */
  void prepare(ViewGroup decor) {
    if (isStopped) {
      return;
    }
    window = decor;
    content = window.findViewById(android.R.id.content);
    contentPadding[0] = content.getPaddingLeft();
    contentPadding[1] = content.getPaddingTop();
    contentPadding[2] = content.getPaddingRight();
    contentPadding[3] = content.getPaddingBottom();
    window.getViewTreeObserver().addOnPreDrawListener(insetsListener);
    moveInsetsToContent();
    float viewportScale = Build.VERSION.SDK_INT >= 31 ? 1.5f : 1f;
    iconWidth = Math.round(
      window
        .getResources()
        .getDimension(androidx.core.splashscreen.R.dimen.splashscreen_icon_size_no_background) /
        viewportScale
    );
    iconHeight = iconWidth;
    // 五张 WebP 在播放前解码；沿用系统图标实际尺寸。
    Drawable[] frames = new Drawable[FRAMES.length];
    for (int i = 0; i < FRAMES.length; i++) {
      // 五张图片只解码一次；同一帧在闭眼与睁眼阶段复用。
      for (int j = 0; j < i; j++) {
        if (FRAMES[j] == FRAMES[i]) {
          frames[i] = frames[j];
          break;
        }
      }
      if (frames[i] == null) {
        frames[i] = AppCompatResources.getDrawable(window.getContext(), FRAMES[i]).mutate();
      }
    }
    // Android 12+ 把静态图当作自适应前景放大 1.5 倍；旧版兼容库直接裁 2/3 圆。
    Bitmap portrait = BitmapFactory.decodeResource(
      window.getResources(),
      R.drawable.splash_portrait
    );
    blink = new BlinkDrawable(
      frames,
      portrait,
      Build.VERSION.SDK_INT >= 31 ? getSystemRasterSize() : 0
    );
    portrait.recycle();
    animator = ValueAnimator.ofInt(0, EXIT_MS);
    animator.setDuration(EXIT_MS);
    animator.setInterpolator(new LinearInterpolator());
    animator.addUpdateListener(value -> {
      int elapsed = (int) value.getAnimatedValue();
      elapsedMs = elapsed;
      int index =
        elapsed < 8 * FRAME_MS
          ? elapsed / FRAME_MS
          : elapsed < 8 * FRAME_MS + BETWEEN_BLINKS_MS
            ? 8
            : Math.min(
                9 + (elapsed - 8 * FRAME_MS - BETWEEN_BLINKS_MS) / FRAME_MS,
                FRAMES.length - 1
              );
      blink.showFrame(index);
      blink.reveal(
        Math.max(
          0f,
          Math.min(1f, (elapsed - REVEAL_START_MS) / (float) (REVEAL_END_MS - REVEAL_START_MS))
        )
      );
      avatar.invalidate();
      if (elapsed >= EXIT_MS) {
        stop();
      }
    });
    // 先绘制睁眼帧；收到系统退出回调后才播放动画。
    avatar = new AvatarView();
    window.addView(
      avatar,
      new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    );
    handler.postDelayed(timeout, MAX_WAIT_MS);
  }

  @SuppressLint("DiscouragedApi")
  private int getSystemRasterSize() {
    // 系统先按这个尺寸预绘制，再放大到实际图标尺寸；直接画到屏幕会使边缘相差一像素。
    // 读取设备实际的框架资源以兼容厂商覆盖值；资源缺省时使用自适应图标的 108dp 画布。
    int resource = window
      .getResources()
      .getIdentifier("starting_surface_default_icon_size", "dimen", "android");
    return resource == 0
      ? Math.round(108 * window.getResources().getDisplayMetrics().density)
      : window.getResources().getDimensionPixelSize(resource);
  }

  private boolean moveInsetsToContent() {
    int left = window.getPaddingLeft();
    int top = window.getPaddingTop();
    int right = window.getPaddingRight();
    int bottom = window.getPaddingBottom();
    if (left == 0 && top == 0 && right == 0 && bottom == 0) {
      return true;
    }
    // Capacitor 把系统栏边距加在 DecorView，连系统的开屏副本也会被挤动。
    // 动画期间把同一份边距放在正文上；跳过这次绘制，等布局完成后再显示。
    windowPadding[0] = left;
    windowPadding[1] = top;
    windowPadding[2] = right;
    windowPadding[3] = bottom;
    hasMovedInsets = true;
    content.setPadding(
      contentPadding[0] + left,
      contentPadding[1] + top,
      contentPadding[2] + right,
      contentPadding[3] + bottom
    );
    window.setPadding(0, 0, 0, 0);
    return false;
  }

  /**
   * 从后台返回或 Activity 重建时准备并播放开屏动画。系统开屏不一定出现，所以直接按它已退出处理，
   * 头像使用 prepare 算出的图标尺寸；动画在 contentReady 后的第一次绘制开始，与系统的窗口切换动画同时进行。
   * 系统关闭动画效果时不显示覆盖层。
   */
  void replay(ViewGroup decor) {
    if (!ValueAnimator.areAnimatorsEnabled()) {
      stop();
      return;
    }
    prepare(decor);
    hasExitStarted = true;
  }

  /** 处理系统开屏退出，立即移除会随状态栏重排移动的系统副本。 */
  void start(SplashScreenViewProvider splash) {
    if (isStopped) {
      splash.remove();
      return;
    }
    View icon = splash.getIconView();
    if (icon.getWidth() > 0 && icon.getHeight() > 0) {
      iconWidth = icon.getWidth();
      iconHeight = icon.getHeight();
    }
    hasExitStarted = true;
    splash.remove();
    handler.removeCallbacks(timeout);
    handler.postDelayed(timeout, MAX_WAIT_MS);
    if (!ValueAnimator.areAnimatorsEnabled()) {
      shouldSkip = true;
    }
    continueWhenReady();
  }

  /** 网页首屏或启动错误提示可先于系统开屏退出到达。收到通知后等待 WebView 完成绘制，重复调用无副作用。 */
  void contentReady() {
    isContentReady = true;
    continueWhenReady();
  }

  private void skipBlink() {
    shouldSkip = true;
    continueWhenReady();
  }

  private void continueWhenReady() {
    if (isStopped || !hasExitStarted || !isContentReady) {
      return;
    }
    if (shouldSkip) {
      stop();
      return;
    }
    avatar.invalidate();
  }

  /** 前 30% 时间从零匀加速，之后匀速；两段在连接处的位置和速度均连续。 */
  private static float accelerateThenCruise(float progress) {
    float acceleration = 0.3f;
    return progress < acceleration
      ? (progress * progress) / (acceleration * (2f - acceleration))
      : (2f * progress - acceleration) / (2f - acceleration);
  }

  /** Activity 退出、转后台或等待超过 5 秒时移除覆盖层；之后这个实例再收到回调也不会播放。 */
  void stop() {
    isStopped = true;
    handler.removeCallbacks(timeout);
    if (animator != null) {
      animator.cancel();
      animator.removeAllUpdateListeners();
      animator = null;
    }
    if (avatar != null) {
      avatar.animate().cancel();
      window.removeView(avatar);
    }
    if (window != null) {
      ViewTreeObserver observer = window.getViewTreeObserver();
      if (observer.isAlive()) {
        observer.removeOnPreDrawListener(insetsListener);
      }
      if (hasMovedInsets) {
        content.setPadding(
          contentPadding[0],
          contentPadding[1],
          contentPadding[2],
          contentPadding[3]
        );
        window.setPadding(windowPadding[0], windowPadding[1], windowPadding[2], windowPadding[3]);
      }
    }
    avatar = null;
    window = null;
    content = null;
    blink = null;
  }

  /** 绘制时直接换算窗口中心到本地画布；状态栏 padding 重排不会改变头像的屏幕坐标。 */
  private final class AvatarView extends View {

    private final int[] windowPosition = new int[2];
    private final int[] viewPosition = new int[2];
    private final Paint background = new Paint();

    AvatarView() {
      super(window.getContext());
      background.setColor(getContext().getColor(R.color.app_background));
      setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
      setOnClickListener(view -> skipBlink());
    }

    @Override
    protected void onDraw(Canvas canvas) {
      super.onDraw(canvas);
      if (isStopped) {
        return;
      }
      // 背景单独淡出；角色绘制始终使用完整不透明度。
      float backgroundProgress = Math.max(
        0f,
        (elapsedMs - BLINK_MS) / (float) (EXIT_MS - BLINK_MS)
      );
      background.setAlpha(Math.round(255 * (1f - backgroundProgress)));
      canvas.drawRect(0, 0, getWidth(), getHeight(), background);
      window.getLocationOnScreen(windowPosition);
      getLocationOnScreen(viewPosition);
      int left = windowPosition[0] + (window.getWidth() - iconWidth) / 2 - viewPosition[0];
      int top = windowPosition[1] + (window.getHeight() - iconHeight) / 2 - viewPosition[1];
      blink.setBounds(left, top, left + iconWidth, top + iconHeight);
      float slideProgress = Math.max(
        0f,
        Math.min(1f, (elapsedMs - REVEAL_END_MS - AFTER_REVEAL_MS) / (float) SLIDE_MS)
      );
      int saved = canvas.save();
      // 角色头顶越过窗口底边时动画结束，背景也在同一时刻变为全透明。
      canvas.translate(
        0,
        (getHeight() - blink.getPortraitTop() + 1) * accelerateThenCruise(slideProgress)
      );
      blink.draw(canvas);
      canvas.restoreToCount(saved);
      if (hasExitStarted && isContentReady && !hasBlinkStarted && !shouldSkip) {
        hasBlinkStarted = true;
        postOnAnimation(() -> {
          if (!isStopped && !shouldSkip) {
            animator.start();
          }
        });
      }
    }
  }

  /** 首帧复现系统预绘制结果；立绘使用相同的像素网格，圆形遮罩扩大时头部位置不变。 */
  private static final class BlinkDrawable extends Drawable {

    private final Drawable[] frames;
    private final Bitmap[] rasterFrames;
    private final Bitmap portrait;
    private final int portraitTop;
    private final int rasterSize;
    private final int sourceOrigin;
    private final int sourceSize;
    private final RectF portraitBounds = new RectF();
    private final RectF eyeBounds = new RectF();
    private final Paint bitmapPaint = new Paint(
      Paint.ANTI_ALIAS_FLAG | Paint.DITHER_FLAG | Paint.FILTER_BITMAP_FLAG
    );
    private final Path mask = new Path();
    private int index;
    private float revealFraction;

    BlinkDrawable(Drawable[] frames, Bitmap fullPortrait, int rasterSize) {
      this.frames = frames;
      this.rasterSize = rasterSize > 0 ? rasterSize : frames[0].getIntrinsicWidth();
      int center = this.rasterSize / 2;
      int inset = (int) (this.rasterSize / ((2f / 3f) * 2));
      sourceOrigin = rasterSize > 0 ? center - inset : 0;
      sourceSize = rasterSize > 0 ? inset * 2 : this.rasterSize;
      // 只预绘制一张完整立绘；眼睛从现有五帧取局部，避免复制五份身体位图。
      float height = (fullPortrait.getHeight() * sourceSize) / (float) fullPortrait.getWidth();
      portrait = Bitmap.createBitmap(sourceSize, (int) Math.ceil(height), Bitmap.Config.ARGB_8888);
      new Canvas(portrait).drawBitmap(
        fullPortrait,
        null,
        new RectF(0, 0, sourceSize, height),
        bitmapPaint
      );
      portrait.prepareToDraw();
      portraitTop = firstVisibleRow(portrait);
      rasterFrames = rasterSize > 0 ? new Bitmap[frames.length] : null;
      if (rasterFrames == null) {
        return;
      }
      AdaptiveIconDrawable shape = new AdaptiveIconDrawable(null, null);
      shape.setBounds(0, 0, rasterSize, rasterSize);
      Path systemMask = shape.getIconMask();
      // 与系统 AdaptiveForegroundDrawable 一样，中心和前景半宽都按整数截断。
      for (int i = 0; i < frames.length; i++) {
        for (int j = 0; j < i; j++) {
          if (frames[i] == frames[j]) {
            rasterFrames[i] = rasterFrames[j];
            break;
          }
        }
        if (rasterFrames[i] != null) {
          continue;
        }
        Bitmap bitmap = Bitmap.createBitmap(rasterSize, rasterSize, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        canvas.clipPath(systemMask);
        frames[i].setBounds(center - inset, center - inset, center + inset, center + inset);
        frames[i].draw(canvas);
        bitmap.prepareToDraw();
        rasterFrames[i] = bitmap;
      }
    }

    void showFrame(int index) {
      if (this.index == index) {
        return;
      }
      this.index = index;
      invalidateSelf();
    }

    void reveal(float fraction) {
      revealFraction = fraction;
    }

    private static int firstVisibleRow(Bitmap bitmap) {
      int[] pixels = new int[bitmap.getWidth()];
      for (int row = 0; row < bitmap.getHeight(); row++) {
        bitmap.getPixels(pixels, 0, pixels.length, 0, row, pixels.length, 1);
        for (int pixel : pixels) {
          if (pixel >>> 24 != 0) {
            return row;
          }
        }
      }
      return 0;
    }

    float getPortraitTop() {
      // 留一行滤波余量，确保头顶的半透明边缘也滑出窗口。
      return portraitBounds.top + ((portraitTop - 1) * getBounds().height()) / (float) rasterSize;
    }

    @Override
    protected void onBoundsChange(Rect bounds) {
      float scaleX = bounds.width() / (float) rasterSize;
      float scaleY = bounds.height() / (float) rasterSize;
      portraitBounds.set(
        bounds.left + sourceOrigin * scaleX,
        bounds.top + sourceOrigin * scaleY,
        bounds.left + (sourceOrigin + sourceSize) * scaleX,
        bounds.top + (sourceOrigin + portrait.getHeight()) * scaleY
      );
      // 眼睛范围按 648px 逻辑坐标定义，与素材分辨率无关，并覆盖眨眼差异和滤波边缘。
      eyeBounds.set(
        portraitBounds.left + (sourceSize * scaleX * 218) / 648,
        portraitBounds.top + (sourceSize * scaleY * 313) / 648,
        portraitBounds.left + (sourceSize * scaleX * 428) / 648,
        portraitBounds.top + (sourceSize * scaleY * 395) / 648
      );
      if (rasterFrames != null) {
        return;
      }
      for (Drawable frame : frames) {
        frame.setBounds(bounds);
      }
      mask.reset();
      mask.addCircle(
        bounds.exactCenterX(),
        bounds.exactCenterY(),
        Math.min(bounds.width(), bounds.height()) / 3f,
        Path.Direction.CW
      );
    }

    @Override
    public void draw(Canvas canvas) {
      if (revealFraction > 0f) {
        drawPortrait(canvas);
        return;
      }
      drawHead(canvas);
    }

    private void drawPortrait(Canvas canvas) {
      Rect bounds = getBounds();
      float centerX =
        bounds.left + ((sourceOrigin + sourceSize / 2f) * bounds.width()) / rasterSize;
      float centerY =
        bounds.top + ((sourceOrigin + sourceSize / 2f) * bounds.height()) / rasterSize;
      float startRadius =
        (sourceSize * Math.min(bounds.width(), bounds.height())) / (3f * rasterSize);
      // 覆盖窗口四角即可显示全部屏内内容；立绘继续延伸到屏幕底部之外。
      float endRadius = (float) Math.hypot(
        Math.max(centerX, canvas.getWidth() - centerX),
        Math.max(centerY, canvas.getHeight() - centerY)
      );
      float progress = accelerateThenCruise(revealFraction);
      mask.reset();
      mask.addCircle(
        centerX,
        centerY,
        startRadius + (endRadius - startRadius) * progress,
        Path.Direction.CW
      );
      final int saved = canvas.save();
      canvas.clipPath(mask);
      canvas.drawBitmap(portrait, null, portraitBounds, bitmapPaint);
      canvas.clipRect(eyeBounds);
      drawHead(canvas);
      canvas.restoreToCount(saved);
    }

    private void drawHead(Canvas canvas) {
      if (rasterFrames != null) {
        canvas.drawBitmap(rasterFrames[index], null, getBounds(), bitmapPaint);
        return;
      }
      final int saved = canvas.save();
      // 旧版没有系统预绘制，眼睛局部绘制时仍沿用头像的圆形安全区。
      Rect bounds = getBounds();
      canvas.clipRect(bounds);
      if (revealFraction == 0f) {
        canvas.clipPath(mask);
      }
      frames[index].draw(canvas);
      canvas.restoreToCount(saved);
    }

    @Override
    public void setAlpha(int alpha) {
      bitmapPaint.setAlpha(alpha);
      for (Drawable frame : frames) {
        frame.setAlpha(alpha);
      }
    }

    @Override
    public void setColorFilter(ColorFilter filter) {
      bitmapPaint.setColorFilter(filter);
      for (Drawable frame : frames) {
        frame.setColorFilter(filter);
      }
    }

    @Override
    public int getOpacity() {
      return PixelFormat.TRANSLUCENT;
    }

    @Override
    public int getIntrinsicWidth() {
      return frames[0].getIntrinsicWidth();
    }

    @Override
    public int getIntrinsicHeight() {
      return frames[0].getIntrinsicHeight();
    }
  }
}
