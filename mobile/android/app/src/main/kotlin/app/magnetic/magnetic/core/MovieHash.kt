// Port of movieHash from web-app/lib/opensubtitles.js.
package app.magnetic.magnetic.core

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The OpenSubtitles "moviehash": file size plus the 64-bit little-endian word sums
 * of the first and last 64 KiB, modulo 2^64, as 16 lowercase hex digits.
 */
fun movieHash(size: Long, head: ByteArray, tail: ByteArray): String {
    var h = size
    for (buf in arrayOf(head, tail)) {
        val bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN)
        var i = 0
        while (i + 8 <= buf.size) {
            h += bb.getLong(i) // Long addition wraps modulo 2^64
            i += 8
        }
    }
    return java.lang.Long.toUnsignedString(h, 16).padStart(16, '0')
}
