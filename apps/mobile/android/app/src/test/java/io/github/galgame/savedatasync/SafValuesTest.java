package io.github.galgame.savedatasync;

import static org.junit.Assert.*;
import org.junit.Test;

public class SafValuesTest {
    @Test public void idsNeverAcceptPathsUrisOrCoercion() {
        assertTrue(SafValues.isId("root-01_ab"));
        assertTrue(SafValues.isId("a".repeat(128)));
        for (Object value : new Object[] { null, 1, "", "/storage/a", "../a", "content://provider/a", "a".repeat(129) }) {
            assertFalse(SafValues.isId(value));
        }
    }

    @Test public void unknownIsDifferentFromAnEmptyFile() {
        assertNull(SafValues.size(null));
        assertNull(SafValues.size(-1L));
        assertEquals(Long.valueOf(0), SafValues.size(0L));
        assertEquals(Long.valueOf(9007199254740991L), SafValues.size(9007199254740991L));
        assertThrows(IllegalArgumentException.class, () -> SafValues.size(9007199254740992L));
    }

    @Test public void providerUnknownDatesAndUnsafeValuesAreHandled() {
        assertNull(SafValues.modified(0L));
        assertNull(SafValues.modified(null));
        assertEquals(Long.valueOf(-1), SafValues.modified(-1L));
        assertThrows(IllegalArgumentException.class, () -> SafValues.modified(Long.MAX_VALUE));
    }

    @Test public void displayNamesPreserveUnicodeAndRejectInvalidValues() {
        assertEquals("中文 存档.dat", SafValues.text("中文 存档.dat"));
        assertThrows(IllegalArgumentException.class, () -> SafValues.text("\u00a0\u3000"));
        assertThrows(IllegalArgumentException.class, () -> SafValues.text("a".repeat(1025)));
    }
}
