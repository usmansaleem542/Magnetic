package app.magnetic.magnetic.engine

import android.content.Context
import app.magnetic.magnetic.StreamServer
import app.magnetic.magnetic.core.mimeOf
import android.os.Environment
import android.os.StatFs
import app.magnetic.magnetic.core.DEFAULT_TRACKERS
import app.magnetic.magnetic.core.FileInfo
import app.magnetic.magnetic.core.FileKind
import app.magnetic.magnetic.core.archiveDeselect
import app.magnetic.magnetic.core.kindOf
import app.magnetic.magnetic.core.mergeTrackers
import app.magnetic.magnetic.core.parseTrackerList
import app.magnetic.magnetic.core.pickPosterFile
import app.magnetic.magnetic.core.planTrackers
import app.magnetic.magnetic.core.stripFromBitfield
import app.magnetic.magnetic.core.tidyError
import app.magnetic.magnetic.core.trackerKey
import org.json.JSONArray
import org.json.JSONObject
import org.libtorrent4j.AddTorrentParams
import org.libtorrent4j.AlertListener
import org.libtorrent4j.AnnounceEntry
import org.libtorrent4j.Priority
import org.libtorrent4j.SessionManager
import org.libtorrent4j.SessionParams
import org.libtorrent4j.SettingsPack
import org.libtorrent4j.Sha1Hash
import org.libtorrent4j.TorrentHandle
import org.libtorrent4j.TorrentInfo
import org.libtorrent4j.Vectors
import org.libtorrent4j.alerts.Alert
import org.libtorrent4j.alerts.AlertType
import org.libtorrent4j.alerts.FileErrorAlert
import org.libtorrent4j.alerts.SaveResumeDataAlert
import org.libtorrent4j.alerts.ScrapeReplyAlert
import org.libtorrent4j.alerts.TorrentErrorAlert
import org.libtorrent4j.alerts.TrackerAlert
import org.libtorrent4j.alerts.TrackerErrorAlert
import org.libtorrent4j.alerts.TrackerReplyAlert
import org.libtorrent4j.swig.libtorrent
import org.libtorrent4j.swig.settings_pack
import org.libtorrent4j.swig.torrent_flags_t
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Per-tracker status, as the desktop app records it (lib/trackers.js noteEvent). */
data class TrackerState(
    var state: String = "checking", var message: String = "", var seeders: Int? = null, var leechers: Int? = null,
    var peers: Int? = null, var lastOk: Long? = null, var lastError: Long? = null,
)

/** A file of a running torrent, ready to be read piece by piece. */
class FileSource(
    val handle: TorrentHandle, val file: File, val name: String, val size: Long,
    val fileOffset: Long, val pieceLength: Int, val numPieces: Int, val firstPiece: Int, val lastPiece: Int,
)

/**
 * The torrent engine: a port of the Electron main process (web-app/main.js) on top of libtorrent.
 * Everything that touches state runs under [lock], the way main.js runs on Node's single thread.
 */
object Engine {
    private const val LOW_SPACE = 1024L * 1024 * 1024
    private const val STRIP_BUCKETS = 160

    lateinit var app: Context
    lateinit var dataDir: File
    val lock = Any()
    private val session = SessionManager(false)
    val entries = mutableListOf<Entry>() // newest first
    var prefs = JSONObject()
    private val handles = HashMap<String, TorrentHandle>()
    private val running = HashSet<String>()
    private val metadataSeen = HashSet<String>()
    private val doneSeen = HashSet<String>()
    private val trackerStatus = HashMap<String, MutableMap<String, TrackerState>>()
    var watching: String? = null
        private set
    val token: String = ByteArray(12).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

    /** Pushes events to Flutter: {type: 'torrents' | 'toast' | 'state', ...}. Called on any thread. */
    @Volatile var emit: ((Map<String, Any?>) -> Unit)? = null
    /** Called after each tick with (downloading count, any active) for the background notification. */
    @Volatile var onActivity: ((Int, Boolean) -> Unit)? = null

    private val timer = Executors.newSingleThreadScheduledExecutor()
    val io = Executors.newCachedThreadPool()
    private var started = false
    private var saveDue = false
    private var lastSave = 0L
    private var lastDiskCheck = 0L
    private var lowSpaceWarned = false

    // ---------------------------------------------------------------- startup

    fun start(context: Context) {
        synchronized(lock) {
            if (started) return
            started = true
            app = context.applicationContext
            dataDir = app.filesDir
            for (d in listOf("torrents", "posters", "resume", "subtitles")) File(dataDir, d).mkdirs()
            Strings.load(app)
            loadState()
            Strings.resolve(prefs.optString("language"))
            startSession()
            StreamServer.start()
            schedule(null)
        }
        timer.scheduleWithFixedDelay({ runCatching { tick() } }, 1, 1, TimeUnit.SECONDS)
    }

    fun defaultDownloadPath(): String =
        File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Magnetic").absolutePath

    private fun defaultPrefs() = JSONObject().apply {
        put("downloadPath", defaultDownloadPath())
        put("notifyOnComplete", true); put("autoPlay", true); put("theme", "system"); put("language", "system")
        put("externalPlayer", "builtin"); put("externalPlayerPath", "")
        put("downloadLimit", 0); put("uploadLimit", 0); put("allowUploads", false); put("seedRatioLimit", 0)
        put("openAtLogin", false); put("closeToTray", true)
        put("osApiKey", ""); put("osUsername", "")
        put("trackers", JSONArray(DEFAULT_TRACKERS)); put("trackersForDownloads", true)
        put("maxActiveDownloads", 0); put("pauseOthersWhileWatching", true); put("askSavePath", false)
    }

    private fun loadState() {
        prefs = defaultPrefs()
        val f = File(dataDir, "state.json")
        if (!f.exists()) return
        runCatching {
            val raw = JSONObject(f.readText())
            raw.optJSONObject("prefs")?.let { p -> p.keys().forEach { prefs.put(it, p.get(it)) } }
            raw.optJSONArray("torrents").objects().mapTo(entries) { Entry.fromJson(it) }
        }.onFailure {
            // Unlike desktop, keep the unreadable file so a bad write never silently empties the library.
            f.copyTo(File(dataDir, "state.json.broken"), overwrite = true)
        }
    }

    private fun saveState() { saveDue = true }

    fun saveStateNow() {
        synchronized(lock) {
            entries.forEach(::captureProgress)
            val json = JSONObject().put("prefs", prefs).put("torrents", JSONArray(entries.map { it.toJson() }))
            val tmp = File(dataDir, "state.json.tmp")
            tmp.writeText(json.toString(2))
            tmp.renameTo(File(dataDir, "state.json"))
            saveDue = false
            lastSave = System.currentTimeMillis()
        }
    }

    private fun startSession() {
        val sp = SettingsPack()
        sp.setEnableDht(true)
        sp.setEnableLsd(true)
        // WebTorrent announces to every tracker; libtorrent defaults to one per tier.
        sp.setBoolean(settings_pack.bool_types.announce_to_all_trackers.swigValue(), true)
        sp.setBoolean(settings_pack.bool_types.announce_to_all_tiers.swigValue(), true)
        session.addListener(object : AlertListener {
            override fun types(): IntArray? = null
            override fun alert(alert: Alert<*>) { runCatching { onAlert(alert) } }
        })
        session.start(SessionParams(sp))
        applyLimits()
    }

    /** Speed limits (KB/s, 0 = none) and the upload switch. Uploads off = never unchoke anyone. */
    fun applyLimits() {
        val sp = SettingsPack()
        val kb = { k: String -> prefs.optDouble(k, 0.0).let { if (it > 0) (it * 1024).toInt() else 0 } }
        sp.downloadRateLimit(kb("downloadLimit"))
        sp.uploadRateLimit(kb("uploadLimit"))
        sp.setInteger(settings_pack.int_types.unchoke_slots_limit.swigValue(), if (prefs.optBoolean("allowUploads")) 8 else 0)
        session.applySettings(sp)
    }

    // ---------------------------------------------------------------- helpers

    fun entryOf(ih: String) = entries.firstOrNull { it.infoHash == ih }
    private fun liveHandle(ih: String) = if (ih in running) handles[ih]?.takeIf { it.isValid } else null
    private fun pushToast(key: String, vars: Map<String, Any?> = emptyMap(), tone: String = "info") =
        emit?.invoke(mapOf("type" to "toast", "message" to key, "vars" to vars, "tone" to tone))

    private fun gb(n: Long): String = if (n >= 1024L * 1024 * 1024) "%.1f GB".format(n / 1073741824.0) else "${Math.round(n / 1048576.0)} MB"

    private fun freeSpace(dir: String): Long? {
        var f: File? = File(dir)
        while (f != null && !f.exists()) f = f.parentFile
        return f?.let { runCatching { StatFs(it.absolutePath).availableBytes }.getOrNull() }
    }

    private fun isComplete(e: Entry): Boolean {
        val h = liveHandle(e.infoHash)
        if (h != null) {
            val st = h.status()
            if (st.hasMetadata()) return st.isFinished
        }
        return e.length > 0 && e.progress >= 1
    }

    private fun priorities(e: Entry, numFiles: Int) =
        Array(numFiles) { if (it in e.deselected) Priority.IGNORE else Priority.DEFAULT }

    // ---------------------------------------------------------------- adding

    /** `torrent:add`. [id]: magnet, info hash, http(s) .torrent URL or local .torrent path. */
    fun add(id: String, path: String? = null, pickBest: Boolean = false): String {
        val trimmed = id.trim()
        var bytes: ByteArray? = null
        when {
            Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(trimmed) -> bytes = fetch(trimmed)
            !trimmed.startsWith("magnet:", ignoreCase = true) && !Regex("^[0-9a-fA-F]{40}$").matches(trimmed) &&
                File(trimmed).isFile -> bytes = File(trimmed).readBytes()
        }
        return addParsed(trimmed, bytes, path, pickBest)
    }

    private fun fetch(url: String): ByteArray {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 20000; c.readTimeout = 30000
        c.setRequestProperty("User-Agent", "Magnetic/${appVersion()}")
        try {
            if (c.responseCode !in 200..299) throw UserError("Couldn't download the .torrent file (HTTP {status}).", mapOf("status" to c.responseCode))
            return c.inputStream.use { it.readBytes() }
        } finally { c.disconnect() }
    }

    private fun addParsed(id: String, bytes: ByteArray?, path: String?, pickBest: Boolean): String {
        val invalid = UserError("That isn't a valid magnet link, info hash or .torrent file.")
        val ti = bytes?.let { runCatching { TorrentInfo.bdecode(it) }.getOrElse { throw invalid } }
        val magnet: String
        val ih: String
        val name: String
        if (ti != null) {
            ih = ti.infoHash().toHex().lowercase()
            name = ti.name()
            magnet = magnetFor(ti)
        } else {
            magnet = if (Regex("^[0-9a-fA-F]{40}$").matches(id)) "magnet:?xt=urn:btih:${id.lowercase()}" else id
            if (!magnet.startsWith("magnet:", ignoreCase = true)) throw invalid
            val p = runCatching { AddTorrentParams.parseMagnetUri(magnet) }.getOrElse { throw invalid }
            val hash = runCatching { p.infoHashes.best.toHex() }.getOrNull()?.lowercase()
            if (hash == null || hash.all { it == '0' }) throw invalid
            ih = hash
            name = p.name ?: ""
        }

        synchronized(lock) {
            entryOf(ih)?.let { e ->
                if (e.paused) resumeTorrent(ih)
                pushToast("{name} is already in your list.", mapOf("name" to e.name.ifEmpty { Strings.t("This torrent") }))
                return ih
            }
            val savePath = writable(path ?: prefs.optString("downloadPath").ifEmpty { defaultDownloadPath() })
            if (path != null) prefs.put("lastSavePath", path)
            val e = Entry(
                infoHash = ih, magnet = magnet, torrentFile = null, name = name, path = savePath, paused = false,
                deselected = mutableListOf(), length = ti?.totalSize() ?: 0, progress = 0.0, files = emptyList(),
                addedAt = System.currentTimeMillis(),
            )
            if (ti != null) {
                val f = File(dataDir, "torrents/$ih.torrent").apply { writeBytes(bytes!!) }
                e.torrentFile = f.absolutePath
                val fs = ti.files()
                val infos = (0 until fs.numFiles()).map { FileInfo(fs.fileName(it), fs.filePath(it), fs.fileSize(it)) }
                if (pickBest) e.deselected.addAll(archiveDeselect(infos))
                e.ownTrackers = mergeTrackers(parseTrackerList(magnet.split("&").filter { it.startsWith("tr=") }
                    .joinToString(" ") { java.net.URLDecoder.decode(it.removePrefix("tr="), "UTF-8") }).valid)
                e.spaceChecked = true
                checkSpace(e, infos.mapIndexed { i, f -> if (i in e.deselected) 0 else f.length }.sum())
            }
            entries.add(0, e)
            schedule(ih)
            saveState()
            return ih
        }
    }

    /** Without all-files access, shared storage isn't writable: use the app's own folder instead. */
    private fun writable(path: String): String {
        val shared = Environment.getExternalStorageDirectory().absolutePath
        val allowed = android.os.Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()
        if (allowed || !path.startsWith(shared)) return path
        return (app.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: File(dataDir, "downloads")).absolutePath
    }

    private fun checkSpace(e: Entry, need: Long) {
        val free = freeSpace(e.path) ?: return
        if (need > free) pushToast(
            "{name} needs {need}, but only {free} is free on that drive. Free up space, or untick some files under ⋯ → Choose files.",
            mapOf("name" to e.name, "need" to gb(need), "free" to gb(free)), "error",
        )
    }

    /** Magnet link for a torrent file (libtorrent4j 2.1.0-39 moved this off TorrentInfo). */
    private fun magnetFor(ti: TorrentInfo): String = libtorrent.make_magnet_uri(AddTorrentParams().also { it.torrentInfo = ti }.swig())

    // ---------------------------------------------------------------- run / stop / queue

    private fun startTorrent(e: Entry) {
        val ih = e.infoHash
        e.paused = false
        e.seedLimitReached = false
        e.uploadedBase = e.uploaded
        val existing = handles[ih]?.takeIf { it.isValid }
        if (existing != null) {
            existing.resume()
            running += ih
            return
        }
        val save = File(e.path).apply { mkdirs() }
        val tf = e.torrentFile?.let(::File)?.takeIf { it.exists() }
        if (tf != null) {
            val ti = TorrentInfo(tf)
            val resume = File(dataDir, "resume/$ih.resume").takeIf { it.exists() }
            session.download(ti, save, resume, priorities(e, ti.numFiles()), null, torrent_flags_t())
        } else {
            session.download(e.magnet, save, torrent_flags_t())
        }
        running += ih
        session.find(Sha1Hash.parseHex(ih))?.let { attach(e, it) }
    }

    /** First time we see a handle: record the torrent's own trackers and add ours. */
    private fun attach(e: Entry, h: TorrentHandle) {
        handles[e.infoHash] = h
        if (e.ownTrackers.isEmpty()) e.ownTrackers = mergeTrackers(h.trackers().map { it.url() })
        applyTrackers(e)
        addWebSeeds(e, h)
    }

    /**
     * HTTP web seeds (BEP 19 `url-list`) from the .torrent. Internet Archive torrents stream from
     * these with no peers at all; they were missing on handles restored from resume data.
     */
    private fun addWebSeeds(e: Entry, h: TorrentHandle) {
        val f = e.torrentFile?.let(::File)?.takeIf { it.exists() } ?: return
        val urls = runCatching {
            when (val v = org.libtorrent4j.Entry.bdecode(f.readBytes()).dictionary()["url-list"]) {
                null -> emptyList()
                else -> runCatching { v.list().map { it.string() } }.getOrElse { listOf(v.string()) }
            }
        }.getOrDefault(emptyList())
        val have = h.urlSeeds().toSet()
        urls.filter { it.startsWith("http") && it !in have }.forEach { h.addUrlSeed(it) }
        if ((urls + h.urlSeeds()).any { it.contains("archive.org/") }) io.execute {
            runCatching { addArchiveNode(e, h) }
        }
    }

    /**
     * archive.org/download/… answers with a chunked 302 that libtorrent's web seed rejects
     * ("missing content-length"). Follow it once and seed straight from the storage node.
     */
    private fun addArchiveNode(e: Entry, h: TorrentHandle) {
        val ti = h.torrentFile() ?: TorrentInfo(File(e.torrentFile ?: return))
        val fs = ti.files()
        // Probe the biggest kept file: small files are served directly, big ones redirect to a node.
        val i = (0 until fs.numFiles()).filter { it !in e.deselected && !fs.padFileAt(it) }.maxByOrNull { fs.fileSize(it) } ?: return
        val rel = fs.filePath(i) // "<identifier>/<file>"
        val enc = rel.split('/').joinToString("/") { java.net.URLEncoder.encode(it, "UTF-8").replace("+", "%20") }
        val c = URL("https://archive.org/download/$enc").openConnection() as HttpURLConnection
        c.instanceFollowRedirects = false
        c.setRequestProperty("Range", "bytes=0-0")
        c.connectTimeout = 15000; c.readTimeout = 15000
        val location = try {
            c.getHeaderField("Location")
        } finally { c.disconnect() } ?: return
        if (!location.endsWith(enc)) return
        val base = location.removeSuffix(enc) // e.g. https://dn711006.ca.archive.org/0/items/
        synchronized(lock) {
            if (!h.isValid) return
            // The redirecting archive.org hosts (and long-gone iaNNN mirrors) only tie up connections.
            h.urlSeeds().filter { it != base && Regex("""^https?://(archive\.org|ia\d+\.us\.archive\.org)/""").containsMatchIn(it) }
                .forEach { h.removeUrlSeed(it) }
            if (base !in h.urlSeeds()) h.addUrlSeed(base)
        }
    }

    private fun stopTorrent(e: Entry) {
        val ih = e.infoHash
        captureProgress(e)
        handles[ih]?.takeIf { it.isValid }?.let {
            it.pause()
            it.saveResumeData(TorrentHandle.SAVE_INFO_DICT)
        }
        running -= ih
        trackerStatus.remove(ih)
    }

    fun pauseTorrent(ih: String) = synchronized(lock) {
        val e = entryOf(ih) ?: return@synchronized
        e.paused = true
        e.queued = null
        stopTorrent(e)
        schedule(null)
        saveState()
    }

    fun resumeTorrent(ih: String) = synchronized(lock) {
        val e = entryOf(ih) ?: return@synchronized
        e.paused = false
        schedule(ih)
        saveState()
    }

    fun pauseAll() = synchronized(lock) { entries.filter { !it.paused }.forEach { pauseTorrent(it.infoHash) } }
    fun resumeAll() = synchronized(lock) { entries.filter { it.paused }.forEach { resumeTorrent(it.infoHash) } }

    /** Port of main.js schedule(): run, queue or stop every torrent. */
    fun schedule(forceIh: String?) = synchronized(lock) {
        val decisions = schedule(
            entries.map { ScheduleInput(it.infoHash, it.paused, isComplete(it), it.infoHash in running, it.addedAt) },
            watching,
            prefs.optDouble("maxActiveDownloads", 0.0).toInt(),
            prefs.optBoolean("pauseOthersWhileWatching", true),
            prefs.optBoolean("allowUploads"),
        )
        for (e in entries) {
            val d = decisions[e.infoHash] ?: continue
            e.queued = d.queued
            if (e.paused) continue
            if (d.run) { if (e.infoHash !in running) startTorrent(e) } else if (e.infoHash in running) stopTorrent(e)
        }
        if (forceIh != null && entryOf(forceIh)?.queued == "limit") {
            pushToast("{name} is queued. It starts when another download finishes.", mapOf("name" to (entryOf(forceIh)?.name ?: "")))
        }
        pushTorrents()
    }

    fun setWatching(ih: String?) = synchronized(lock) {
        watching = if (ih != null && entryOf(ih) != null) ih else null
        schedule(null)
    }

    /** main.js liveReady: playing a file starts its torrent even if it was paused or queued. */
    fun liveReady(ih: String, timeoutMs: Long = 120_000): TorrentHandle {
        synchronized(lock) {
            val e = entryOf(ih) ?: throw UserError("Torrent not found.")
            if (ih !in running) { startTorrent(e); e.queued = null; pushTorrents() }
        }
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            synchronized(lock) {
                val e = entryOf(ih) ?: throw UserError("Torrent not found.")
                val h = handles[ih]?.takeIf { it.isValid } ?: session.find(Sha1Hash.parseHex(ih))?.also { attach(e, it) }
                if (h != null && h.status().hasMetadata()) { onMetadata(e, h); return h }
            }
            Thread.sleep(250)
        }
        throw UserError("Couldn't get the torrent's file list. Check the magnet link and your connection.")
    }

    // ---------------------------------------------------------------- metadata, progress, done

    private fun onMetadata(e: Entry, h: TorrentHandle) {
        if (!metadataSeen.add(e.infoHash)) return
        val ti = h.torrentFile() ?: return
        if (e.torrentFile == null || !File(e.torrentFile!!).exists()) {
            runCatching {
                val p = AddTorrentParams()
                p.torrentInfo = ti
                p.trackers = e.ownTrackers
                val buf = Vectors.byte_vector2bytes(libtorrent.write_torrent_file_buf_ex(p.swig()))
                val f = File(dataDir, "torrents/${e.infoHash}.torrent").apply { writeBytes(buf) }
                e.torrentFile = f.absolutePath
            }
        }
        e.name = ti.name()
        e.length = ti.totalSize()
        h.prioritizeFiles(priorities(e, ti.numFiles()))
        applyTrackers(e)
        val fs = ti.files()
        val infos = (0 until fs.numFiles()).map { FileInfo(fs.fileName(it), fs.filePath(it), fs.fileSize(it)) }
        if (!e.spaceChecked) {
            e.spaceChecked = true
            checkSpace(e, infos.mapIndexed { i, f -> if (i in e.deselected) 0 else f.length }.sum())
        }
        // Torrent ships its own poster: fetch it early so the card shows it.
        pickPosterFile(infos)?.let { if (!File(dataDir, "posters/${e.infoHash}.jpg").exists()) h.filePriority(it, Priority.TOP_PRIORITY) }
        captureProgress(e)
        saveState()
    }

    private fun captureProgress(e: Entry) {
        val h = liveHandle(e.infoHash) ?: return
        val ti = h.torrentFile() ?: return
        val st = h.status()
        val fs = ti.files()
        val fp = h.fileProgress()
        e.name = ti.name()
        e.length = ti.totalSize()
        e.progress = if (st.totalWanted() > 0) st.totalWantedDone().toDouble() / st.totalWanted() else st.progress().toDouble()
        e.uploaded = e.uploadedBase + st.totalPayloadUpload()
        e.files = (0 until fs.numFiles()).map {
            val len = fs.fileSize(it)
            SavedFile(fs.fileName(it), fs.filePath(it), len, if (len > 0) (fp.getOrElse(it) { 0L }.toDouble() / len) else 1.0)
        }
    }

    private fun onDone(e: Entry) {
        captureProgress(e)
        saveState()
        if (!e.notified) {
            e.notified = true
            if (prefs.optBoolean("notifyOnComplete", true)) Notifications.downloadComplete(app, e.name)
        }
        io.execute { schedule(null) }
    }

    private fun tick() {
        val now = System.currentTimeMillis()
        synchronized(lock) {
            val ratioLimit = prefs.optDouble("seedRatioLimit", 0.0)
            for (e in entries.toList()) {
                if (e.infoHash !in running) continue
                val h = handles[e.infoHash]?.takeIf { it.isValid }
                    ?: session.find(Sha1Hash.parseHex(e.infoHash))?.also { attach(e, it) } ?: continue
                val st = h.status()
                if (!st.hasMetadata()) continue
                onMetadata(e, h)
                if (st.isFinished && doneSeen.add(e.infoHash)) onDone(e)
                if (!st.isFinished) doneSeen.remove(e.infoHash)
                if (ratioLimit > 0 && st.isFinished && e.length > 0) {
                    val ratio = (e.uploadedBase + st.totalPayloadUpload()).toDouble() / e.length
                    if (ratio >= ratioLimit) { pauseTorrent(e.infoHash); e.seedLimitReached = true }
                }
            }
            if (now - lastDiskCheck >= 10_000) { lastDiskCheck = now; guardDiskSpace() }
            pushTorrents()
            if (saveDue && now - lastSave > 300 || now - lastSave >= 10_000) saveStateNow()
            val downloading = entries.count { e ->
                liveHandle(e.infoHash)?.status()?.let { it.hasMetadata() && !it.isFinished } == true
            }
            onActivity?.invoke(downloading, running.isNotEmpty())
        }
    }

    /** main.js guardDiskSpace: pause downloads when the drive drops below 1 GiB free. */
    private fun guardDiskSpace() {
        val downloading = entries.filter { it.infoHash in running && !isComplete(it) }
        if (downloading.isEmpty()) { lowSpaceWarned = false; return }
        for ((path, group) in downloading.groupBy { it.path }) {
            val free = freeSpace(path) ?: continue
            if (free < LOW_SPACE) {
                group.forEach { pauseTorrent(it.infoHash) }
                if (!lowSpaceWarned) {
                    lowSpaceWarned = true
                    pushToast("Downloads paused: only {free} is left on the drive. Free up space, then resume them.", mapOf("free" to gb(free)), "error")
                }
                return
            }
        }
        lowSpaceWarned = false
    }

    // ---------------------------------------------------------------- alerts

    private fun onAlert(a: Alert<*>) {
        when (a.type()) {
            AlertType.SAVE_RESUME_DATA -> {
                val alert = a as SaveResumeDataAlert
                val ih = alert.handle().infoHash().toHex().lowercase()
                runCatching { File(dataDir, "resume/$ih.resume").writeBytes(AddTorrentParams.writeResumeDataBuf(alert.params())) }
            }
            AlertType.TRACKER_REPLY -> trackerEvent(a as TrackerAlert<*>) { it.state = "working"; it.message = ""; it.peers = (it.peers ?: 0) + (a as TrackerReplyAlert).numPeers(); it.lastOk = System.currentTimeMillis() }
            AlertType.SCRAPE_REPLY -> trackerEvent(a as TrackerAlert<*>) { val s = a as ScrapeReplyAlert; it.state = "working"; it.message = ""; it.seeders = s.complete; it.leechers = s.incomplete; it.lastOk = System.currentTimeMillis() }
            AlertType.TRACKER_ERROR -> trackerEvent(a as TrackerAlert<*>) { it.state = "failing"; it.message = tidyError((a as TrackerErrorAlert).errorMessage().ifEmpty { a.error().message }); it.lastError = System.currentTimeMillis() }
            AlertType.TRACKER_WARNING -> trackerEvent(a as TrackerAlert<*>) { it.state = "failing"; it.message = tidyError(a.message()); it.lastError = System.currentTimeMillis() }
            AlertType.FILE_ERROR -> torrentError((a as FileErrorAlert).handle(), a.error().message)
            AlertType.TORRENT_ERROR -> torrentError((a as TorrentErrorAlert).handle(), a.error().message)
            else -> if (a.type().name.contains("URL_SEED") || a.type().name.contains("PEER_ERROR") || a.type().name.contains("HASH_FAILED")) {
            }
        }
    }

    private fun trackerEvent(a: TrackerAlert<*>, update: (TrackerState) -> Unit) = synchronized(lock) {
        val ih = a.handle().infoHash().toHex().lowercase()
        val map = trackerStatus.getOrPut(ih) { HashMap() }
        update(map.getOrPut(trackerKey(a.trackerUrl())) { TrackerState() })
    }

    private fun torrentError(h: TorrentHandle, message: String) = synchronized(lock) {
        val ih = h.infoHash().toHex().lowercase()
        val e = entryOf(ih) ?: return@synchronized
        running -= ih
        e.paused = true
        runCatching { h.pause() }
        if (Regex("ENOSPC|no space left", RegexOption.IGNORE_CASE).containsMatchIn(message)) {
            pushToast("{name} stopped: the drive is full. Free up space, then resume it.", mapOf("name" to e.name.ifEmpty { Strings.t("A torrent") }), "error")
        } else {
            pushToast("{name}: {message}", mapOf("name" to e.name.ifEmpty { "Torrent" }, "message" to message), "error")
        }
        saveState()
    }

    // ---------------------------------------------------------------- trackers

    private fun isPrivate(ih: String) = handles[ih]?.takeIf { it.isValid }?.torrentFile()?.isPrivate == true

    private fun globalTrackers() = prefs.optJSONArray("trackers").strings()

    private fun planFor(e: Entry) = planTrackers(
        own = e.ownTrackers, added = e.addedTrackers, removed = e.removedTrackers, global = globalTrackers(),
        useGlobal = prefs.optBoolean("trackersForDownloads", true), isPrivate = isPrivate(e.infoHash),
    )

    /** libtorrent can't reach WebTorrent (ws/wss) trackers; the list shows them as unsupported. */
    private fun usable(url: String) = !url.startsWith("ws://") && !url.startsWith("wss://")

    fun applyTrackers(e: Entry) {
        val h = handles[e.infoHash]?.takeIf { it.isValid } ?: return
        val plan = planFor(e)
        val list = (plan.own + plan.extra).filter(::usable)
        val current = h.trackers().map { trackerKey(it.url()) }
        if (current == list.map(::trackerKey)) return
        h.replaceTrackers(list.map { AnnounceEntry(it) })
        if (e.infoHash in running) h.forceReannounce()
    }

    fun trackerList(ih: String): Map<String, Any?> = synchronized(lock) {
        val e = entryOf(ih) ?: throw UserError("That torrent is no longer in your list.")
        val plan = planFor(e)
        val live = ih in running
        val status = trackerStatus[ih] ?: emptyMap()
        val ownKeys = e.ownTrackers.map(::trackerKey).toSet()
        val addedKeys = e.addedTrackers.map(::trackerKey).toSet()
        val rows = (plan.own + plan.extra).map { url ->
            val key = trackerKey(url)
            val s = status[key]
            val row = mutableMapOf<String, Any?>(
                "url" to url,
                "source" to when (key) { in ownKeys -> "torrent"; in addedKeys -> "added"; else -> "preferences" },
            )
            when {
                !live -> row["state"] = "paused"
                !usable(url) -> { row["state"] = "invalid"; row["message"] = "Unsupported address" }
                s == null -> row["state"] = "checking"
                else -> row.putAll(mapOf("state" to s.state, "message" to s.message, "seeders" to s.seeders,
                    "leechers" to s.leechers, "peers" to s.peers, "lastOk" to s.lastOk, "lastError" to s.lastError))
            }
            row
        }
        mapOf("private" to isPrivate(ih), "paused" to !live, "trackers" to rows)
    }

    fun addTrackers(ih: String, text: String): Map<String, Any?> = synchronized(lock) {
        val e = entryOf(ih) ?: throw UserError("That torrent is no longer in your list.")
        val parsed = parseTrackerList(text)
        e.addedTrackers = mergeTrackers(e.addedTrackers, parsed.valid)
        val keys = parsed.valid.map(::trackerKey).toSet()
        e.removedTrackers = e.removedTrackers.filter { trackerKey(it) !in keys }
        applyTrackers(e); saveState()
        mapOf("added" to parsed.valid.size, "invalid" to parsed.invalid)
    }

    fun removeTrackers(ih: String, urls: List<String>): Int = synchronized(lock) {
        val e = entryOf(ih) ?: throw UserError("That torrent is no longer in your list.")
        val keys = urls.map(::trackerKey).toSet()
        e.removedTrackers = mergeTrackers(e.removedTrackers, urls)
        e.addedTrackers = e.addedTrackers.filter { trackerKey(it) !in keys }
        keys.forEach { trackerStatus[ih]?.remove(it) }
        applyTrackers(e); saveState()
        urls.size
    }

    fun removeDeadTrackers(ih: String): Int {
        @Suppress("UNCHECKED_CAST")
        val rows = trackerList(ih)["trackers"] as List<Map<String, Any?>>
        val dead = rows.filter { it["state"] == "failing" || it["state"] == "invalid" }.map { it["url"] as String }
        return if (dead.isEmpty()) 0 else removeTrackers(ih, dead)
    }

    fun setGlobalTrackers(text: String): Map<String, Any?> = synchronized(lock) {
        val parsed = parseTrackerList(text)
        prefs.put("trackers", JSONArray(parsed.valid))
        entries.forEach(::applyTrackers)
        saveState()
        mapOf("trackers" to parsed.valid, "invalid" to parsed.invalid)
    }

    // ---------------------------------------------------------------- files, removal, export

    fun selectFile(ih: String, index: Int, selected: Boolean) = synchronized(lock) {
        val e = entryOf(ih) ?: return@synchronized
        if (selected) e.deselected.remove(index) else if (index !in e.deselected) e.deselected.add(index)
        liveHandle(ih)?.torrentFile()?.let { ti -> handles[ih]!!.prioritizeFiles(priorities(e, ti.numFiles())) }
        saveState(); pushTorrents()
    }

    fun remove(ih: String, deleteData: Boolean) = synchronized(lock) {
        val e = entryOf(ih) ?: return@synchronized
        handles.remove(ih)?.takeIf { it.isValid }?.let { session.remove(it) }
        running -= ih
        trackerStatus.remove(ih); metadataSeen.remove(ih); doneSeen.remove(ih)
        if (deleteData) io.execute { deleteFiles(e) }
        listOf("torrents/$ih.torrent", "posters/$ih.jpg", "resume/$ih.resume").forEach { File(dataDir, it).delete() }
        entries.remove(e)
        if (watching == ih) watching = null
        saveState()
        schedule(null)
    }

    /** Deletes only the files this torrent owns, then empty folders, never escaping the save folder. */
    private fun deleteFiles(e: Entry) {
        Thread.sleep(500) // let libtorrent close its file handles
        val root = File(e.path).canonicalFile
        val dirs = mutableSetOf<File>()
        for (f in e.files) {
            val file = File(root, f.path).canonicalFile
            if (!file.path.startsWith(root.path + File.separator)) continue
            file.delete()
            var d = file.parentFile
            while (d != null && d.path.startsWith(root.path + File.separator)) { dirs += d; d = d.parentFile }
        }
        dirs.sortedByDescending { it.path.length }.forEach { if (it.list()?.isEmpty() == true) it.delete() }
    }

    fun magnetOf(ih: String): String = synchronized(lock) {
        val e = entryOf(ih) ?: throw UserError("Torrent not found.")
        liveHandle(ih)?.makeMagnetUri() ?: e.magnet
    }

    fun torrentFileBytes(ih: String): Pair<String, ByteArray> = synchronized(lock) {
        val e = entryOf(ih) ?: throw UserError("Torrent not found.")
        val f = e.torrentFile?.let(::File)?.takeIf { it.exists() }
            ?: throw UserError("The .torrent file is available once metadata has downloaded.")
        "${e.name.ifEmpty { ih }}.torrent" to f.readBytes()
    }

    // ---------------------------------------------------------------- sharing

    /** `torrent:seedPath`: make a torrent from a file or folder and seed it in place. */
    fun seedPath(p: String, announce: List<String>, comment: String, private: Boolean): Map<String, String> {
        val src = File(p)
        if (!src.exists()) throw UserError("That file or folder no longer exists.")
        val b = org.libtorrent4j.TorrentBuilder().path(src).creator("Magnetic").setPrivate(private)
        if (comment.isNotBlank()) b.comment(comment)
        announce.forEachIndexed { i, u -> b.addTracker(u, i) }
        val bytes = b.generate().entry().bencode()
        val ti = TorrentInfo.bdecode(bytes)
        val ih = ti.infoHash().toHex().lowercase()
        synchronized(lock) {
            entryOf(ih)?.let {
                pushToast("{name} is already in your list.", mapOf("name" to it.name))
                return mapOf("name" to it.name, "magnet" to it.magnet)
            }
            val f = File(dataDir, "torrents/$ih.torrent").apply { writeBytes(bytes) }
            val e = Entry(ih, magnetFor(ti), f.absolutePath, ti.name(), src.parentFile!!.absolutePath, false,
                mutableListOf(), ti.totalSize(), 1.0, emptyList(), System.currentTimeMillis())
            e.notified = true
            e.ownTrackers = mergeTrackers(announce)
            entries.add(0, e)
            saveState()
            schedule(null)
            return mapOf("name" to e.name, "magnet" to e.magnet)
        }
    }

    // ---------------------------------------------------------------- media

    fun source(ih: String, index: Int): FileSource? = synchronized(lock) {
        val e = entryOf(ih) ?: return null
        val h = handles[ih]?.takeIf { it.isValid } ?: return null
        val ti = h.torrentFile() ?: return null
        val fs = ti.files()
        if (index !in 0 until fs.numFiles()) return null
        FileSource(h, File(e.path, fs.filePath(index)), fs.fileName(index), fs.fileSize(index), fs.fileOffset(index),
            ti.pieceLength(), ti.numPieces(), fs.pieceIndexAtFile(index), fs.lastPieceIndexAtFile(index))
    }

    /** `media:stream`: the file's local URL. Re-selects a deselected file and force-starts the torrent. */
    fun stream(ih: String, index: Int): Map<String, Any?> {
        val h = liveReady(ih)
        synchronized(lock) {
            val e = entryOf(ih)!!
            val fs = h.torrentFile()?.files() ?: throw UserError("File not found in this torrent.")
            if (index !in 0 until fs.numFiles()) throw UserError("File not found in this torrent.")
            if (index in e.deselected) selectFile(ih, index, true)
            val name = fs.fileName(index)
            return mapOf("url" to StreamServer.urlFor(ih, index, name), "name" to name,
                "kind" to kindOf(fs.filePath(index)).wire, "mime" to mimeOf(name))
        }
    }

    /** `media:strip`: how much of each stretch of one file is on disk, 0..1 per bucket. */
    fun fileStrip(ih: String, index: Int, buckets: Int): List<Double> = synchronized(lock) {
        val h = liveHandle(ih) ?: return emptyList()
        val ti = h.torrentFile() ?: return emptyList()
        val fs = ti.files()
        if (index !in 0 until fs.numFiles()) return emptyList()
        val bf = h.status(TorrentHandle.QUERY_PIECES).pieces()
        stripFromBitfield({ bf.getBit(it) }, fs.pieceIndexAtFile(index), fs.lastPieceIndexAtFile(index), buckets)
    }

    fun posterFile(ih: String): File? = File(dataDir, "posters/$ih.jpg").takeIf { it.exists() }

    /** The torrent's own poster image (e.g. __ia_thumb.jpg), if it has one. */
    fun torrentPosterIndex(ih: String): Int? = synchronized(lock) {
        val e = entryOf(ih) ?: return null
        val files = liveHandle(ih)?.torrentFile()?.files()?.let { fs -> (0 until fs.numFiles()).map { FileInfo(fs.fileName(it), fs.filePath(it), fs.fileSize(it)) } }
            ?: e.files.map { FileInfo(it.name, it.path, it.length) }
        pickPosterFile(files)
    }

    fun savePoster(ih: String, jpeg: ByteArray) {
        val f = File(dataDir, "posters/$ih.jpg")
        f.writeBytes(jpeg)
        pushTorrents()
    }

    // ---------------------------------------------------------------- snapshot

    fun pushTorrents() {
        val sink = emit ?: return
        sink(mapOf("type" to "torrents") + snapshot())
    }

    fun snapshot(): Map<String, Any?> = synchronized(lock) {
        mapOf(
            "torrents" to entries.map(::snap),
            "totals" to mapOf("down" to session.downloadRate(), "up" to session.uploadRate()),
        )
    }

    private fun posterUrl(e: Entry): String? {
        posterFile(e.infoHash)?.let { return StreamServer.posterUrl(e.infoHash, it.lastModified().toString()) }
        return if (torrentPosterIndex(e.infoHash) != null) StreamServer.posterUrl(e.infoHash, "t") else null
    }

    private fun fileRows(e: Entry, h: TorrentHandle?): List<Map<String, Any?>> {
        val ti = h?.torrentFile()
        if (ti != null) {
            val fs = ti.files()
            val fp = h.fileProgress()
            return (0 until fs.numFiles()).map { i ->
                val len = fs.fileSize(i)
                mapOf("index" to i, "name" to fs.fileName(i), "path" to fs.filePath(i), "length" to len,
                    "progress" to if (len > 0) fp.getOrElse(i) { 0L }.toDouble() / len else 1.0,
                    "selected" to (i !in e.deselected),
                    "kind" to if (fs.padFileAt(i)) FileKind.PADDING.wire else kindOf(fs.filePath(i)).wire)
            }
        }
        return e.files.mapIndexed { i, f ->
            mapOf("index" to i, "name" to f.name, "path" to f.path, "length" to f.length, "progress" to f.progress,
                "selected" to (i !in e.deselected), "kind" to kindOf(f.path).wire)
        }
    }

    private fun snap(e: Entry): Map<String, Any?> {
        val h = liveHandle(e.infoHash)
        val base = mutableMapOf<String, Any?>(
            "infoHash" to e.infoHash, "name" to e.name, "path" to e.path, "files" to fileRows(e, h),
            "length" to e.length, "addedAt" to e.addedAt, "poster" to posterUrl(e), "seedLimitReached" to e.seedLimitReached,
        )
        if (h == null) {
            base += mapOf(
                "status" to when { e.paused -> "paused"; e.length > 0 && e.progress >= 1 -> "done"; e.queued != null -> "queued"; else -> "paused" },
                "queueReason" to e.queued, "progress" to e.progress, "downloadSpeed" to 0, "uploadSpeed" to 0,
                "numPeers" to 0, "timeRemaining" to -1L, "pieces" to emptyList<Double>(),
            )
            return base
        }
        val st = h.status(TorrentHandle.QUERY_PIECES)
        val ready = st.hasMetadata()
        val uploaded = e.uploadedBase + st.totalPayloadUpload()
        val left = st.totalWanted() - st.totalWantedDone()
        val rate = st.downloadPayloadRate()
        val progress = if (ready && st.totalWanted() > 0) st.totalWantedDone().toDouble() / st.totalWanted() else e.progress
        base += mapOf(
            "status" to when { !ready -> "metadata"; st.isFinished -> if (prefs.optBoolean("allowUploads")) "seeding" else "done"; else -> "downloading" },
            "progress" to progress, "downloaded" to st.totalPayloadDownload(), "uploaded" to uploaded,
            "ratio" to if (e.length > 0) uploaded.toDouble() / e.length else 0.0,
            "downloadSpeed" to rate, "uploadSpeed" to st.uploadPayloadRate(), "numPeers" to st.numPeers(),
            "timeRemaining" to if (rate > 0 && left > 0) left * 1000 / rate else -1L,
            "pieces" to if (ready) { val bf = st.pieces(); stripFromBitfield({ bf.getBit(it) }, 0, st.numPieces() - 1, STRIP_BUCKETS) } else emptyList(),
        )
        return base
    }

    // ---------------------------------------------------------------- prefs

    fun setPrefs(patch: Map<String, Any?>): Map<String, Any?> = synchronized(lock) {
        patch.forEach { (k, v) -> prefs.put(k, when (v) { is List<*> -> JSONArray(v); null -> JSONObject.NULL; else -> v }) }
        if (patch.keys.any { it in setOf("downloadLimit", "uploadLimit", "allowUploads") }) applyLimits()
        if ("language" in patch) Strings.resolve(prefs.optString("language"))
        if ("trackersForDownloads" in patch) entries.forEach(::applyTrackers)
        if (patch.keys.any { it in setOf("allowUploads", "maxActiveDownloads", "pauseOthersWhileWatching") }) schedule(null)
        saveState()
        prefsMap()
    }

    fun prefsMap(): Map<String, Any?> = synchronized(lock) {
        @Suppress("UNCHECKED_CAST")
        prefs.toPlain() as Map<String, Any?>
    }

    fun diskFree(dir: String?): Long? = freeSpace(dir ?: prefs.optString("downloadPath"))

    fun appVersion(): String = runCatching { app.packageManager.getPackageInfo(app.packageName, 0).versionName }.getOrNull() ?: "0.1.0"

    fun shutdown() = synchronized(lock) {
        entries.forEach { e -> handles[e.infoHash]?.takeIf { it.isValid }?.saveResumeData(TorrentHandle.SAVE_INFO_DICT) }
        saveStateNow()
    }
}
