package app.magnetic.magnetic

import app.magnetic.magnetic.core.mimeOf
import app.magnetic.magnetic.engine.Engine
import app.magnetic.magnetic.engine.FileSource
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/**
 * Serves torrent files over HTTP with Range support (port of the desktop's local server):
 *   /<token>/<infoHash>/<index>/<name>   file bytes; the pieces at the requested byte come first
 *   /<token>/poster/<infoHash>           saved poster, or the torrent's own poster image
 *   /<token>/subs/<id>                   WebVTT handed to a cast device
 * Loopback always; a LAN listener runs only while casting.
 */
object StreamServer {
    private var loopback: ServerSocket? = null
    private var lan: ServerSocket? = null
    private val castSubs = ConcurrentHashMap<String, String>()
    private const val READ_AHEAD_BYTES = 8 * 1024 * 1024

    fun start() {
        if (loopback != null) return
        // Not getLoopbackAddress(): on Android that is ::1, and the player dials 127.0.0.1.
        loopback = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1")).also(::acceptLoop)
    }

    private fun acceptLoop(server: ServerSocket) = thread(isDaemon = true, name = "stream-accept") {
        while (!server.isClosed) {
            val socket = try { server.accept() } catch (_: Exception) { break }
            thread(isDaemon = true, name = "stream-conn") { socket.use { runCatching { serve(it) } } }
        }
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")
    private val port get() = loopback!!.localPort

    fun urlFor(ih: String, index: Int, name: String, host: String = "127.0.0.1", p: Int = port) =
        "http://$host:$p/${Engine.token}/$ih/$index/${enc(name)}"

    fun posterUrl(ih: String, v: String) = "http://127.0.0.1:$port/${Engine.token}/poster/$ih?v=$v"

    // ------------------------------------------------------------- casting

    /** First non-internal IPv4 address (desktop lanAddress). */
    fun lanAddress(): String? = NetworkInterface.getNetworkInterfaces().toList()
        .filter { it.isUp && !it.isLoopback }
        .flatMap { it.inetAddresses.toList() }
        .firstOrNull { it is Inet4Address && !it.isLoopbackAddress }?.hostAddress

    @Synchronized fun ensureLan(): Int {
        lan?.let { return it.localPort }
        return ServerSocket(0, 50).also { lan = it; acceptLoop(it) }.localPort
    }

    @Synchronized fun closeLan() {
        lan?.close(); lan = null
        castSubs.clear()
    }

    fun putCastSubs(vtt: String): String {
        castSubs.clear()
        val id = (1..12).map { "0123456789abcdef".random() }.joinToString("")
        castSubs[id] = vtt
        return id
    }

    // ------------------------------------------------------------- HTTP

    private fun serve(socket: Socket) {
        val input = socket.getInputStream()
        val out = socket.getOutputStream().buffered(64 * 1024)
        val requestLine = readLine(input) ?: return
        val headers = generateSequence { readLine(input)?.takeIf { it.isNotEmpty() } }
            .mapNotNull { l -> l.indexOf(':').takeIf { it > 0 }?.let { l.substring(0, it).trim().lowercase() to l.substring(it + 1).trim() } }
            .toMap()
        val (method, target) = requestLine.split(" ").let { (it.getOrNull(0) ?: "") to (it.getOrNull(1) ?: "") }
        val parts = target.substringBefore('?').split("/").drop(1)
        if ((method != "GET" && method != "HEAD") || parts.firstOrNull() != Engine.token) return respond(out, "404 Not Found")

        when {
            parts.getOrNull(1) == "poster" -> servePoster(out, method, parts.getOrNull(2) ?: "")
            parts.getOrNull(1) == "subs" -> {
                val vtt = castSubs[parts.getOrNull(2)] ?: return respond(out, "404 Not Found")
                val bytes = vtt.toByteArray()
                respond(out, "200 OK", "Content-Type: text/vtt; charset=utf-8", "Content-Length: ${bytes.size}", flush = false)
                if (method == "GET") out.write(bytes)
                out.flush()
            }
            else -> {
                val src = parts.getOrNull(2)?.toIntOrNull()?.let { Engine.source(parts[1], it) } ?: return respond(out, "404 Not Found")
                serveFile(out, method, headers["range"], src)
            }
        }
    }

    private fun servePoster(out: OutputStream, method: String, ih: String) {
        Engine.posterFile(ih)?.let { return sendWhole(out, method, it, "image/jpeg") }
        val index = Engine.torrentPosterIndex(ih) ?: return respond(out, "404 Not Found")
        val src = Engine.source(ih, index)
        if (src != null) return serveFile(out, method, null, src)
        // Not running: serve it from disk if it finished downloading.
        val e = Engine.entryOf(ih) ?: return respond(out, "404 Not Found")
        val saved = e.files.getOrNull(index)?.takeIf { it.progress >= 1 } ?: return respond(out, "404 Not Found")
        val f = File(e.path, saved.path).takeIf { it.exists() } ?: return respond(out, "404 Not Found")
        sendWhole(out, method, f, mimeOf(f.name))
    }

    private fun sendWhole(out: OutputStream, method: String, f: File, mime: String) {
        respond(out, "200 OK", "Content-Type: $mime", "Content-Length: ${f.length()}", "Cache-Control: no-store", flush = false)
        if (method == "GET") f.inputStream().use { it.copyTo(out) }
        out.flush()
    }

    private fun serveFile(out: OutputStream, method: String, rangeHeader: String?, src: FileSource) {
        val range = parseRange(rangeHeader, src.size)
            ?: return respond(out, "416 Range Not Satisfiable", "Content-Range: bytes */${src.size}")
        val head = buildList {
            add("Content-Type: ${mimeOf(src.name)}")
            add("Accept-Ranges: bytes")
            add("Content-Length: ${range.length}")
            add("Cache-Control: no-store")
            add("Access-Control-Allow-Origin: *")
            if (range.partial) add("Content-Range: bytes ${range.start}-${range.end}/${src.size}")
        }
        respond(out, if (range.partial) "206 Partial Content" else "200 OK", *head.toTypedArray(), flush = false)
        if (method == "HEAD" || src.size == 0L) return out.flush()
        try {
            readRange(src, range.start, range.end) { buf, n -> out.write(buf, 0, n) }
            out.flush()
        } catch (_: java.io.IOException) {
            // The player closed the connection (usually a seek).
        }
    }

    /**
     * Reads [start]..[end] of a torrent file, waiting for each piece (fetched first via deadlines).
     * Shared by the HTTP server and the subtitle / hash readers. Returns false if the torrent went away.
     */
    fun readRange(src: FileSource, start: Long, end: Long, sink: (ByteArray, Int) -> Unit): Boolean {
        val buf = ByteArray(64 * 1024)
        var raf: RandomAccessFile? = null
        try {
            var pos = start
            while (pos <= end) {
                val piece = pieceAt(src.fileOffset, pos, src.pieceLength)
                prioritize(src, piece)
                if (!waitForPiece(src, piece)) return false
                val pieceEndInFile = (piece + 1).toLong() * src.pieceLength - src.fileOffset - 1
                val chunkEnd = minOf(end, pieceEndInFile)
                val r = raf ?: RandomAccessFile(src.file, "r").also { raf = it }
                r.seek(pos)
                while (pos <= chunkEnd) {
                    val n = r.read(buf, 0, minOf(buf.size.toLong(), chunkEnd - pos + 1).toInt())
                    if (n < 0) return false
                    sink(buf, n)
                    pos += n
                }
            }
            return true
        } finally {
            raf?.close()
        }
    }

    fun readBytes(src: FileSource, start: Long, end: Long): ByteArray? {
        val out = java.io.ByteArrayOutputStream()
        return if (readRange(src, start, end) { b, n -> out.write(b, 0, n) }) out.toByteArray() else null
    }

    private fun prioritize(src: FileSource, piece: Int) {
        val window = maxOf(5, READ_AHEAD_BYTES / src.pieceLength)
        for (i in 0 until window) {
            val p = piece + i
            if (p >= src.numPieces || p > src.lastPiece) break
            if (!src.handle.havePiece(p)) src.handle.setPieceDeadline(p, i * 150)
        }
    }

    private fun waitForPiece(src: FileSource, piece: Int): Boolean {
        while (true) {
            if (!src.handle.isValid) return false
            if (src.handle.havePiece(piece)) return true
            Thread.sleep(50)
        }
    }

    private fun respond(out: OutputStream, status: String, vararg headers: String, flush: Boolean = true) {
        val text = buildString {
            append("HTTP/1.1 $status\r\n")
            headers.forEach { append(it).append("\r\n") }
            if (!status.startsWith("2")) append("Content-Length: 0\r\n")
            append("Connection: close\r\n\r\n")
        }
        out.write(text.toByteArray(Charsets.US_ASCII))
        if (flush) out.flush()
    }

    private fun readLine(input: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val c = input.read()
            if (c < 0) return if (sb.isEmpty()) null else sb.toString()
            if (c == '\n'.code) return sb.toString().trimEnd('\r')
            sb.append(c.toChar())
        }
    }
}
