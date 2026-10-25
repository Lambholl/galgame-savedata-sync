package io.github.galgame.savedatasync;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Opt-in LAN experiment, NOT the product HTTP/write adapter. No new dependencies.
 * Requires benchBase (private LAN HTTP URL), benchToken (new fixture), and a human SAF grant.
 * Only flat, known-size regular files in the supplied manifest are accepted. Archives use
 * the bounded USTAR subset created by this experiment. No general archive extraction API.
 * Stages before publishing, checks every file's SHA-256 and reads back actual written content.
 * All buffers are bounded; bytes/URIs never enter a JS bridge. Default test runs skip this test.
 */
@RunWith(AndroidJUnit4.class)
public class TransferBenchmarkTest {
    private ContentResolver resolver;
    private String base;
    private Uri tree;
    private String treeId;
    private File cache;

    @Test public void bidirectionalSafBenchmark() throws Exception {
        Bundle arguments = InstrumentationRegistry.getArguments();
        base = arguments.getString("benchBase");
        assumeTrue(base != null);
        URL endpoint = new URL(base);
        assertTrue("Only private LAN HTTP endpoints are accepted", "http".equals(endpoint.getProtocol()) &&
            InetAddress.getByName(endpoint.getHost()).isSiteLocalAddress() && endpoint.getUserInfo() == null &&
            endpoint.getQuery() == null && endpoint.getRef() == null && endpoint.getPath().matches("/[a-f0-9]{32}/"));
        String token = arguments.getString("benchToken");
        assertTrue("Invalid fixture token", token != null && token.matches("[a-f0-9]{16}"));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        resolver = context.getContentResolver();
        cache = new File(context.getCacheDir(), "transfer-benchmark-" + token);
        assertTrue("Cache must be a new private directory", cache.mkdir());
        Intent intent = new Intent(context, BenchmarkGrantActivity.class).putExtra("token", token);
        // MIUI blocks an instrumentation process from starting an Activity while in the
        // background. Launch the already exported app entry as shell, then open the private
        // chooser from the foreground. This changes no system permission or exported surface.
        try (ParcelFileDescriptor descriptor = InstrumentationRegistry.getInstrumentation().getUiAutomation()
                .executeShellCommand("am start -W -n io.github.galgame.savedatasync/.MainActivity");
             InputStream launched = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
            byte[] buffer = new byte[1024];
            while (launched.read(buffer) != -1) { /* Wait until ActivityManager completes launch. */ }
        }
        try (ActivityScenario<BenchmarkGrantActivity> scenario = ActivityScenario.launch(intent)) {
            long deadline = System.nanoTime() + 240000000000L;
            while (System.nanoTime() < deadline) {
                if (context.getSharedPreferences(BenchmarkGrantActivity.SETTINGS, Context.MODE_PRIVATE).getBoolean("failed", false)) {
                    fail("Only the newly created benchmark directory may be authorized");
                }
                String selected = context.getSharedPreferences(BenchmarkGrantActivity.SETTINGS, Context.MODE_PRIVATE).getString("uri", null);
                if (selected != null && BenchmarkGrantActivity.foreground) { tree = Uri.parse(selected); break; }
                Thread.sleep(100);
            }
            assertNotNull("Complete the system picker for the exact benchmark fixture", tree);
            treeId = DocumentsContract.getTreeDocumentId(tree);
            assertEquals("primary:Download/SaveDataSync-NetBench-" + token, treeId);
            JSONObject setup = jsonRequest("setup", null);
            JSONArray samples = setup.getJSONArray("datasets");
            int rounds = setup.getInt("rounds");
            assertTrue(rounds >= 1 && rounds <= 5);
            int completed = 0;
            for (int sampleIndex = 0; sampleIndex < samples.length(); sampleIndex++) {
                JSONObject sample = samples.getJSONObject(sampleIndex);
                List<Entry> entries = entries(sample.getJSONArray("files"));
                Uri input = children(document(treeId)).get(sample.getString("directory"));
                assertNotNull("Prepared benchmark input directory missing", input);
                Map<String, Uri> sources = children(input);
                assertEquals("Input contains unexpected files", entries.size(), sources.size());
                for (Entry entry : entries) {
                    entry.uri = sources.get(entry.name);
                    assertNotNull("Prepared source entry missing", entry.uri);
                }
                for (int round = 0; round < rounds; round++) {
                    List<String> cases = new ArrayList<>();
                    for (String direction : new String[] { "down", "up" }) {
                        for (String method : new String[] { "files", "tar", "gzip1" }) cases.add(direction + ":" + method);
                    }
                    Collections.shuffle(cases, new Random(20261026L + sampleIndex * 100L + round));
                    for (String item : cases) {
                        ensureForeground();
                        String[] parts = item.split(":");
                        JSONObject request = new JSONObject();
                        request.put("sample", sample.getString("sample"));
                        request.put("direction", parts[0]);
                        request.put("method", parts[1]);
                        request.put("round", round);
                        JSONObject work = jsonRequest("new", request);
                        JSONObject result = runCase(work, entries, parts[0], parts[1]);
                        result.put("id", work.getString("id"));
                        jsonRequest("result", result);
                        completed++;
                        Bundle report = new Bundle();
                        report.putString("stream", "LAN SAF benchmark: sample=" + sampleIndex + ", " + item +
                            ", round=" + round + ", totalMs=" + result.getDouble("totalMs"));
                        InstrumentationRegistry.getInstrumentation().sendStatus(0, report);
                    }
                }
            }
            JSONObject done = new JSONObject();
            done.put("completed", completed);
            jsonRequest("finished", done);
        } finally {
            if (tree != null) resolver.releasePersistableUriPermission(tree, BenchmarkGrantActivity.RIGHTS);
            context.deleteSharedPreferences(BenchmarkGrantActivity.SETTINGS);
            File[] leftovers = cache.listFiles();
            if (leftovers != null) for (File file : leftovers) assertTrue("Private cache cleanup failed", file.delete());
            assertTrue("Private benchmark cache cleanup failed", cache.delete());
        }
    }

    private JSONObject runCase(JSONObject work, List<Entry> entries, String direction, String method) throws Exception {
        String id = work.getString("id");
        assertTrue(id.matches("[a-f0-9]{12}"));
        String route = "trial/" + id + "/";
        File archive = new File(cache, id + ".tar");
        Uri outputDirectory = null;
        long started = System.nanoTime();
        double packMs = 0;
        double transferMs;
        long wireBytes = 0;
        try {
            if ("down".equals(direction)) {
                packMs = work.getDouble("packMs");
                outputDirectory = create(document(treeId), "trial-" + id, true);
                if ("files".equals(method)) {
                    for (int index = 0; index < entries.size(); index++) {
                        Entry entry = entries.get(index);
                        download(route + "file/" + index, archive, entry.size, entry.hash);
                        try (InputStream in = new FileInputStream(archive)) { publish(outputDirectory, entry, in); }
                        assertTrue(archive.delete());
                        wireBytes += entry.size;
                    }
                } else {
                    wireBytes = work.getLong("wireBytes");
                    download(route + "archive", archive, wireBytes, work.getString("archiveHash"));
                    try (InputStream raw = new BufferedInputStream(new FileInputStream(archive));
                         InputStream in = "gzip1".equals(method) ? new GZIPInputStream(raw, 65536) : raw) {
                        unpack(in, outputDirectory, entries);
                    }
                }
                transferMs = elapsed(started);
            } else {
                String archiveHash = null;
                if (!"files".equals(method)) {
                    MessageDigest digest = MessageDigest.getInstance("SHA-256");
                    try (OutputStream raw = new BufferedOutputStream(new FileOutputStream(archive));
                         DigestOutputStream checked = new DigestOutputStream(raw, digest);
                         OutputStream out = "gzip1".equals(method) ? new FastGzip(checked) : checked) {
                        pack(out, entries);
                    }
                    archiveHash = hex(digest.digest());
                    packMs = elapsed(started);
                    wireBytes = archive.length();
                }
                long transferring = System.nanoTime();
                if ("files".equals(method)) {
                    for (int index = 0; index < entries.size(); index++) {
                        Entry entry = entries.get(index);
                        try (InputStream in = resolver.openInputStream(entry.uri)) {
                            upload(route + "file/" + index, in, entry.size, entry.hash);
                        }
                        wireBytes += entry.size;
                    }
                } else {
                    try (InputStream in = new BufferedInputStream(new FileInputStream(archive))) {
                        upload(route + "archive", in, wireBytes, archiveHash);
                    }
                }
                transferMs = elapsed(transferring);
            }
            JSONObject result = new JSONObject();
            result.put("packMs", packMs);
            result.put("transferAndReceiveMs", transferMs);
            result.put("totalMs", packMs + transferMs);
            result.put("wireBytes", wireBytes);
            result.put("filesVerified", entries.size());
            return result;
        } finally {
            if (archive.exists()) assertTrue("Temporary archive cleanup failed", archive.delete());
            if (outputDirectory != null) {
                assertEquals(treeId + "/trial-" + id, DocumentsContract.getDocumentId(outputDirectory));
                assertTrue("Only the newly created output directory is deleted", DocumentsContract.deleteDocument(resolver, outputDirectory));
            }
        }
    }

    private void publish(Uri parent, Entry entry, InputStream in) throws Exception {
        ensureForeground();
        Uri uri = create(parent, entry.name, false);
        try (OutputStream out = resolver.openOutputStream(uri, "w")) { checkedCopy(in, out, entry.size, entry.hash); }
        try (InputStream actual = resolver.openInputStream(uri)) {
            checkedCopy(actual, null, entry.size, entry.hash);
            assertEquals("Written file has extra bytes", -1, actual.read());
        }
    }

    private Uri create(Uri parent, String name, boolean directory) throws Exception {
        ensureForeground();
        Uri uri = DocumentsContract.createDocument(resolver, parent,
            directory ? Document.MIME_TYPE_DIR : "application/octet-stream", name);
        assertNotNull("Provider did not create a new document", uri);
        assertTrue(DocumentsContract.getDocumentId(uri).startsWith(treeId + "/trial-"));
        try (Cursor cursor = resolver.query(uri, new String[] { Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            assertNotNull(cursor);
            assertTrue(cursor.moveToFirst());
            assertTrue("Provider renamed the new entry", name.equals(cursor.getString(0)));
        }
        return uri;
    }

    private Map<String, Uri> children(Uri parent) throws Exception {
        Map<String, Uri> result = new HashMap<>();
        Uri uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(parent));
        try (Cursor cursor = resolver.query(uri, new String[] { Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            assertNotNull(cursor);
            while (cursor.moveToNext()) assertNull("Duplicate provider name", result.put(cursor.getString(1), document(cursor.getString(0))));
        }
        return result;
    }

    private Uri document(String id) { return DocumentsContract.buildDocumentUriUsingTree(tree, id); }

    private void download(String route, File file, long size, String hash) throws Exception {
        HttpURLConnection connection = open(route);
        assertEquals("HTTP download failed", 200, connection.getResponseCode());
        try (InputStream in = connection.getInputStream(); OutputStream out = new BufferedOutputStream(new FileOutputStream(file))) {
            checkedCopy(in, out, size, hash);
            assertEquals("Download has extra bytes", -1, in.read());
        }
        // Closing the fully consumed body returns the connection to Android's keep-alive pool.
    }

    private void upload(String route, InputStream in, long size, String hash) throws Exception {
        HttpURLConnection connection = open(route);
        connection.setRequestMethod("PUT");
        connection.setDoOutput(true);
        connection.setFixedLengthStreamingMode(size);
        connection.setRequestProperty("X-Bench-Sha256", hash);
        try (OutputStream out = connection.getOutputStream()) {
            checkedCopy(in, out, size, hash);
            assertEquals("Upload source has extra bytes", -1, in.read());
        }
        assertEquals("HTTP receiver validation failed", 200, connection.getResponseCode());
        try (InputStream response = connection.getInputStream()) { while (response.read() != -1) ensureForeground(); }
    }

    private HttpURLConnection open(String route) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(base + route).openConnection(java.net.Proxy.NO_PROXY);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(60000);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept-Encoding", "identity");
        return connection;
    }

    private JSONObject jsonRequest(String route, JSONObject body) throws Exception {
        HttpURLConnection connection = open(route);
        if (body != null) {
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(bytes.length);
            connection.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
        }
        assertEquals("Benchmark controller failed", 200, connection.getResponseCode());
        try (InputStream in = connection.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = in.read(buffer)) != -1) {
                if (bytes.size() + count > 2097152) throw new IllegalStateException("Oversized control response");
                bytes.write(buffer, 0, count);
            }
            return new JSONObject(bytes.toString("UTF-8"));
        }
    }

    private void checkedCopy(InputStream in, OutputStream out, long size, String hash) throws Exception {
        assertNotNull("Provider returned no stream", in);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[65536];
        long count = 0;
        int read;
        while (count < size && (read = in.read(buffer, 0, (int) Math.min(buffer.length, size - count))) != -1) {
            ensureForeground();
            if (out != null) out.write(buffer, 0, read);
            digest.update(buffer, 0, read);
            count += read;
        }
        assertEquals("Unexpected content length", size, count);
        assertTrue("File checksum mismatch", hash.equals(hex(digest.digest())));
    }

    private void unpack(InputStream in, Uri target, List<Entry> entries) throws Exception {
        Map<String, Entry> expected = new LinkedHashMap<>();
        for (Entry entry : entries) expected.put(entry.name, entry);
        Set<String> seen = new HashSet<>();
        byte[] header = new byte[512];
        while (true) {
            exactRead(in, header);
            boolean zero = true;
            for (byte value : header) if (value != 0) zero = false;
            if (zero) break;
            int sum = 0;
            for (int index = 0; index < header.length; index++) sum += index >= 148 && index < 156 ? 32 : header[index] & 255;
            assertEquals("Tar header checksum mismatch", octal(header, 148, 8), sum);
            int length = 0;
            while (length < 100 && header[length] != 0) length++;
            String name = new String(header, 0, length, StandardCharsets.UTF_8);
            assertTrue("Only known regular files are accepted", header[156] == 0 || header[156] == '0');
            Entry entry = expected.get(name);
            assertNotNull("Unknown tar member", entry);
            assertTrue("Duplicate tar member", seen.add(name));
            assertEquals("Tar length mismatch", entry.size, octal(header, 124, 12));
            publish(target, entry, in);
            discard(in, (512 - entry.size % 512) % 512);
        }
        byte[] remaining = new byte[65536];
        while (in.read(remaining) != -1) ensureForeground();
        assertEquals("Missing tar members", expected.size(), seen.size());
    }

    private void pack(OutputStream out, List<Entry> entries) throws Exception {
        long written = 0;
        for (Entry entry : entries) {
            byte[] name = entry.name.getBytes(StandardCharsets.UTF_8);
            assertTrue("Experiment USTAR names must fit the header", name.length < 100);
            byte[] header = new byte[512];
            System.arraycopy(name, 0, header, 0, name.length);
            number(header, 100, 8, 0600);
            number(header, 108, 8, 0);
            number(header, 116, 8, 0);
            number(header, 124, 12, entry.size);
            number(header, 136, 12, 0);
            for (int index = 148; index < 156; index++) header[index] = 32;
            header[156] = '0';
            System.arraycopy(new byte[] { 'u','s','t','a','r',0,'0','0' }, 0, header, 257, 8);
            int sum = 0;
            for (byte value : header) sum += value & 255;
            number(header, 148, 8, sum);
            out.write(header);
            try (InputStream in = resolver.openInputStream(entry.uri)) {
                checkedCopy(in, out, entry.size, entry.hash);
                assertEquals("Tar source has extra bytes", -1, in.read());
            }
            int padding = (int) ((512 - entry.size % 512) % 512);
            out.write(new byte[padding]);
            written += 512 + entry.size + padding;
        }
        out.write(new byte[1024]);
        written += 1024;
        out.write(new byte[(int) ((10240 - written % 10240) % 10240)]);
    }

    private static List<Entry> entries(JSONArray array) throws Exception {
        assertTrue(array.length() > 0 && array.length() <= 2000);
        List<Entry> result = new ArrayList<>();
        Set<String> names = new HashSet<>();
        for (int index = 0; index < array.length(); index++) {
            JSONObject value = array.getJSONObject(index);
            String name = value.getString("name");
            long size = value.getLong("size");
            String hash = value.getString("sha256");
            assertTrue("Only flat fixture names are allowed", !name.isEmpty() && !name.equals(".") && !name.equals("..") &&
                name.length() <= 255 && !name.contains("/") && !name.contains("\\") && names.add(name));
            assertTrue(size >= 0 && size <= 1073741824L && hash.matches("[a-f0-9]{64}"));
            result.add(new Entry(name, size, hash));
        }
        return result;
    }

    private static void exactRead(InputStream in, byte[] bytes) throws Exception {
        int offset = 0;
        while (offset < bytes.length) {
            int read = in.read(bytes, offset, bytes.length - offset);
            if (read == -1) throw new IllegalStateException("Truncated tar header");
            offset += read;
        }
    }

    private static void discard(InputStream in, long length) throws Exception {
        for (long index = 0; index < length; index++) if (in.read() == -1) throw new IllegalStateException("Truncated padding");
    }

    private static long octal(byte[] data, int offset, int length) {
        return Long.parseLong(new String(data, offset, length, StandardCharsets.US_ASCII).trim(), 8);
    }

    private static void number(byte[] data, int offset, int length, long value) {
        byte[] bytes = String.format(Locale.ROOT, "%0" + (length - 1) + "o", value).getBytes(StandardCharsets.US_ASCII);
        assertTrue(bytes.length < length);
        System.arraycopy(bytes, 0, data, offset, bytes.length);
    }

    private static String hex(byte[] value) {
        StringBuilder result = new StringBuilder();
        for (byte item : value) result.append(String.format(Locale.ROOT, "%02x", item & 255));
        return result.toString();
    }

    private static double elapsed(long started) { return (System.nanoTime() - started) / 1000000.0; }
    private static void ensureForeground() { assertTrue("Benchmark stopped after leaving foreground", BenchmarkGrantActivity.foreground); }

    private static final class FastGzip extends GZIPOutputStream {
        FastGzip(OutputStream out) throws Exception { super(out, 65536); def.setLevel(1); }
    }

    private static final class Entry {
        final String name;
        final long size;
        final String hash;
        Uri uri;
        Entry(String name, long size, String hash) { this.name = name; this.size = size; this.hash = hash; }
    }
}
