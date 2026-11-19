// Port of web-app/lib/subtitle-decode.js and languageFromName from web-app/renderer/subtitles.js.
//
// Turn subtitle bytes into text. Many .srt files predate UTF-8: Arabic ones are usually
// Windows-1256, Russian ones Windows-1251, and reading them as UTF-8 shows gibberish.
package app.magnetic.magnetic.core

import java.nio.ByteBuffer
import java.nio.charset.Charset
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

data class Encoding(val id: String, val label: String)

val ENCODINGS: List<Encoding> = listOf(
    Encoding("auto", "Automatic"),
    Encoding("utf-8", "Unicode (UTF-8)"),
    Encoding("utf-16le", "Unicode (UTF-16)"),
    Encoding("windows-1256", "Arabic (Windows-1256)"),
    Encoding("iso-8859-6", "Arabic (ISO-8859-6)"),
    Encoding("windows-1251", "Cyrillic (Windows-1251)"),
    Encoding("windows-1252", "Western (Windows-1252)"),
    Encoding("windows-1250", "Central European (Windows-1250)"),
    Encoding("windows-1253", "Greek (Windows-1253)"),
    Encoding("windows-1254", "Turkish (Windows-1254)"),
    Encoding("windows-1255", "Hebrew (Windows-1255)"),
    Encoding("windows-874", "Thai (Windows-874)"),
    Encoding("gb18030", "Chinese Simplified (GB18030)"),
    Encoding("big5", "Chinese Traditional (Big5)"),
    Encoding("shift_jis", "Japanese (Shift JIS)"),
    Encoding("euc-kr", "Korean (EUC-KR)"),
)

// The legacy encoding most subtitle files in a language were written in.
private val LANGUAGE_ENCODING = mapOf(
    "ar" to "windows-1256", "fa" to "windows-1256", "ur" to "windows-1256",
    "ru" to "windows-1251", "uk" to "windows-1251", "bg" to "windows-1251", "sr" to "windows-1251", "mk" to "windows-1251",
    "pl" to "windows-1250", "cs" to "windows-1250", "sk" to "windows-1250", "hu" to "windows-1250",
    "ro" to "windows-1250", "hr" to "windows-1250", "sl" to "windows-1250",
    "el" to "windows-1253", "tr" to "windows-1254", "he" to "windows-1255", "th" to "windows-874",
    "zh" to "gb18030", "ja" to "shift_jis", "ko" to "euc-kr",
)

// Detectors sometimes name the ISO sibling of the Windows code page subtitle files actually use.
private val NORMALISE = mapOf(
    "iso-8859-1" to "windows-1252",
    "iso-8859-2" to "windows-1250",
    "iso-8859-5" to "windows-1251",
    "iso-8859-7" to "windows-1253",
    "iso-8859-8" to "windows-1255",
    "iso-8859-9" to "windows-1254",
    "iso-8859-6" to "windows-1256",
    "koi8-r" to "koi8-r",
    "utf-16le" to "utf-16le",
    "utf-16be" to "utf-16be",
)

// Java/Android names for iconv ids that differ, tried in order. Anything else goes to Charset.forName,
// which is case-insensitive and resolves aliases.
private val CHARSET_CANDIDATES = mapOf(
    "windows-874" to listOf("windows-874", "x-windows-874", "TIS-620"),
    "shift_jis" to listOf("Shift_JIS"),
    "euc-kr" to listOf("EUC-KR"),
    "utf-16le" to listOf("UTF-16LE"),
    "utf-16be" to listOf("UTF-16BE"),
    "iso-8859-6" to listOf("ISO-8859-6"),
    "gb18030" to listOf("GB18030"),
    "big5" to listOf("Big5"),
)

private fun supported(name: String): Boolean =
    try { Charset.isSupported(name) } catch (e: Exception) { false }

/** The Java charset for an encoding id, or null when this runtime has none (iconv's encodingExists). */
internal fun charsetFor(id: String): Charset? {
    val names = CHARSET_CANDIDATES[id.lowercase()] ?: listOf(id)
    return names.firstOrNull(::supported)?.let(Charset::forName)
}

private fun validUtf8(bytes: ByteArray): Boolean = try {
    Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
    true
} catch (e: CharacterCodingException) {
    false
}

private fun u(b: Byte) = b.toInt() and 0xFF

private fun fromBom(b: ByteArray): String? = when {
    b.size >= 3 && u(b[0]) == 0xEF && u(b[1]) == 0xBB && u(b[2]) == 0xBF -> "utf-8"
    b.size >= 2 && u(b[0]) == 0xFF && u(b[1]) == 0xFE -> "utf-16le"
    b.size >= 2 && u(b[0]) == 0xFE && u(b[1]) == 0xFF -> "utf-16be"
    else -> null
}

// android.icu.text.CharsetDetector exists on devices but is hidden from the public SDK, so it
// can't be compiled against; ICU4J's copy (com.ibm.icu) is used instead if it's ever added.

/**
 * Charset names ICU guesses for [bytes], best first, found by reflection. Empty when no detector
 * can be reached (hidden-API restrictions, unit tests), which leaves detection to the windows-1252 fallback.
 */
fun icuGuesses(bytes: ByteArray): List<String> {
    // android.icu.text.CharsetDetector isn't public API, so use Mozilla's detector (juniversalchardet).
    val d = org.mozilla.universalchardet.UniversalDetector()
    d.handleData(bytes, 0, bytes.size)
    d.dataEnd()
    return listOfNotNull(d.detectedCharset?.lowercase())
}

fun detectEncoding(
    bytes: ByteArray,
    langHint: String?,
    detector: (ByteArray) -> List<String> = ::icuGuesses,
): String {
    fromBom(bytes)?.let { return it }
    if (validUtf8(bytes)) return "utf-8"
    if (!langHint.isNullOrEmpty()) LANGUAGE_ENCODING[langHint]?.let { return it }
    for (g in detector(bytes)) {
        val name = g.lowercase()
        val enc = NORMALISE[name] ?: name
        if (enc != "utf-8" && enc != "ascii" && charsetFor(enc) != null) return enc
    }
    return "windows-1252"
}

data class Decoded(val text: String, val encoding: String)

private fun stripBom(s: String) = s.removePrefix("﻿")

/** Decode subtitle bytes. [encoding] is "auto" or an id from [ENCODINGS]. */
fun decodeSubtitle(
    bytes: ByteArray,
    encoding: String = "auto",
    lang: String? = null,
    detector: (ByteArray) -> List<String> = ::icuGuesses,
): Decoded {
    val used = if (encoding == "auto") detectEncoding(bytes, lang, detector) else encoding
    val charset = charsetFor(used) ?: Charsets.UTF_8
    var text = String(bytes, charset)
    // iconv-lite strips a BOM when decoding UTF-8/16, then the JS strips one more
    if (charset == Charsets.UTF_8 || charset.name().startsWith("UTF-16")) text = stripBom(text)
    return Decoded(stripBom(text), used)
}

// ---------- language from file name (renderer/subtitles.js) ----------

private val LANGS = mapOf(
    "ar" to "Arabic", "en" to "English", "fr" to "French", "de" to "German", "es" to "Spanish", "it" to "Italian",
    "pt" to "Portuguese", "ru" to "Russian", "tr" to "Turkish", "fa" to "Persian", "ur" to "Urdu", "hi" to "Hindi",
    "bn" to "Bengali", "zh" to "Chinese", "ja" to "Japanese", "ko" to "Korean", "nl" to "Dutch", "pl" to "Polish",
    "sv" to "Swedish", "no" to "Norwegian", "da" to "Danish", "fi" to "Finnish", "el" to "Greek", "he" to "Hebrew",
    "id" to "Indonesian", "ms" to "Malay", "th" to "Thai", "vi" to "Vietnamese", "uk" to "Ukrainian", "cs" to "Czech",
    "hu" to "Hungarian", "ro" to "Romanian", "bg" to "Bulgarian", "hr" to "Croatian", "sr" to "Serbian",
    "sk" to "Slovak", "sl" to "Slovenian", "tl" to "Filipino",
)

// three-letter codes (MKV tracks, some file names) and spelled-out names
private val ALIASES: Map<String, String> = mapOf(
    "ara" to "ar", "eng" to "en", "fre" to "fr", "fra" to "fr", "ger" to "de", "deu" to "de", "spa" to "es",
    "ita" to "it", "por" to "pt", "rus" to "ru", "tur" to "tr", "per" to "fa", "fas" to "fa", "urd" to "ur",
    "hin" to "hi", "ben" to "bn", "chi" to "zh", "zho" to "zh", "jpn" to "ja", "kor" to "ko", "dut" to "nl",
    "nld" to "nl", "pol" to "pl", "swe" to "sv", "nor" to "no", "dan" to "da", "fin" to "fi", "gre" to "el",
    "ell" to "el", "heb" to "he", "ind" to "id", "may" to "ms", "msa" to "ms", "tha" to "th", "vie" to "vi",
    "ukr" to "uk", "cze" to "cs", "ces" to "cs", "hun" to "hu", "rum" to "ro", "ron" to "ro", "bul" to "bg",
    "hrv" to "hr", "srp" to "sr", "slo" to "sk", "slk" to "sk", "slv" to "sl", "fil" to "tl", "tgl" to "tl",
    "pob" to "pt", "pt-br" to "pt", "es-419" to "es", "zh-cn" to "zh", "zh-tw" to "zh", "zh-hans" to "zh", "zh-hant" to "zh",
) + LANGS.entries.associate { (code, name) -> name.lowercase() to code }

/** Normalise any language tag ("ara", "Arabic", "pt-BR") to a two-letter code, or null. */
internal fun normaliseLang(tag: String?): String? {
    if (tag.isNullOrEmpty()) return null
    val t = tag.trim().lowercase()
    if (t in LANGS) return t
    ALIASES[t]?.let { return it }
    val base = t.split('-', '_')[0]
    return if (base in LANGS) base else ALIASES[base]
}

private val PATH_SEP = Regex("[\\\\/]")
private val EXTENSION = Regex("\\.[^.]+\\z")
private val NAME_PARTS = Regex("[\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF._\\-\\[\\]()]+")

/** Find the language in a subtitle file name such as "Movie.2010.ar.srt" or "Arabic.srt". */
fun languageFromName(fileName: String): String? {
    val base = fileName.split(PATH_SEP).last().replace(EXTENSION, "").lowercase()
    val parts = base.split(NAME_PARTS).filter { it.isNotEmpty() }
    for (i in parts.indices.reversed()) {
        val p = parts[i]
        if (p in ALIASES || (p in LANGS && (i > 0 || parts.size == 1))) return normaliseLang(p)
    }
    return null
}
