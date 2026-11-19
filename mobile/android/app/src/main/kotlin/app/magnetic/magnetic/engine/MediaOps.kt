package app.magnetic.magnetic.engine

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import app.magnetic.magnetic.StreamServer
import app.magnetic.magnetic.core.ENCODINGS
import app.magnetic.magnetic.core.decodeSubtitle
import app.magnetic.magnetic.core.languageFromName
import app.magnetic.magnetic.core.movieHash
import java.io.ByteArrayOutputStream
import java.io.File

/** media:subtitle, media:subtitleFile, subs:hash, media:metadata, media:savePoster. */
object MediaOps {
    private val subtitleExt = Regex("""\.(srt|vtt|ass|ssa)$""", RegexOption.IGNORE_CASE)

    fun encodings() = ENCODINGS.map { mapOf("id" to it.id, "label" to it.label) }

    private fun subsDir() = File(Engine.app.cacheDir, "subs").apply { mkdirs() }

    /** Decodes [bytes] and writes a UTF-8 copy mpv can load. */
    private fun decoded(name: String, bytes: ByteArray, encoding: String, cacheName: String): Map<String, Any?> {
        val d = decodeSubtitle(bytes, encoding, languageFromName(name))
        val ext = subtitleExt.find(name)?.value ?: ".srt"
        val out = File(subsDir(), cacheName.replace(Regex("[^\\w.-]"), "_") + ext).apply { writeText(d.text) }
        return mapOf("name" to name, "text" to d.text, "encoding" to d.encoding, "utf8Path" to out.absolutePath)
    }

    /** A subtitle file inside the torrent, read whole (its pieces come first). */
    fun torrentSubtitle(ih: String, index: Int, encoding: String): Map<String, Any?> {
        Engine.liveReady(ih)
        val src = Engine.source(ih, index) ?: throw UserError("File not found in this torrent.")
        val bytes = if (src.size == 0L) ByteArray(0) else StreamServer.readBytes(src, 0, src.size - 1)
            ?: throw UserError("File not found in this torrent.")
        return decoded(src.name, bytes, encoding, "$ih-$index")
    }

    /** A subtitle file on the phone (picked by the user, or downloaded from OpenSubtitles). */
    fun diskSubtitle(path: String, encoding: String): Map<String, Any?> {
        val f = File(path)
        if (!subtitleExt.containsMatchIn(path) || !f.isFile) throw UserError("That subtitle file is no longer there.")
        return decoded(f.name, f.readBytes(), encoding, "disk-${path.hashCode()}") + ("path" to path)
    }

    /** OpenSubtitles movie hash of one torrent file (reads its first and last 64 KiB). */
    fun hash(ih: String, index: Int): Map<String, Any?> {
        Engine.liveReady(ih)
        val src = Engine.source(ih, index) ?: throw UserError("File not found in this torrent.")
        val torrentName = Engine.entryOf(ih)?.name ?: ""
        val chunk = 64L * 1024
        val hash = if (src.size >= chunk * 2) {
            val head = StreamServer.readBytes(src, 0, chunk - 1)
            val tail = StreamServer.readBytes(src, src.size - chunk, src.size - 1)
            if (head != null && tail != null) movieHash(src.size, head, tail) else null
        } else null
        return mapOf("hash" to hash, "name" to src.name, "torrentName" to torrentName, "size" to src.size)
    }

    /** Tags and cover art of a music file; the cover becomes the torrent's poster if it has none. */
    fun metadata(ih: String, index: Int): Map<String, Any?>? {
        val url = Engine.stream(ih, index)["url"] as String
        val r = MediaMetadataRetriever()
        return try {
            r.setDataSource(url, emptyMap())
            val picture = r.embeddedPicture
            if (picture != null && Engine.posterFile(ih) == null && Engine.torrentPosterIndex(ih) == null) savePoster(ih, picture)
            mapOf(
                "title" to (r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE) ?: ""),
                "artist" to (r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST)
                    ?: r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST) ?: ""),
                "album" to (r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM) ?: ""),
                "picture" to picture,
            )
        } catch (_: Exception) {
            null
        } finally {
            runCatching { r.release() }
        }
    }

    /**
     * Saves a frame or cover as the torrent's poster: at most 640 px wide, JPEG quality 82.
     * False when a poster already exists or the torrent ships its own.
     */
    fun savePoster(ih: String, image: ByteArray): Boolean {
        if (Engine.entryOf(ih) == null || Engine.posterFile(ih) != null || Engine.torrentPosterIndex(ih) != null) return false
        val bmp = BitmapFactory.decodeByteArray(image, 0, image.size) ?: return false
        val scaled = if (bmp.width > 640) Bitmap.createScaledBitmap(bmp, 640, bmp.height * 640 / bmp.width, true) else bmp
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, 82, out)
        Engine.savePoster(ih, out.toByteArray())
        return true
    }
}
