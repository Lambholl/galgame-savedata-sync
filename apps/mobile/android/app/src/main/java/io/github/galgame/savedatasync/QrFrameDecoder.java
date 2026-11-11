package io.github.galgame.savedatasync;

import androidx.annotation.Nullable;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.NotFoundException;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.common.HybridBinarizer;
import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;

/**
 * 从相机帧的亮度数据里识别二维码，正常的深色码和监听方深色主题显示的反色码（深底浅色）都能读出。
 * 实例不是线程安全的。
 */
final class QrFrameDecoder {

  private final MultiFormatReader reader = new MultiFormatReader();

  QrFrameDecoder() {
    Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
    hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
    hints.put(DecodeHintType.ALSO_INVERTED, Boolean.TRUE);
    reader.setHints(hints);
  }

  /**
   * 识别一帧。
   *
   * @param luminance 逐行紧密排列的亮度，长度至少为 width * height。
   * @param width 帧宽（像素）。
   * @param height 帧高（像素）。
   * @return 二维码的文本；这一帧里没有能读出的二维码时返回 {@code null}。
   */
  @Nullable
  String decode(byte[] luminance, int width, int height) {
    PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(
      luminance,
      width,
      height,
      0,
      0,
      width,
      height,
      false
    );
    try {
      // decode() 会清掉 setHints 设置的选项，所以用 decodeWithState。
      return reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(source))).getText();
    } catch (NotFoundException noCodeInFrame) {
      // 大多数帧里没有完整的二维码，继续分析下一帧。
      return null;
    } finally {
      reader.reset();
    }
  }
}
