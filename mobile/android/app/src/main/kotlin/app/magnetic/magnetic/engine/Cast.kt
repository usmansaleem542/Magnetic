package app.magnetic.magnetic.engine

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import androidx.mediarouter.media.MediaRouteSelector
import androidx.mediarouter.media.MediaRouter
import app.magnetic.magnetic.StreamServer
import app.magnetic.magnetic.core.mimeOf
import com.google.android.gms.cast.CastMediaControlIntent
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaLoadRequestData
import com.google.android.gms.cast.MediaMetadata
import com.google.android.gms.cast.MediaSeekOptions
import com.google.android.gms.cast.MediaTrack
import com.google.android.gms.cast.TextTrackStyle
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastSession
import com.google.android.gms.cast.framework.SessionManagerListener
import java.net.DatagramPacket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.MulticastSocket
import java.net.SocketTimeoutException
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Casting (port of lib/cast.js): Chromecast through the Google Cast SDK with the Default Media
 * Receiver, DLNA renderers through UPnP AVTransport. Device ids are "<type>:<host>:<name>".
 */
object Cast {
    data class Device(val id: String, val name: String, val type: String, val route: MediaRouter.RouteInfo? = null, val dlna: DlnaRenderer? = null)
    data class DlnaRenderer(val name: String, val host: String, val control: String)

    private val main = Handler(Looper.getMainLooper())
    private val dlna = LinkedHashMap<String, DlnaRenderer>()
    private var router: MediaRouter? = null
    private var selector: MediaRouteSelector? = null
    private var discovering = false
    private var active: Device? = null
    private var lastDlnaSearch = 0L

    private val routerCallback = object : MediaRouter.Callback() {}

    private fun <T> onMain(block: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        var result: Result<T>? = null
        val latch = CountDownLatch(1)
        main.post { result = runCatching(block); latch.countDown() }
        latch.await(10, TimeUnit.SECONDS)
        return result!!.getOrThrow()
    }

    private fun startDiscovery(c: Context) {
        if (discovering) return
        discovering = true
        runCatching {
            onMain {
                CastContext.getSharedInstance(c)
                val s = MediaRouteSelector.Builder()
                    .addControlCategory(CastMediaControlIntent.categoryForCast(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID))
                    .build()
                selector = s
                router = MediaRouter.getInstance(c).also { it.addCallback(s, routerCallback, MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN) }
            }
        }
    }

    /** `cast:list`: devices seen so far (Chromecast, then DLNA, by name), re-querying each call. */
    fun list(c: Context): List<Map<String, Any?>> {
        startDiscovery(c)
        if (System.currentTimeMillis() - lastDlnaSearch > 5000) {
            lastDlnaSearch = System.currentTimeMillis()
            Engine.io.execute { runCatching { searchDlna(c) } }
        }
        return devices(c).map { mapOf("id" to it.id, "name" to it.name, "type" to it.type) }
    }

    private fun devices(c: Context): List<Device> {
        val casts = runCatching {
            onMain {
                val s = selector ?: return@onMain emptyList()
                router?.routes.orEmpty().filter { !it.isDefault && it.matchesSelector(s) && it.isEnabled }
                    .map { Device("chromecast:${it.id}:${it.name}", prettyCastName(it.name), "chromecast", route = it) }
            }
        }.getOrDefault(emptyList())
        val renderers = synchronized(dlna) { dlna.values.toList() }.map { Device("dlna:${it.host}:${it.name}", it.name, "dlna", dlna = it) }
        val all = casts.sortedBy { it.name } + renderers.sortedBy { it.name }
        // Duplicate names get " (<last 4 alphanumerics of the id>)".
        val dupes = all.groupBy { it.name }.filterValues { it.size > 1 }.keys
        return all.map { d -> if (d.name in dupes) d.copy(name = "${d.name} (${d.id.filter(Char::isLetterOrDigit).takeLast(4)})") else d }
    }

    private fun prettyCastName(raw: String) = raw.replace(Regex("-[0-9a-f]{32}$"), "").replace('-', ' ')

    // ------------------------------------------------------------------ play / control

    /** `cast:play`. Returns {id, name, type, subtitles}. */
    fun play(c: Context, deviceId: String, ih: String, index: Int, startTime: Double, vtt: String?): Map<String, Any?> {
        Engine.liveReady(ih)
        val host = StreamServer.lanAddress() ?: throw UserError("Connect to a Wi-Fi or wired network to cast.")
        val port = StreamServer.ensureLan()
        val src = Engine.source(ih, index) ?: throw UserError("File not found in this torrent.")
        val url = StreamServer.urlFor(ih, index, src.name, host, port)
        val subsUrl = vtt?.let { "http://$host:$port/${Engine.token}/subs/${StreamServer.putCastSubs(it)}" }
        val device = devices(c).firstOrNull { it.id == deviceId }
            ?: throw UserError("That device is no longer available. Open the cast menu to search again.")
        stop()
        val mime = mimeOf(src.name)
        if (device.route != null) playChromecast(c, device.route, url, mime, src.name, startTime, subsUrl)
        else playDlna(device.dlna!!, url, mime, src.name, startTime)
        active = device
        return mapOf("id" to device.id, "name" to device.name, "type" to device.type, "subtitles" to (subsUrl != null && device.type == "chromecast"))
    }

    private fun castSession(c: Context): CastSession? = onMain { CastContext.getSharedInstance(c).sessionManager.currentCastSession }

    private fun playChromecast(c: Context, route: MediaRouter.RouteInfo, url: String, mime: String, title: String, start: Double, subs: String?) {
        val latch = CountDownLatch(1)
        val listener = object : SessionManagerListener<CastSession> {
            override fun onSessionStarted(s: CastSession, id: String) = latch.countDown()
            override fun onSessionResumed(s: CastSession, wasSuspended: Boolean) = latch.countDown()
            override fun onSessionStartFailed(s: CastSession, error: Int) = latch.countDown()
            override fun onSessionStarting(s: CastSession) {}
            override fun onSessionEnding(s: CastSession) {}
            override fun onSessionEnded(s: CastSession, error: Int) {}
            override fun onSessionResuming(s: CastSession, id: String) {}
            override fun onSessionResumeFailed(s: CastSession, error: Int) = latch.countDown()
            override fun onSessionSuspended(s: CastSession, reason: Int) {}
        }
        onMain {
            CastContext.getSharedInstance(c).sessionManager.addSessionManagerListener(listener, CastSession::class.java)
            router?.selectRoute(route)
        }
        latch.await(20, TimeUnit.SECONDS)
        onMain { CastContext.getSharedInstance(c).sessionManager.removeSessionManagerListener(listener, CastSession::class.java) }
        val session = castSession(c) ?: throw UserError("That device is no longer available. Open the cast menu to search again.")
        val meta = MediaMetadata(MediaMetadata.MEDIA_TYPE_MOVIE).apply { putString(MediaMetadata.KEY_TITLE, title) }
        val info = MediaInfo.Builder(url).setContentType(mime).setStreamType(MediaInfo.STREAM_TYPE_BUFFERED).setMetadata(meta)
        if (subs != null) {
            info.setMediaTracks(listOf(MediaTrack.Builder(1, MediaTrack.TYPE_TEXT).setContentId(subs).setContentType("text/vtt")
                .setSubtype(MediaTrack.SUBTYPE_SUBTITLES).setName("Subtitles").build()))
            info.setTextTrackStyle(TextTrackStyle().apply {
                backgroundColor = 0x99000000.toInt(); foregroundColor = 0xFFFFFFFF.toInt()
                edgeType = TextTrackStyle.EDGE_TYPE_NONE; fontScale = 1.1f
            })
        }
        val request = MediaLoadRequestData.Builder().setMediaInfo(info.build()).setAutoplay(true)
            .setCurrentTime((start * 1000).toLong())
            .apply { if (subs != null) setActiveTrackIds(longArrayOf(1)) }
            .build()
        onMain { session.remoteMediaClient?.load(request) }
    }

    fun status(c: Context): Map<String, Any?>? {
        val d = active ?: return null
        return runCatching {
            if (d.route != null) onMain {
                val client = castSession(c)?.remoteMediaClient
                mapOf("name" to d.name, "currentTime" to (client?.approximateStreamPosition ?: 0) / 1000.0,
                    "duration" to (client?.streamDuration ?: 0) / 1000.0, "paused" to (client?.isPaused ?: false))
            } else {
                val pos = soap(d.dlna!!, "GetPositionInfo", "")
                val state = soap(d.dlna, "GetTransportInfo", "")
                mapOf("name" to d.name, "currentTime" to clock(tag(pos, "RelTime")), "duration" to clock(tag(pos, "TrackDuration")),
                    "paused" to (tag(state, "CurrentTransportState") !in setOf("PLAYING", "TRANSITIONING")))
            }
        }.getOrElse { mapOf("name" to d.name, "currentTime" to 0, "duration" to 0, "paused" to false) }
    }

    private fun need(): Device = active ?: throw UserError("Nothing is casting.")

    fun pause(c: Context) { val d = need(); if (d.route != null) onMain { castSession(c)?.remoteMediaClient?.pause() } else soap(d.dlna!!, "Pause", "") }
    fun resume(c: Context) { val d = need(); if (d.route != null) onMain { castSession(c)?.remoteMediaClient?.play() } else soap(d.dlna!!, "Play", "<Speed>1</Speed>") }

    fun seek(c: Context, seconds: Double) {
        val d = need()
        if (d.route != null) onMain { castSession(c)?.remoteMediaClient?.seek(MediaSeekOptions.Builder().setPosition((seconds * 1000).toLong()).build()) }
        else soap(d.dlna!!, "Seek", "<Unit>REL_TIME</Unit><Target>${hms(seconds)}</Target>")
    }

    fun stop(c: Context? = null) {
        val d = active ?: return
        active = null
        runCatching {
            if (d.route != null && c != null) onMain { CastContext.getSharedInstance(c).sessionManager.endCurrentSession(true) }
            else if (d.route != null) onMain { router?.unselect(MediaRouter.UNSELECT_REASON_STOPPED) }
            else soap(d.dlna!!, "Stop", "")
        }
    }

    // ------------------------------------------------------------------ DLNA (UPnP AVTransport)

    private const val AVT = "urn:schemas-upnp-org:service:AVTransport:1"

    private fun searchDlna(c: Context) {
        val wifi = c.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val lock = wifi.createMulticastLock("magnetic-ssdp").apply { setReferenceCounted(false); acquire() }
        try {
            MulticastSocket().use { sock ->
                sock.soTimeout = 1500
                val msg = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: $AVT\r\n\r\n".toByteArray()
                repeat(2) { sock.send(DatagramPacket(msg, msg.size, InetAddress.getByName("239.255.255.250"), 1900)) }
                val buf = ByteArray(2048)
                val locations = mutableSetOf<String>()
                val until = System.currentTimeMillis() + 3000
                while (System.currentTimeMillis() < until) {
                    val p = DatagramPacket(buf, buf.size)
                    try { sock.receive(p) } catch (_: SocketTimeoutException) { break }
                    Regex("(?im)^location:\\s*(\\S+)").find(String(p.data, 0, p.length))?.let { locations += it.groupValues[1] }
                }
                locations.forEach { loc -> runCatching { describe(loc) }.getOrNull()?.let { synchronized(dlna) { dlna[loc] = it } } }
            }
        } finally { lock.release() }
    }

    private fun describe(location: String): DlnaRenderer? {
        val doc = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = false }.newDocumentBuilder()
            .parse(URL(location).openStream())
        val name = doc.getElementsByTagName("friendlyName").item(0)?.textContent ?: return null
        val services = doc.getElementsByTagName("service")
        for (i in 0 until services.length) {
            val s = services.item(i) as org.w3c.dom.Element
            if (s.getElementsByTagName("serviceType").item(0)?.textContent?.startsWith("urn:schemas-upnp-org:service:AVTransport") != true) continue
            val control = s.getElementsByTagName("controlURL").item(0)?.textContent ?: continue
            val base = doc.getElementsByTagName("URLBase").item(0)?.textContent?.takeIf { it.isNotBlank() } ?: location
            return DlnaRenderer(name, URL(location).host, URL(URL(base), control).toString())
        }
        return null
    }

    private fun playDlna(r: DlnaRenderer, url: String, mime: String, title: String, start: Double) {
        val esc = { s: String -> s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;") }
        val didl = """<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>${esc(title)}</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo="http-get:*:$mime:*">${esc(url)}</res></item></DIDL-Lite>"""
        soap(r, "SetAVTransportURI", "<CurrentURI>${esc(url)}</CurrentURI><CurrentURIMetaData>${esc(didl)}</CurrentURIMetaData>")
        soap(r, "Play", "<Speed>1</Speed>")
        if (start > 0) runCatching { Thread.sleep(1500); soap(r, "Seek", "<Unit>REL_TIME</Unit><Target>${hms(start)}</Target>") }
    }

    private fun soap(r: DlnaRenderer, action: String, args: String): String {
        val body = """<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:$action xmlns:u="$AVT"><InstanceID>0</InstanceID>$args</u:$action></s:Body></s:Envelope>"""
        val c = URL(r.control).openConnection() as HttpURLConnection
        c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 5000; c.readTimeout = 8000
        c.setRequestProperty("Content-Type", "text/xml; charset=\"utf-8\"")
        c.setRequestProperty("SOAPACTION", "\"$AVT#$action\"")
        c.outputStream.use { it.write(body.toByteArray()) }
        val code = c.responseCode
        val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: ""
        c.disconnect()
        if (code !in 200..299) throw IllegalStateException("DLNA $action failed (HTTP $code)")
        return text
    }

    private fun tag(xml: String, name: String) = Regex("<$name>([^<]*)</$name>").find(xml)?.groupValues?.get(1) ?: ""
    private fun clock(s: String): Double = s.split(":").takeIf { it.size == 3 }?.let { (h, m, sec) ->
        (h.toDoubleOrNull() ?: 0.0) * 3600 + (m.toDoubleOrNull() ?: 0.0) * 60 + (sec.toDoubleOrNull() ?: 0.0)
    } ?: 0.0
    private fun hms(s: Double): String { val t = s.toLong(); return "%d:%02d:%02d".format(t / 3600, t / 60 % 60, t % 60) }
}
