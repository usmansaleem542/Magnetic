package app.magnetic.magnetic.core

import org.junit.Assert.assertEquals
import org.junit.Test

class ArchiveDeselectTest {
    private fun f(p: String, mb: Double) = FileInfo(p.substringAfterLast('/'), p, (mb * 1e6).toLong())

    private fun kept(files: List<FileInfo>): List<String> {
        val off = archiveDeselect(files)
        return files.indices.filter { it !in off }.map { files[it].name }
    }

    @Test
    fun onePlayableCopyPerRecording_plusSubtitlesAndThumbnail() {
        val files = listOf(
            f("N/N_meta.xml", 0.0), f("N/.____padding_file/1", 3.0), f("N/__ia_thumb.jpg", 0.02),
            f("N/Night.m2ts", 17000.0), f("N/Night.mp4", 596.0), f("N/Night.ogv", 425.0),
            f("N/Night_1080p.mkv", 11500.0), f("N/Night_1080p.mp4", 597.0), f("N/Night_1080p_512kb.mp4", 407.0),
            f("N/Night_720p.mp4", 598.0), f("N/Night.asr.srt", 0.1),
            f("N/part-2of5.mpg", 999.0), f("N/part-2of5_512kb.mp4", 86.0), f("N/part-2of5.ogv", 85.0),
            f("N/Night_DVD5.mp4", 590.0), f("N/Night_iPod.mp4", 570.0), f("N/Night_DVD5.mp3", 69.0),
        )
        assertEquals(listOf("__ia_thumb.jpg", "Night_720p.mp4", "Night.asr.srt", "part-2of5_512kb.mp4"), kept(files))
    }

    @Test
    fun musicKeepsTheMp3OfEachTrack() {
        val files = listOf(
            f("A/t01.mp3", 11.0), f("A/t01.ogg", 6.0), f("A/t01.flac", 40.0),
            f("A/t01_spectrogram.png", 0.2), f("A/t02_vbr.mp3", 5.0), f("A/t02.flac", 30.0),
        )
        assertEquals(listOf("t01.mp3", "t02_vbr.mp3"), kept(files))
    }

    @Test
    fun emptyPathFallsBackToName() {
        val files = listOf(FileInfo("a.mp4", "", 10), FileInfo("a.ogv", "", 20))
        assertEquals(listOf(1), archiveDeselect(files))
    }
}
