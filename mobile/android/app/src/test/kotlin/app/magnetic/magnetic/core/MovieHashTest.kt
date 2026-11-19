package app.magnetic.magnetic.core

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertEquals
import org.junit.Test

class MovieHashTest {
    @Test
    fun addsSizeAndWordsOfHeadAndTail_wrappingPast2to64() {
        val head = ByteBuffer.allocate(65536).order(ByteOrder.LITTLE_ENDIAN).putLong(0, 5L).array()
        val tail = ByteBuffer.allocate(65536).order(ByteOrder.LITTLE_ENDIAN).putLong(8, -1L).array() // 0xFFFF_FFFF_FFFF_FFFF
        assertEquals((131072L + 5L - 1L).toString(16).padStart(16, '0'), movieHash(131072, head, tail))
    }

    @Test
    fun formatsAsSixteenLowercaseHexDigits() {
        assertEquals("0000000000000000", movieHash(0, ByteArray(0), ByteArray(0)))
        assertEquals("ffffffffffffffff", movieHash(-1L, ByteArray(7), ByteArray(0))) // trailing partial word ignored
        val word = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putLong(0, 0x0123456789ABCDEFL).array()
        assertEquals("0123456789abcdef", movieHash(0, word, ByteArray(0)))
    }
}
