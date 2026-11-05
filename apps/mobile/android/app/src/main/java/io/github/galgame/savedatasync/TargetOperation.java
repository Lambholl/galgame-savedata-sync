package io.github.galgame.savedatasync;

import java.util.concurrent.atomic.AtomicReference;

/** 批量传输、复制任务和恢复共用的进程名额；清理完成后才释放。 */
final class TargetOperation {
    private static final AtomicReference<Object> OWNER = new AtomicReference<>();
    private TargetOperation() {}
    static boolean acquire(Object owner) { return OWNER.compareAndSet(null, owner); }
    static boolean owns(Object owner) { return owner != null && OWNER.get() == owner; }
    static void release(Object owner) { OWNER.compareAndSet(owner, null); }
    static boolean hasWork() { return OWNER.get() != null; }
}
