package io.github.galgame.savedatasync;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.view.WindowManager;
import android.widget.TextView;

/**
 * Debug-only chooser for a newly created benchmark fixture. Never registered in release builds.
 * A write grant is accepted only for the exact external-storage document ID supplied by the test.
 * Uses separate private test settings; it cannot modify the production read-only registry.
 */
public class BenchmarkGrantActivity extends Activity {
    static final String SETTINGS = "transfer-benchmark-grant";
    static final int RIGHTS = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
    static volatile boolean foreground;
    private String expectedId;
    private TextView status;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        status = new TextView(this);
        status.setPadding(32, 64, 32, 32);
        status.setText("仅选择新建的 SaveDataSync-NetBench 测试目录。基准期间请保持此页面在前台。");
        setContentView(status);
        String token = getIntent().getStringExtra("token");
        if (token == null || !token.matches("[a-f0-9]{16}")) {
            finish();
            return;
        }
        expectedId = "primary:Download/SaveDataSync-NetBench-" + token;
        if (state != null) return;
        getSharedPreferences(SETTINGS, MODE_PRIVATE).edit().clear().commit();
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(RIGHTS | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI,
            DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", expectedId));
        startActivityForResult(intent, 1);
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        try {
            if (request != 1 || result != RESULT_OK || data == null || data.getData() == null) {
                throw new IllegalStateException("Selection cancelled");
            }
            Uri uri = data.getData();
            if (!"com.android.externalstorage.documents".equals(uri.getAuthority()) ||
                !expectedId.equals(DocumentsContract.getTreeDocumentId(uri)) ||
                (data.getFlags() & RIGHTS) != RIGHTS ||
                (data.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) == 0) {
                throw new SecurityException("Only the exact benchmark fixture is allowed");
            }
            getContentResolver().takePersistableUriPermission(uri, RIGHTS);
            if (!getSharedPreferences(SETTINGS, MODE_PRIVATE).edit().putString("uri", uri.toString()).commit()) {
                getContentResolver().releasePersistableUriPermission(uri, RIGHTS);
                throw new IllegalStateException("Cannot save test grant");
            }
            status.setText("基准测试运行中，请保持前台。所有写入和清理仅限本轮新建的测试目录。");
        } catch (Exception cause) {
            getSharedPreferences(SETTINGS, MODE_PRIVATE).edit().putBoolean("failed", true).commit();
            status.setText("测试目录未获授权，基准已停止。");
        }
    }

    @Override protected void onResume() { super.onResume(); foreground = true; }
    @Override protected void onPause() { foreground = false; super.onPause(); }
}
