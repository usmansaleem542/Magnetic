package app.magnetic.magnetic.core

import java.nio.charset.Charset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SubtitleDecodeTest {
    private val ARABIC = "مرحبا بالعالم، كيف حالك اليوم؟ هذا اختبار للترجمة العربية."
    private val RUSSIAN = "Привет, мир! Это проверка русских субтитров, как они выглядят."
    private fun srt(body: String) = "1\r\n00:00:01,000 --> 00:00:02,500\r\n$body\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n$body\r\n"
    private fun encode(s: String, cs: String) = s.toByteArray(Charset.forName(cs))
    private val noDetector: (ByteArray) -> List<String> = { throw AssertionError("detector should not run") }
    private fun bytes(vararg b: Int) = ByteArray(b.size) { b[it].toByte() }

    @Test
    fun decodesArabicWindows1256WithHint() {
        val b = encode(srt(ARABIC), "windows-1256")
        val (text, encoding) = decodeSubtitle(b, lang = "ar", detector = noDetector)
        assertEquals("windows-1256", encoding)
        assertTrue(text.contains(ARABIC))
    }

    @Test
    fun decodesHandWrittenWindows1256Bytes() {
        // "مرحبا" in Windows-1256, independent of the JVM's encoder
        val b = bytes(0xE3, 0xD1, 0xCD, 0xC8, 0xC7)
        assertEquals(Decoded("مرحبا", "windows-1256"), decodeSubtitle(b, lang = "ar", detector = noDetector))
    }

    @Test
    fun detectsArabicWithoutHint_viaDetectorAndNormalisation() {
        val b = encode(srt(ARABIC).repeat(8), "windows-1256")
        val (text, encoding) = decodeSubtitle(b, detector = { listOf("UTF-8", "ISO-8859-6", "windows-1252") })
        assertEquals("windows-1256", encoding)
        assertTrue(text.contains(ARABIC))
    }

    @Test
    fun detector_skipsUtf8AsciiAndUnsupported_thenFallsBack() {
        val invalidUtf8 = bytes(0xC0, 0x41, 0xFF)
        assertEquals("koi8-r", detectEncoding(invalidUtf8, null) { listOf("ascii", "utf-8", "no-such-charset", "KOI8-R") })
        assertEquals("windows-1252", detectEncoding(invalidUtf8, null) { listOf("UTF-8", "ASCII", "IBM420_rtl_bogus") })
        assertEquals("windows-1252", detectEncoding(invalidUtf8, null) { emptyList() })
        assertEquals("windows-1252", detectEncoding(invalidUtf8, "xx") { emptyList() }) // unknown hint ignored
    }

    @Test
    fun decodesCyrillicWindows1251WithHint() {
        val b = encode(srt(RUSSIAN), "windows-1251")
        assertTrue(decodeSubtitle(b, lang = "ru", detector = noDetector).text.contains(RUSSIAN))
    }

    @Test
    fun honoursBomsAndPlainUtf8() {
        val utf8Bom = bytes(0xEF, 0xBB, 0xBF) + ARABIC.toByteArray(Charsets.UTF_8)
        assertEquals(Decoded(ARABIC, "utf-8"), decodeSubtitle(utf8Bom, detector = noDetector))
        val utf16 = bytes(0xFF, 0xFE) + encode(RUSSIAN, "UTF-16LE")
        assertEquals(Decoded(RUSSIAN, "utf-16le"), decodeSubtitle(utf16, detector = noDetector))
        assertEquals("utf-16be", detectEncoding(bytes(0xFE, 0xFF, 0, 0x41), null, noDetector))
        assertEquals("utf-8", decodeSubtitle(ARABIC.toByteArray(Charsets.UTF_8), detector = noDetector).encoding)
        assertEquals("utf-8", detectEncoding(ByteArray(0), null, noDetector))
    }

    @Test
    fun strictUtf8RejectsOverlongAndSurrogates() {
        assertEquals("windows-1252", detectEncoding(bytes(0xC0, 0xAF), null) { emptyList() })
        assertEquals("windows-1252", detectEncoding(bytes(0xED, 0xA0, 0x80), null) { emptyList() })
    }

    @Test
    fun manualEncodingOverridesDetection() {
        val b = encode(RUSSIAN, "windows-1251")
        assertEquals(RUSSIAN, decodeSubtitle(b, encoding = "windows-1251", detector = noDetector).text)
    }

    @Test
    fun unknownEncodingDecodesAsUtf8() {
        val d = decodeSubtitle("héllo".toByteArray(Charsets.UTF_8), encoding = "klingon-1", detector = noDetector)
        assertEquals(Decoded("héllo", "klingon-1"), d)
    }

    @Test
    fun everyListedEncodingIsSupportedByTheJvm() {
        assertEquals(16, ENCODINGS.size)
        for (e in ENCODINGS) {
            if (e.id == "auto") continue
            assertNotNull("no charset for ${e.id}", charsetFor(e.id))
        }
        for (id in listOf("windows-874", "shift_jis", "euc-kr", "utf-16le", "utf-16be", "iso-8859-6", "gb18030", "big5", "koi8-r")) {
            assertNotNull("no charset for $id", charsetFor(id))
        }
        assertNull(charsetFor("klingon-1"))
        assertEquals("auto", ENCODINGS.first().id)
    }

    @Test
    fun languageHintsPickLegacyCodePages() {
        val invalid = bytes(0xC0, 0x41)
        val expected = mapOf("ar" to "windows-1256", "ru" to "windows-1251", "pl" to "windows-1250", "el" to "windows-1253",
            "tr" to "windows-1254", "he" to "windows-1255", "th" to "windows-874", "zh" to "gb18030", "ja" to "shift_jis", "ko" to "euc-kr")
        for ((lang, enc) in expected) assertEquals(enc, detectEncoding(invalid, lang, noDetector))
    }

    @Test
    fun languageFromName_findsTheLanguageInFileNames() {
        assertEquals("ar", languageFromName("Sintel.ar.srt"))
        assertEquals("en", languageFromName("Movie.2010.1080p.ENG.srt"))
        assertEquals("ar", languageFromName("Subs/Arabic.srt"))
        assertNull(languageFromName("It.2017.srt")) // "It" is the title, not Italian
        assertEquals("it", languageFromName("it.srt")) // a lone code is the language
        assertEquals("pt", languageFromName("Movie [pob].srt"))
        assertEquals("fr", languageFromName("C:\\subs\\Movie_French.srt"))
        assertNull(languageFromName("Movie.2010.srt"))
    }

    @Test
    fun normaliseLang_handlesTagsAndNames() {
        assertEquals("ar", normaliseLang("ara"))
        assertEquals("pt", normaliseLang("pt-BR"))
        assertEquals("ar", normaliseLang("Arabic"))
        assertNull(normaliseLang("Klingon"))
        assertNull(normaliseLang(null))
    }
}
