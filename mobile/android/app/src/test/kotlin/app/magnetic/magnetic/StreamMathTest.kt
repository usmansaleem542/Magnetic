package app.magnetic.magnetic

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StreamMathTest {
    @Test fun noRangeHeaderMeansWholeFile() =
        assertEquals(ByteRange(0, 999, partial = false), parseRange(null, 1000))

    @Test fun openEndedRange() =
        assertEquals(ByteRange(100, 999, partial = true), parseRange("bytes=100-", 1000))

    @Test fun closedRange() =
        assertEquals(ByteRange(100, 199, partial = true), parseRange("bytes=100-199", 1000))

    @Test fun endClampedToFileSize() =
        assertEquals(ByteRange(900, 999, partial = true), parseRange("bytes=900-5000", 1000))

    @Test fun suffixRangeReadsTheTail() =
        assertEquals(ByteRange(800, 999, partial = true), parseRange("bytes=-200", 1000))

    @Test fun startPastEndIsUnsatisfiable() = assertNull(parseRange("bytes=1000-", 1000))

    @Test fun garbageIsUnsatisfiable() = assertNull(parseRange("bytes=abc", 1000))

    @Test fun pieceOfFirstByteInFirstFile() = assertEquals(0, pieceAt(0, 0, 16))

    @Test fun pieceAccountsForFileOffsetInTorrent() =
        // File starts 40 bytes into the torrent; byte 10 of the file is torrent byte 50 → piece 3.
        assertEquals(3, pieceAt(fileOffset = 40, offsetInFile = 10, pieceLength = 16))

    @Test fun piecesHandleFilesBiggerThan2GB() =
        // 5 GiB into the file with 1 MiB pieces → piece 5120.
        assertEquals(5120, pieceAt(0, 5L * 1024 * 1024 * 1024, 1024 * 1024))
}
