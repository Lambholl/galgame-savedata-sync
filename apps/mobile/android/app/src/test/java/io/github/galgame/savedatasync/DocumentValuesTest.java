package io.github.galgame.savedatasync;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** 校验 DocumentValues 对 ID、文件大小和文档提供者日期的解析。 */
public class DocumentValuesTest {

  @Test
  public void idsNeverAcceptPathsUrisOrCoercion() {
    assertTrue(DocumentValues.isId("root-01_ab"));
    assertTrue(DocumentValues.isId("a".repeat(128)));
    for (Object value : new Object[] {
      null,
      1,
      "",
      "/storage/a",
      "../a",
      "content://provider/a",
      "a".repeat(129),
    }) {
      assertFalse(DocumentValues.isId(value));
    }
  }

  @Test
  public void unknownIsDifferentFromAnEmptyFile() {
    assertNull(DocumentValues.size(null));
    assertNull(DocumentValues.size(-1L));
    assertEquals(Long.valueOf(0), DocumentValues.size(0L));
    assertEquals(Long.valueOf(9007199254740991L), DocumentValues.size(9007199254740991L));
    assertThrows(IllegalArgumentException.class, () -> DocumentValues.size(9007199254740992L));
  }

  @Test
  public void providerUnknownDatesAndUnsafeValuesAreHandled() {
    assertNull(DocumentValues.modified(0L));
    assertNull(DocumentValues.modified(null));
    assertEquals(Long.valueOf(-1), DocumentValues.modified(-1L));
    assertThrows(IllegalArgumentException.class, () -> DocumentValues.modified(Long.MAX_VALUE));
  }

  @Test
  public void displayNamesPreserveUnicodeAndRejectInvalidValues() {
    assertEquals("中文 存档.dat", DocumentValues.text("中文 存档.dat"));
    assertThrows(IllegalArgumentException.class, () -> DocumentValues.text("\u00a0\u3000"));
    assertThrows(IllegalArgumentException.class, () -> DocumentValues.text("a".repeat(1025)));
  }
}
