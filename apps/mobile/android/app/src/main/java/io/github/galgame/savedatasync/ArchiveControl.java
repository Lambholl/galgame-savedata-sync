package io.github.galgame.savedatasync;

import java.io.Closeable;
import java.io.IOException;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;

/**
 * 单任务取消/期限及资源所有者。I/O 在单一工作线程执行；cancel 可由生命周期线程调用，
 * 会关闭登记的流和 SAF 查询信号以唤醒阻塞读。默认总期限 30 分钟，不能通过进度刷新。
 */
final class ArchiveControl {
    private final Set<Closeable> resources = new HashSet<>();
    private final LongSupplier clock;
    private final long started, timeout;
    private volatile boolean cancelled;

    ArchiveControl() { this(System::nanoTime, TimeUnit.MINUTES.toNanos(30)); }
    ArchiveControl(LongSupplier clock, long timeout) {
        if (timeout <= 0 || timeout > TimeUnit.MINUTES.toNanos(30)) throw new IllegalArgumentException("Invalid timeout");
        this.clock = clock; this.timeout = timeout; started = clock.getAsLong();
    }
    void check() throws ArchiveFailure {
        if (cancelled || Thread.currentThread().isInterrupted()) {
            throw new ArchiveFailure("io-failure", "归档已取消", true, null);
        }
        if (clock.getAsLong() - started >= timeout) throw new ArchiveFailure("timeout", "归档任务已超时");
    }
    synchronized <T extends Closeable> T track(T resource) throws IOException {
        try { check(); } catch (ArchiveFailure failure) { resource.close(); throw failure; }
        resources.add(resource);
        return resource;
    }
    synchronized void untrack(Closeable resource) { resources.remove(resource); }
    void cancel() {
        Closeable[] closing;
        synchronized (this) { cancelled = true; closing = resources.toArray(new Closeable[0]); }
        for (Closeable resource : closing) {
            try { resource.close(); } catch (Exception ignored) {
                // 原始 I/O 异常由工作线程报告；缓存清理由任务所有者单独执行。
            }
        }
    }
}
