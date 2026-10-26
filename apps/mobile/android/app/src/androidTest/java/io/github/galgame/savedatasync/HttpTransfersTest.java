package io.github.galgame.savedatasync;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;
import android.content.Context;
import android.content.Intent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** 仅用于收回中断验证留下的精确合成目录权限；实际传输改用 ADB 人工操作验证。 */
@RunWith(AndroidJUnit4.class)
public class HttpTransfersTest {
    private Context context() { return InstrumentationRegistry.getInstrumentation().getTargetContext(); }
    /** 中断或误选后的精确合成夹具收尾；不接收真实目录或任意 URI。 */
    @Test public void cleanupInterruptedSyntheticWriteGrant() throws Exception {
        String name = InstrumentationRegistry.getArguments().getString("transferCleanupFixture"); assumeTrue(name != null);
        assertTrue(name.matches("SaveDataSync-(?:Http|Publish)-[a-f0-9]{16}"));
        android.net.Uri uri = android.provider.DocumentsContract.buildTreeDocumentUri("com.android.externalstorage.documents", "primary:Download/" + name);
        for (android.content.UriPermission permission : context().getContentResolver().getPersistedUriPermissions()) {
            if (uri.equals(permission.getUri())) {
                int rights = name.startsWith("SaveDataSync-Http-") ? Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION : Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
                int owned = (permission.isReadPermission() ? Intent.FLAG_GRANT_READ_URI_PERMISSION : 0) | (permission.isWritePermission() ? Intent.FLAG_GRANT_WRITE_URI_PERMISSION : 0);
                if ((owned & rights) != 0) context().getContentResolver().releasePersistableUriPermission(uri, owned & rights);
            }
        }
        if (name.startsWith("SaveDataSync-Http-")) {
            android.content.SharedPreferences prefs = context().getSharedPreferences(SafDirectoryStore.PREFERENCES, Context.MODE_PRIVATE);
            String text = prefs.getString("registry", null);
            if (text != null) {
                JSONObject registry = new JSONObject(text); JSONArray roots = registry.getJSONArray("roots"), kept = new JSONArray();
                for (int i = 0; i < roots.length(); i++) { JSONObject root = roots.getJSONObject(i);
                    if (!name.equals(root.getString("displayName")) || !uri.toString().equals(root.getString("treeUri"))) kept.put(root);
                }
                if (kept.length() != roots.length()) { registry.put("roots", kept); assertTrue(prefs.edit().putString("registry", registry.toString()).commit()); }
            }
        }
    }
}
