// Port of the pure helpers in web-app/lib/media.js.
package app.magnetic.magnetic.core

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

enum class FileKind(val wire: String) {
    VIDEO("video"), AUDIO("audio"), SUBTITLE("subtitle"), IMAGE("image"), PADDING("padding"), OTHER("other")
}

private val EXT: Map<FileKind, List<String>> = linkedMapOf(
    FileKind.VIDEO to listOf(".mp4", ".m4v", ".webm", ".mkv", ".mov", ".ogv", ".avi", ".wmv", ".flv", ".ts"),
    FileKind.AUDIO to listOf(".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".wav"),
    FileKind.SUBTITLE to listOf(".srt", ".vtt"),
    FileKind.IMAGE to listOf(".jpg", ".jpeg", ".png", ".webp", ".gif"),
)

private val MIME: Map<String, String> = mapOf(
    ".mp4" to "video/mp4", ".m4v" to "video/mp4", ".mov" to "video/mp4", ".webm" to "video/webm",
    // The desktop app labels .mkv as webm for Chromium; Android players want the real type.
    ".mkv" to "video/x-matroska", ".ogv" to "video/ogg", ".mp3" to "audio/mpeg", ".m4a" to "audio/mp4",
    ".aac" to "audio/aac", ".ogg" to "audio/ogg", ".oga" to "audio/ogg", ".opus" to "audio/ogg",
    ".flac" to "audio/flac", ".wav" to "audio/wav", ".srt" to "text/plain", ".vtt" to "text/vtt",
    ".jpg" to "image/jpeg", ".jpeg" to "image/jpeg", ".png" to "image/png", ".webp" to "image/webp", ".gif" to "image/gif",
)

/** Node's posix path.basename. */
internal fun baseName(p: String): String = p.trimEnd('/').substringAfterLast('/')

/** Node's posix path.dirname for the simple relative paths torrents use. */
internal fun dirName(p: String): String {
    val t = p.trimEnd('/')
    val i = t.lastIndexOf('/')
    return when {
        i < 0 -> "."
        i == 0 -> "/"
        else -> t.substring(0, i)
    }
}

/** Node's posix path.extname: last dot of the base name, ignoring a leading dot. */
internal fun extName(p: String): String {
    val base = baseName(p)
    if (base == "..") return ""
    val i = base.lastIndexOf('.')
    return if (i <= 0) "" else base.substring(i)
}

private val PADDING_RE = Regex("(^|[\\\\/])\\.____padding_file([\\\\/]|\\z)")

/** BEP 47 padding files (zeros between real files), shown by some clients as '.____padding_file/12'. */
fun isPaddingFile(path: String): Boolean = PADDING_RE.containsMatchIn(path)

fun kindOf(path: String): FileKind {
    if (isPaddingFile(path)) return FileKind.PADDING
    val ext = extName(path).lowercase()
    return EXT.entries.firstOrNull { ext in it.value }?.key ?: FileKind.OTHER
}

fun mimeOf(name: String): String = MIME[extName(name).lowercase()] ?: "application/octet-stream"

data class FileInfo(val name: String, val path: String, val length: Long)

private val POSTER_NAME = Regex("^(__ia_thumb|poster|cover|folder|thumb|front)\\b", RegexOption.IGNORE_CASE)

/** Pick the image a torrent ships as its cover, preferring conventional names over size. Index into [files]. */
fun pickPosterFile(files: List<FileInfo>): Int? {
    val images = files.indices.filter { kindOf(files[it].name) == FileKind.IMAGE && files[it].length < 10L * 1024 * 1024 }
    if (images.isEmpty()) return null
    images.firstOrNull { POSTER_NAME.containsMatchIn(baseName(files[it].name)) }?.let { return it }
    return images.reduce { a, b -> if (files[b].length > files[a].length) b else a }
}

/** Summarise a torrent's pieces into [buckets] values between 0 and 1, rounded to 2 decimals. */
fun stripFromBitfield(has: (Int) -> Boolean, from: Int, to: Int, buckets: Int): List<Double> {
    val total = to.toLong() - from + 1
    if (total <= 0) return emptyList()
    val n = min(buckets.toLong(), total)
    if (n <= 0) return emptyList()
    return (0 until n).map { b ->
        val s = from + (b * total) / n
        val e = from + ((b + 1) * total) / n
        var have = 0
        for (i in s until e) if (has(i.toInt())) have++
        // JS Math.round: halves round up
        floor(have.toDouble() / max(1L, e - s) * 100 + 0.5) / 100
    }
}
