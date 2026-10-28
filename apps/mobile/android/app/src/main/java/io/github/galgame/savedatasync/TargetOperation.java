package io.github.galgame.savedatasync;

import java.util.concurrent.atomic.AtomicReference;

/** 旧传输、新复制与恢复共用进程名额；清理完成后才释放，不负责保活或 Activity 状态。 */
final class TargetOperation {
    private static final AtomicReference<Object> OWNER = new AtomicReference<>();
    private TargetOperation() {}
    static boolean acquire(Object owner) { return OWNER.compareAndSet(null, owner); }
    static void release(Object owner) { OWNER.compareAndSet(owner, null); }
    static boolean hasWork() { return OWNER.get() != null; }
}
