package app.magnetic.magnetic

/** Inclusive byte range [start, end]. `partial` = the client asked for a range (206 vs 200). */
data class ByteRange(val start: Long, val end: Long, val partial: Boolean) {
    val length get() = end - start + 1
}

/** Parses an HTTP `Range: bytes=…` header for a file of [size] bytes. Null = unsatisfiable (416). */
fun parseRange(header: String?, size: Long): ByteRange? {
    if (header == null) return ByteRange(0, size - 1, partial = false)
    val m = Regex("""bytes=(\d*)-(\d*)""").matchEntire(header.trim()) ?: return null
    val (a, b) = m.destructured
    val range = when {
        a.isEmpty() && b.isEmpty() -> return null
        a.isEmpty() -> ByteRange(maxOf(0, size - b.toLong()), size - 1, true) // suffix: last N bytes
        else -> ByteRange(a.toLong(), if (b.isEmpty()) size - 1 else minOf(b.toLong(), size - 1), true)
    }
    return if (range.start >= size || range.start > range.end) null else range
}

/** Index of the torrent piece holding byte [offsetInFile] of a file that starts at [fileOffset] in the torrent. */
fun pieceAt(fileOffset: Long, offsetInFile: Long, pieceLength: Int): Int =
    ((fileOffset + offsetInFile) / pieceLength).toInt()
