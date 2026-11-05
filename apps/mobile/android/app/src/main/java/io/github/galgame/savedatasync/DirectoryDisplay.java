package io.github.galgame.savedatasync;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import java.io.File;
import java.util.ArrayList;
import java.util.List;

/** 生成目录的展示信息；文件操作仍用 SAF 引用，拼接出的路径只用于显示。 */
final class DirectoryDisplay {
    static final class Info {
        final String path;
        final String parentName;
        Info(String path, String parentName) { this.path = path; this.parentName = parentName; }
    }
    private DirectoryDisplay() {}

    @SuppressWarnings("deprecation")
    private static File storageRoot(Context context, String volumeId) {
        if ("primary".equals(volumeId)) return Environment.getExternalStorageDirectory();
        if ("home".equals(volumeId)) return Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            StorageManager manager = (StorageManager) context.getSystemService(Context.STORAGE_SERVICE);
            if (manager != null) for (StorageVolume volume : manager.getStorageVolumes()) {
                if (volumeId.equalsIgnoreCase(volume.getUuid()) && volume.getDirectory() != null) return volume.getDirectory();
            }
        }
        return null;
    }

    /** 系统存储提供者的目录对应的实际位置；其他提供者或未知卷返回 null。 */
    private static File location(Context context, Uri tree) {
        if (!"com.android.externalstorage.documents".equals(tree.getAuthority())) return null;
        String[] parts = DocumentsContract.getTreeDocumentId(tree).split(":", 2);
        File base = storageRoot(context, parts[0]);
        if (base == null) return null;
        return parts.length == 2 && !parts[1].isEmpty() ? new File(base, parts[1]) : base;
    }

    /** Android 10 还能选中存储根或 Android/data；同步根不能和备份目录互相包含。 */
    static boolean overlapsBackups(Context context, Uri tree) {
        File selected = location(context, tree), external = context.getExternalFilesDir(null);
        if (selected == null || external == null) return false;
        return selected.toPath().startsWith(external.toPath()) || external.toPath().startsWith(selected.toPath());
    }

    static Info resolve(Context context, ContentResolver resolver, Uri tree, String name) {
        String id = DocumentsContract.getTreeDocumentId(tree);
        File directory = location(context, tree);
        if (directory != null) {
            File parent = directory.getParentFile();
            String parentName = parent == null || parent.getName().isEmpty() ? name : parent.getName();
            return new Info(directory.getAbsolutePath(), parentName);
        }
        try {
            Uri document = DocumentsContract.buildDocumentUriUsingTree(tree, id);
            DocumentsContract.Path hierarchy = DocumentsContract.findDocumentPath(resolver, document);
            if (hierarchy != null && hierarchy.getPath().size() > 1) {
                List<String> names = new ArrayList<>();
                for (String documentId : hierarchy.getPath()) {
                    Uri uri = DocumentsContract.buildDocumentUriUsingTree(tree, documentId);
                    try (Cursor cursor = resolver.query(uri, new String[] { Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
                        if (cursor == null || !cursor.moveToFirst() || cursor.isNull(0)) return new Info(tree.toString(), null);
                        names.add(cursor.getString(0));
                    }
                }
                return new Info(tree.getAuthority() + ":/" + String.join("/", names), names.get(names.size() - 2));
            }
        } catch (Exception ignored) {
            // 第三方提供者未开放上级目录时，展示完整文档地址，不猜测真实文件系统路径。
        }
        return new Info(tree.toString(), null);
    }
}
