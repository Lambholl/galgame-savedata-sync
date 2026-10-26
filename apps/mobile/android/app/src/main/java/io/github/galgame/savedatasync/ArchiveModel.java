package io.github.galgame.savedatasync;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/** v1 归档的进程内不可变模型；不是 JSON 解码器，不跨 JS 桥。 */
final class ArchiveModel {
    static final int BUFFER = 65536;
    private ArchiveModel() {}

    /** 测试和受信任原生调用者只能收紧固定预算，不能放宽协议。单位均为字节。 */
    static final class Limits {
        final int files;
        final long file, total, tar, archive, cache;
        Limits() { this(1024, 268435456L, 1073741824L, 1074790400L, 1140850688L, 3221225472L); }
        Limits(int files, long file, long total, long tar, long archive, long cache) {
            if (files < 1 || files > 1024 || file < 1 || file > 268435456L || total < 1 ||
                total > 1073741824L || tar < 1 || tar > 1074790400L || archive < 1 ||
                archive > 1140850688L || cache < 1 || cache > 3221225472L) {
                throw new IllegalArgumentException("Invalid archive limits");
            }
            this.files = files; this.file = file; this.total = total;
            this.tar = tar; this.archive = archive; this.cache = cache;
        }
    }

    /** 源身份和可观察属性；未知长度/时间为 null，identity 只在原生层比较。 */
    static final class Observation {
        final String identity, entryId, parentId, name;
        final Long size, modified;
        Observation(String identity, String entryId, String parentId, String name, Long size, Long modified) {
            this.identity = identity; this.entryId = entryId; this.parentId = parentId;
            this.name = name; this.size = size; this.modified = modified;
        }
        boolean same(Observation other) {
            return other != null && Objects.equals(identity, other.identity) && Objects.equals(entryId, other.entryId) &&
                Objects.equals(parentId, other.parentId) && Objects.equals(name, other.name) &&
                Objects.equals(size, other.size) && Objects.equals(modified, other.modified);
        }
        void validate() throws ArchiveFailure {
            require(identity != null && !identity.isEmpty() && SafValues.isId(entryId) &&
                (parentId == null || (SafValues.isId(parentId) && !parentId.equals(entryId))) && text(name) &&
                (size == null || (size >= 0 && size <= 9007199254740991L)) &&
                (modified == null || (modified >= -8640000000000000L && modified <= 8640000000000000L)));
        }
    }

    /** 只读源接口；每次打开的流交给归档所有者关闭，observe 必须重新检查授权/身份。 */
    interface Source {
        /** 正式 SAF 源必须核对批次源根；纯 IO 合成源可沿用默认实现。 */
        default void validateRoot(String rootId) throws ArchiveFailure {}
        Observation observe(ArchiveControl control) throws Exception;
        InputStream open(ArchiveControl control) throws Exception;
    }

    static final class PreparedFile {
        final String fileId, sourceEntryId, sourceParentId, sourceName, sha256;
        final Long sourceModifiedAt;
        final long sizeBytes;
        PreparedFile(String fileId, Observation source, long sizeBytes, String sha256) {
            this.fileId = fileId; sourceEntryId = source.entryId; sourceParentId = source.parentId;
            sourceName = source.name; sourceModifiedAt = source.modified;
            this.sizeBytes = sizeBytes; this.sha256 = sha256;
        }
    }

    static final class Descriptor {
        final long sizeBytes, tarSizeBytes;
        final String sha256;
        Descriptor(long sizeBytes, long tarSizeBytes, String sha256) {
            this.sizeBytes = sizeBytes; this.tarSizeBytes = tarSizeBytes; this.sha256 = sha256;
        }
    }

    /** 对应固定 protocolVersion=1、format=tar.gz、compressionLevel=1 的原生清单。 */
    static final class Manifest {
        final String transferId, sourceDeviceId, sourceRootId;
        final List<PreparedFile> files;
        final long totalFileBytes;
        final Descriptor archive;
        Manifest(String transferId, String deviceId, String rootId, List<PreparedFile> files,
                 long total, Descriptor archive) {
            this.transferId = transferId; sourceDeviceId = deviceId; sourceRootId = rootId;
            this.files = Collections.unmodifiableList(new ArrayList<>(files));
            totalFileBytes = total; this.archive = archive;
        }
        void validate(Limits limits) throws ArchiveFailure {
            require(SafValues.isId(transferId) && SafValues.isId(sourceDeviceId) && SafValues.isId(sourceRootId));
            require(!files.isEmpty() && archive != null);
            limit(files.size() <= limits.files);
            long total = 0, tar = 1024;
            Set<String> entries = new HashSet<>();
            for (int i = 0; i < files.size(); i++) {
                PreparedFile f = files.get(i);
                require(f != null && id(i).equals(f.fileId) && SafValues.isId(f.sourceEntryId) &&
                    entries.add(f.sourceEntryId) && (f.sourceParentId == null ||
                        (SafValues.isId(f.sourceParentId) && !f.sourceParentId.equals(f.sourceEntryId))) &&
                    text(f.sourceName) && hash(f.sha256) && f.sizeBytes >= 0 &&
                    (f.sourceModifiedAt == null || (f.sourceModifiedAt >= -8640000000000000L &&
                        f.sourceModifiedAt <= 8640000000000000L)));
                limit(f.sizeBytes <= limits.file);
                total += f.sizeBytes; tar += 512 + padded(f.sizeBytes);
            }
            limit(total <= limits.total && tar <= limits.tar && archive.sizeBytes <= limits.archive);
            require(total == totalFileBytes && tar == archive.tarSizeBytes && archive.sizeBytes > 0 && hash(archive.sha256));
        }
    }

    /** 阶段内实际计数；未知 total 用 null。回调在同一 I/O 线程执行，不能阻塞或修改任务。 */
    interface Progress { void update(String stage, long completed, Long total) throws Exception; }

    static String id(int index) { return String.format(java.util.Locale.ROOT, "f%06d", index + 1); }
    static long padded(long size) { return ((size + 511) / 512) * 512; }
    static boolean hash(String value) { return value != null && value.matches("[a-f0-9]{64}"); }
    static boolean text(String value) {
        if (value == null || value.isEmpty() || value.length() > 1024 || value.codePoints().allMatch(
            c -> Character.isWhitespace(c) || Character.isSpaceChar(c))) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (++i == value.length() || !Character.isLowSurrogate(value.charAt(i))) return false;
            } else if (Character.isLowSurrogate(c)) return false;
        }
        return true;
    }
    static void require(boolean condition) throws ArchiveFailure {
        if (!condition) throw new ArchiveFailure("invalid-request", "归档请求或清单字段不合法");
    }
    static void limit(boolean condition) throws ArchiveFailure {
        if (!condition) throw new ArchiveFailure("resource-limit", "归档超过本次资源预算");
    }
}
