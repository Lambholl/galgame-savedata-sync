package io.github.galgame.savedatasync;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import java.io.File;
import java.util.ArrayList;
import java.util.List;

/** 生成目录的展示信息，并把系统存储提供者的文档 ID 换算成实际位置。 */
final class DirectoryDisplay {

  static final class Info {

    final String path;
    final String parentName;

    Info(String path, String parentName) {
      this.path = path;
      this.parentName = parentName;
    }
  }

  /** 系统存储提供者的 authority；它的文档 ID 是 {@code 卷 ID:相对路径}。 */
  static final String EXTERNAL_STORAGE = "com.android.externalstorage.documents";

  private DirectoryDisplay() {}

  @SuppressWarnings("deprecation")
  private static File storageRoot(Context context, String volumeId) {
    if ("primary".equals(volumeId)) {
      return Environment.getExternalStorageDirectory();
    }
    if ("home".equals(volumeId)) {
      return Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS);
    }
    StorageManager manager = (StorageManager) context.getSystemService(Context.STORAGE_SERVICE);
    if (manager != null) {
      for (StorageVolume volume : manager.getStorageVolumes()) {
        if (volumeId.equalsIgnoreCase(volume.getUuid()) && volume.getDirectory() != null) {
          return volume.getDirectory();
        }
      }
    }
    return null;
  }

  /**
   * 返回系统存储提供者的文档对应的实际位置。
   *
   * @param documentId 形如 {@code 卷 ID:相对路径}，相对路径为空表示卷的根。
   * @return 其他提供者、未知卷或格式不符时返回 null；不检查路径是否存在。
   */
  static File location(Context context, String authority, String documentId) {
    if (!EXTERNAL_STORAGE.equals(authority)) {
      return null;
    }
    String[] parts = documentId.split(":", 2);
    if (parts.length != 2) {
      return null;
    }
    File base = storageRoot(context, parts[0]);
    if (base == null) {
      return null;
    }
    return parts[1].isEmpty() ? base : new File(base, parts[1]);
  }

  static Info resolve(Context context, ContentResolver resolver, Uri tree, String name) {
    String id = DocumentsContract.getTreeDocumentId(tree);
    File directory = location(context, tree.getAuthority(), id);
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
          try (
            Cursor cursor = resolver.query(
              uri,
              new String[] { Document.COLUMN_DISPLAY_NAME },
              null,
              null,
              null
            )
          ) {
            if (cursor == null || !cursor.moveToFirst() || cursor.isNull(0)) {
              return new Info(tree.toString(), null);
            }
            names.add(cursor.getString(0));
          }
        }
        return new Info(
          tree.getAuthority() + ":/" + String.join("/", names),
          names.get(names.size() - 2)
        );
      }
    } catch (Exception ignored) {
      // 第三方提供者未开放上级目录时，展示完整文档地址，不猜测真实文件系统路径。
    }
    return new Info(tree.toString(), null);
  }
}
