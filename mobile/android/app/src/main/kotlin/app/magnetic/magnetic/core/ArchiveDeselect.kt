// Port of archiveDeselect from web-app/lib/archive.js.
//
// Archive items hold every derivative of a recording: the 11 GB original, an .mp4, an .ogv,
// a 512kb preview... Downloading all of them can mean 40 GB for one film. Keep the best
// playable copy for each recording, plus subtitles and the item thumbnail.
package app.magnetic.magnetic.core

private val RANK: Map<FileKind, Map<String, Int>> = mapOf(
    FileKind.VIDEO to mapOf(".mp4" to 3, ".m4v" to 3, ".webm" to 3, ".mkv" to 2, ".mov" to 2, ".ogv" to 1),
    FileKind.AUDIO to mapOf(".mp3" to 3, ".m4a" to 3, ".ogg" to 2, ".opus" to 2, ".oga" to 2, ".flac" to 1),
)

private val DERIVATIVE = Regex(
    "([._-](512kb|1080p|720p|480p|360p|hd|sd|hq|lq|vbr|64kb|128kb|256kb|320kb|ia|edit|dvd\\d?|ps3|psp|iphone|ipod|ipad|h264|mpeg4|xvid|divx))+\\z",
    RegexOption.IGNORE_CASE,
)

private val SUBTITLE_NAME = Regex("\\.(srt|vtt|ass|ssa)\\z")

private class Best(val index: Int, val rank: Int, val length: Long)

/** Node's path.join(dir, base) for the cases archive paths produce. */
private fun joinPath(dir: String, base: String): String = when {
    dir == "." -> base.ifEmpty { "." }
    base.isEmpty() -> dir
    dir.endsWith("/") -> dir + base
    else -> "$dir/$base"
}

/** Indices of files to leave unticked when adding an Internet Archive torrent. */
fun archiveDeselect(files: List<FileInfo>): List<Int> {
    val best = LinkedHashMap<String, Best>() // recording stem -> best copy so far
    files.forEachIndexed { i, f ->
        val p = f.path.ifEmpty { f.name }
        if (isPaddingFile(p)) return@forEachIndexed
        val kind = kindOf(f.name)
        if (kind != FileKind.VIDEO && kind != FileKind.AUDIO) return@forEachIndexed
        val rawExt = extName(f.name)
        val ext = rawExt.lowercase()
        val base = baseName(f.name).removeSuffix(rawExt).replace(DERIVATIVE, "")
        val stem = kind.wire + ":" + joinPath(dirName(p), base).lowercase()
        val rank = RANK.getValue(kind)[ext] ?: 0
        val cur = best[stem]
        if (cur == null || rank > cur.rank || (rank == cur.rank && f.length > cur.length)) best[stem] = Best(i, rank, f.length)
    }
    // a film item's audio files are soundtrack rips of the same film: skip them
    val hasVideo = best.keys.any { it.startsWith("video:") }
    val keep = best.filterKeys { !hasVideo || it.startsWith("video:") }.values.map { it.index }.toMutableSet()
    files.forEachIndexed { i, f ->
        val n = f.name.lowercase()
        if (n == "__ia_thumb.jpg" || SUBTITLE_NAME.containsMatchIn(n)) keep.add(i)
    }
    return files.indices.filter { it !in keep }
}
