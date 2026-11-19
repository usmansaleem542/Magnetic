package app.magnetic.magnetic.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaTest {
    private fun f(name: String, length: Long) = FileInfo(name, name, length)

    @Test
    fun kindOfAndMimeOfClassifyByExtensionCaseInsensitively() {
        assertEquals(FileKind.VIDEO, kindOf("Movie.MKV"))
        assertEquals(FileKind.AUDIO, kindOf("track.flac"))
        assertEquals(FileKind.SUBTITLE, kindOf("Sintel.en.srt"))
        assertEquals(FileKind.IMAGE, kindOf("cover.JPG"))
        assertEquals(FileKind.OTHER, kindOf("readme.txt"))
        assertEquals(FileKind.OTHER, kindOf(".mp4"))
        assertEquals(FileKind.PADDING, kindOf("X/.____padding_file/12"))
        assertEquals("video/mp4", mimeOf("a.mp4"))
        assertEquals("video/x-matroska", mimeOf("a.MKV"))
        assertEquals("application/octet-stream", mimeOf("a.unknown"))
        assertEquals("video", FileKind.VIDEO.wire)
    }

    @Test
    fun isPaddingFile_matchesBep47Paths() {
        assertTrue(isPaddingFile("X/.____padding_file/12"))
        assertTrue(isPaddingFile(".____padding_file\\3"))
        assertFalse(isPaddingFile("X/padding_file.mp4"))
    }

    @Test
    fun pickPosterFile_prefersConventionalNames_thenLargestImage() {
        val files = listOf(f("screens/shot1.jpg", 900_000), f("poster.jpg", 40_000), f("movie.mp4", 5_000_000_000))
        assertEquals(1, pickPosterFile(files))
        assertEquals(0, pickPosterFile(files.filter { it.name != "poster.jpg" }))
        assertNull(pickPosterFile(listOf(f("movie.mp4", 1))))
        assertNull(pickPosterFile(listOf(f("huge.png", 50L * 1024 * 1024))))
    }

    @Test
    fun pickPosterFile_archiveThumbnailWins() {
        val files = listOf(FileInfo("big.gif", "X/big.gif", 300_000), FileInfo("__ia_thumb.jpg", "X/__ia_thumb.jpg", 20_000))
        assertEquals(1, pickPosterFile(files))
    }

    @Test
    fun stripFromBitfield_bucketsPiecesIntoFractions() {
        val have = setOf(0, 1, 2, 3, 8, 9)
        assertEquals(listOf(1.0, 1.0, 0.0, 0.0, 1.0), stripFromBitfield({ it in have }, 0, 9, 5))
    }

    @Test
    fun stripFromBitfield_respectsPieceRange_andNeverExceedsPieceCount() {
        assertEquals(listOf(0.0, 0.0, 1.0, 1.0), stripFromBitfield({ it >= 12 }, 10, 13, 100))
        assertEquals(emptyList<Double>(), stripFromBitfield({ true }, 5, 4, 10))
    }

    @Test
    fun stripFromBitfield_roundsToTwoDecimals() {
        // 1 of 3 pieces -> 0.33; 2 of 3 -> 0.67
        assertEquals(listOf(0.33), stripFromBitfield({ it == 0 }, 0, 2, 1))
        assertEquals(listOf(0.67), stripFromBitfield({ it != 0 }, 0, 2, 1))
    }
}
