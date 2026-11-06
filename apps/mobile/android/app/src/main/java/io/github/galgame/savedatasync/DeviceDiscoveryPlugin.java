package io.github.galgame.savedatasync;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 局域网设备搜索的原生桥：网页调用 start 和 stop 控制 {@link DiscoveryBrowser}，结果变化时发 discoveryState 事件。
 * start、stop 和事件的内容都是 {@link DiscoveryBrowser#snapshot()}；TXT 字段的校验由网页的 shared 函数完成。
 * Activity 停止时暂停搜索，回到前台时继续，销毁时结束。
 */
@CapacitorPlugin(name = "DeviceDiscovery")
public class DeviceDiscoveryPlugin extends Plugin {

  private DiscoveryBrowser browser;

  @Override
  public void load() {
    browser = new DiscoveryBrowser(getContext(), snapshot ->
      notifyListeners("discoveryState", toJsObject(snapshot))
    );
  }

  @PluginMethod
  public void start(PluginCall call) {
    browser.start(snapshot -> call.resolve(toJsObject(snapshot)));
  }

  @PluginMethod
  public void stop(PluginCall call) {
    browser.stop(snapshot -> call.resolve(toJsObject(snapshot)));
  }

  @Override
  protected void handleOnStart() {
    browser.setForeground(true);
  }

  @Override
  protected void handleOnStop() {
    browser.setForeground(false);
  }

  @Override
  protected void handleOnDestroy() {
    browser.close();
  }

  private static JSObject toJsObject(JSONObject snapshot) {
    try {
      return JSObject.fromJSONObject(snapshot);
    } catch (JSONException impossible) {
      throw new IllegalStateException(impossible);
    }
  }
}
