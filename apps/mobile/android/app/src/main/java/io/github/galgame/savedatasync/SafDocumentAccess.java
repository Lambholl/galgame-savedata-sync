package io.github.galgame.savedatasync;

import android.content.ContentResolver;
import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import java.io.FileNotFoundException;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/** 经 ContentResolver 和文档提供者访问已授权的目录树。 */
final class SafDocumentAccess implements DocumentAccess {

  private static final String[] PROJECTION = {
    Document.COLUMN_DOCUMENT_ID,
    Document.COLUMN_DISPLAY_NAME,
    Document.COLUMN_MIME_TYPE,
    Document.COLUMN_SIZE,
    Document.COLUMN_LAST_MODIFIED,
    Document.COLUMN_FLAGS,
  };
  private final ContentResolver resolver;

  SafDocumentAccess(Context context) {
    resolver = context.getApplicationContext().getContentResolver();
  }

  private static Uri document(Uri tree, String documentId) {
    return DocumentsContract.buildDocumentUriUsingTree(tree, documentId);
  }

  @Override
  public DirectoryStore.Snapshot query(Uri tree, String documentId, CancellationSignal signal)
    throws Exception {
    try (
      Cursor cursor = resolver.query(
        document(tree, documentId),
        PROJECTION,
        null,
        null,
        null,
        signal
      )
    ) {
      // DocumentsProvider 查询不存在的文档时返回 null 而不是抛异常，例如目录被改名后。
      if (cursor == null || !cursor.moveToFirst()) {
        throw new FileNotFoundException("Document missing");
      }
      DirectoryStore.Snapshot snapshot = DirectoryStore.decode(cursor);
      if (!documentId.equals(snapshot.documentId)) {
        throw new IOException("Provider ID mismatch");
      }
      return snapshot;
    }
  }

  @Override
  public List<DirectoryStore.Snapshot> children(
    Uri tree,
    String documentId,
    CancellationSignal signal
  ) throws Exception {
    List<DirectoryStore.Snapshot> result = new ArrayList<>();
    try (
      Cursor cursor = resolver.query(
        DocumentsContract.buildChildDocumentsUriUsingTree(tree, documentId),
        PROJECTION,
        null,
        null,
        null,
        signal
      )
    ) {
      if (cursor == null) {
        throw new FileNotFoundException("Provider returned no cursor");
      }
      while (cursor.moveToNext()) {
        signal.throwIfCanceled();
        result.add(DirectoryStore.decode(cursor));
      }
    }
    return result;
  }

  @Override
  public InputStream read(Uri tree, String documentId, CancellationSignal signal) throws Exception {
    // 用 AssetFileDescriptor 打开：有些提供者返回的描述符带起始偏移，openFileDescriptor 会拒绝。
    AssetFileDescriptor descriptor = resolver.openAssetFileDescriptor(
      document(tree, documentId),
      "r",
      signal
    );
    if (descriptor == null) {
      throw new IOException("Provider returned no descriptor");
    }
    try {
      return new FilterInputStream(descriptor.createInputStream()) {
        @Override
        public void close() throws IOException {
          try {
            super.close();
          } finally {
            descriptor.close();
          }
        }
      };
    } catch (Exception cause) {
      descriptor.close();
      throw cause;
    }
  }

  @Override
  public ParcelFileDescriptor open(
    Uri tree,
    String documentId,
    String mode,
    CancellationSignal signal
  ) throws Exception {
    if (!"r".equals(mode) && !"rw".equals(mode)) {
      throw new IllegalArgumentException("Unsupported open mode");
    }
    ParcelFileDescriptor descriptor = resolver.openFileDescriptor(
      document(tree, documentId),
      mode,
      signal
    );
    if (descriptor == null) {
      throw new IOException("Missing provider descriptor");
    }
    return descriptor;
  }

  @Override
  public String create(Uri tree, String parentDocumentId, String mimeType, String name)
    throws Exception {
    Uri created = DocumentsContract.createDocument(
      resolver,
      document(tree, parentDocumentId),
      mimeType,
      name
    );
    if (
      created == null ||
      !"content".equals(created.getScheme()) ||
      !tree.getAuthority().equals(created.getAuthority()) ||
      !DocumentsContract.isTreeUri(created) ||
      !DocumentsContract.getTreeDocumentId(tree).equals(
        DocumentsContract.getTreeDocumentId(created)
      )
    ) {
      throw new ArchiveFailure(
        "result-unknown",
        "The provider returned an unknown creation reference."
      );
    }
    return DocumentsContract.getDocumentId(created);
  }

  @Override
  public boolean delete(Uri tree, String documentId) throws Exception {
    return DocumentsContract.deleteDocument(resolver, document(tree, documentId));
  }

  /** 通过提供者根和子文档关系查询可用容量；未知时返回 null。 */
  @Override
  public Long availableBytes(Uri tree, String documentId, CancellationSignal signal)
    throws Exception {
    Uri target = document(tree, documentId);
    try (
      Cursor cursor = resolver.query(
        DocumentsContract.buildRootsUri(tree.getAuthority()),
        new String[] {
          DocumentsContract.Root.COLUMN_DOCUMENT_ID,
          DocumentsContract.Root.COLUMN_AVAILABLE_BYTES,
        },
        null,
        null,
        null,
        signal
      )
    ) {
      while (cursor != null && cursor.moveToNext()) {
        signal.throwIfCanceled();
        if (cursor.isNull(0) || cursor.isNull(1) || cursor.getLong(1) < 0) {
          continue;
        }
        String rootId = cursor.getString(0);
        Uri root = DocumentsContract.buildDocumentUri(tree.getAuthority(), rootId);
        if (
          rootId.equals(documentId) || DocumentsContract.isChildDocument(resolver, root, target)
        ) {
          return cursor.getLong(1);
        }
      }
      return null;
    } catch (
      SecurityException
      | UnsupportedOperationException
      | IllegalArgumentException
      | FileNotFoundException cause
    ) {
      // 有些提供者只开放树授权，或没有容量和子文档查询；此时依靠写入时的描述符检查。
      return null;
    }
  }
}
