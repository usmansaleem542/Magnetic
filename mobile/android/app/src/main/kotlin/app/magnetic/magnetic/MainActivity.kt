package app.magnetic.magnetic

import android.Manifest
import android.app.PictureInPictureParams
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Rational
import android.view.WindowManager
import app.magnetic.magnetic.engine.Cast
import app.magnetic.magnetic.engine.Engine
import app.magnetic.magnetic.engine.MediaOps
import app.magnetic.magnetic.engine.Playback
import app.magnetic.magnetic.engine.UserError
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.io.File

/**
 * Hosts the Flutter UI and bridges it to the engine. Method names match the desktop app's IPC
 * channels (web-app/preload.cjs → main.js), so the UI code maps one-to-one.
 */
class MainActivity : FlutterActivity() {
    companion object { @Volatile var current: MainActivity? = null }

    private val mainThread = Handler(Looper.getMainLooper())
    private var events: EventChannel.EventSink? = null
    private val pendingOpens = mutableListOf<String>()
    private var pipAspect = Rational(16, 9)
    private var playing = false

    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        current = this
        Engine.start(this)
        if (Engine.prefs.optBoolean("closeToTray", true)) MagneticService.start(this)
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onDestroy() {
        if (current == this) current = null
        Engine.emit = null
        Playback.clear(this)
        if (!Engine.prefs.optBoolean("closeToTray", true) && isFinishing) Engine.shutdown()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ intents (desktop: argv / open-url)

    private fun handleIntent(intent: Intent?) {
        val id = when (intent?.action) {
            Intent.ACTION_VIEW -> intent.data?.let { uri ->
                if (uri.scheme.equals("magnet", true)) uri.toString() else copyTorrent(uri)
            }
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)?.let { text ->
                Regex("""magnet:\?\S+""", RegexOption.IGNORE_CASE).find(text)?.value ?: text.trim().takeIf { Regex("^[0-9a-fA-F]{40}$").matches(it) }
            } ?: (intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))?.let(::copyTorrent)
            else -> null
        } ?: return
        intent?.action = null
        val sink = events
        if (sink != null) sink.success(mapOf("type" to "open", "id" to id)) else pendingOpens += id
    }

    /** .torrent from another app: content:// can't be read later, so copy it now. */
    private fun copyTorrent(uri: Uri): String? = runCatching {
        if (uri.scheme == "file") return@runCatching uri.path
        val f = File(cacheDir, "incoming-${System.currentTimeMillis()}.torrent")
        contentResolver.openInputStream(uri)!!.use { input -> f.outputStream().use { input.copyTo(it) } }
        f.absolutePath
    }.getOrNull()

    // ------------------------------------------------------------------ channels

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        EventChannel(flutterEngine.dartExecutor.binaryMessenger, "magnetic/events").setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(arguments: Any?, sink: EventChannel.EventSink) {
                events = sink
                Engine.emit = { e -> mainThread.post { events?.success(e) } }
                Playback.onAction = { a -> mainThread.post { events?.success(mapOf("type" to "media", "action" to a)) } }
                Engine.pushTorrents()
            }
            override fun onCancel(arguments: Any?) { events = null; Engine.emit = null }
        })
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "magnetic/api").setMethodCallHandler { call, result ->
            val args = (call.arguments as? List<*>) ?: emptyList<Any?>()
            Engine.io.execute {
                try {
                    val value = dispatch(call.method, args).let { if (it is Unit) null else it } // Flutter can't encode Unit
                    mainThread.post { result.success(value) }
                } catch (e: UserError) {
                    mainThread.post { result.error("user", e.key, e.vars) }
                } catch (e: NotImplementedError) {
                    mainThread.post { result.notImplemented() }
                } catch (e: Throwable) {
                    mainThread.post { result.error("internal", e.message ?: e.toString(), null) }
                }
            }
        }
    }

    private fun <T> onUi(block: () -> T): T {
        var r: Result<T>? = null
        val latch = java.util.concurrent.CountDownLatch(1)
        mainThread.post { r = runCatching(block); latch.countDown() }
        latch.await()
        return r!!.getOrThrow()
    }

    @Suppress("UNCHECKED_CAST")
    private fun dispatch(method: String, a: List<Any?>): Any? {
        fun s(i: Int) = a[i] as String
        fun n(i: Int) = (a[i] as Number).toInt()
        fun d(i: Int) = (a[i] as Number).toDouble()
        fun b(i: Int) = a[i] as Boolean
        return when (method) {
            "torrents:list" -> Engine.snapshot()
            "torrent:add" -> Engine.add(s(0), a.getOrNull(1) as String?, a.getOrNull(2) == true)
            "torrent:addPaths" -> (a[0] as List<String>).map { runCatching { Engine.add(it) }.getOrNull() }
            "torrent:pause" -> Engine.pauseTorrent(s(0))
            "torrent:resume" -> Engine.resumeTorrent(s(0))
            "torrent:pauseAll" -> Engine.pauseAll()
            "torrent:resumeAll" -> Engine.resumeAll()
            "torrent:remove" -> Engine.remove(s(0), b(1))
            "torrent:selectFile" -> Engine.selectFile(s(0), n(1), b(2))
            "torrent:magnet" -> Engine.magnetOf(s(0))
            "torrent:saveFile" -> {
                val (name, bytes) = Engine.torrentFileBytes(s(0))
                val f = File(s(1), name.replace('/', '_'))
                f.writeBytes(bytes); f.absolutePath
            }
            "torrent:seedPath" -> {
                val o = a[1] as Map<String, Any?>
                Engine.seedPath(s(0), (o["announce"] as? List<String>).orEmpty(), o["comment"] as? String ?: "", o["private"] == true)
            }
            "torrent:defaultTrackers" -> Engine.prefsMap()["trackers"].let { (it as? List<*>)?.takeIf { l -> l.isNotEmpty() } ?: app.magnetic.magnetic.core.DEFAULT_TRACKERS }
            "trackers:list" -> Engine.trackerList(s(0))
            "trackers:add" -> Engine.addTrackers(s(0), s(1))
            "trackers:remove" -> Engine.removeTrackers(s(0), a[1] as List<String>)
            "trackers:removeDead" -> Engine.removeDeadTrackers(s(0))
            "trackers:defaults" -> app.magnetic.magnetic.core.DEFAULT_TRACKERS
            "prefs:setTrackers" -> Engine.setGlobalTrackers(s(0))
            "prefs:get" -> Engine.prefsMap()
            "prefs:set" -> {
                val patch = a[0] as Map<String, Any?>
                val r = Engine.setPrefs(patch)
                if ("closeToTray" in patch) onUi { if (patch["closeToTray"] == true) MagneticService.start(this) else MagneticService.stop(this) }
                r
            }
            "disk:free" -> Engine.diskFree(a.getOrNull(0) as String?)
            "media:stream" -> Engine.stream(s(0), n(1))
            "media:strip" -> Engine.fileStrip(s(0), n(1), n(2))
            "media:metadata" -> MediaOps.metadata(s(0), n(1))
            "media:savePoster" -> MediaOps.savePoster(s(0), a[1] as ByteArray)
            "media:subtitle" -> MediaOps.torrentSubtitle(s(0), n(1), (a.getOrNull(2) as String?) ?: "auto")
            "media:subtitleFile" -> MediaOps.diskSubtitle(s(0), (a.getOrNull(1) as String?) ?: "auto")
            "media:external" -> openExternal(s(0), n(1))
            "subs:encodings" -> MediaOps.encodings()
            "subs:hash" -> MediaOps.hash(s(0), n(1))
            "player:watching" -> Engine.setWatching(a.getOrNull(0) as String?)
            "player:playing" -> onUi {
                playing = b(0)
                if (playing) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                updatePip()
            }
            "player:aspect" -> onUi {
                val r = d(0)
                pipAspect = if (r > 0) Rational((r.coerceIn(0.42, 2.38) * 1000).toInt(), 1000) else Rational(16, 9)
                updatePip()
            }
            "player:pip" -> onUi { enterPip() }
            "player:session" -> { Playback.update(this, a[0] as Map<String, Any?>); null }
            "player:sessionClear" -> { Playback.clear(this); null }
            "cast:list" -> Cast.list(this)
            "cast:play" -> Cast.play(this, s(0), s(1), n(2), d(3), a.getOrNull(4) as String?)
            "cast:status" -> Cast.status(this)
            "cast:pause" -> Cast.pause(this)
            "cast:resume" -> Cast.resume(this)
            "cast:seek" -> Cast.seek(this, d(0))
            "cast:stop" -> { Cast.stop(this); StreamServer.closeLan() }
            "app:info" -> mapOf("version" to Engine.appVersion(), "platform" to "android", "webrtc" to false, "tray" to true, "packaged" to true)
            "app:pendingOpens" -> synchronized(pendingOpens) { pendingOpens.toList().also { pendingOpens.clear() } }
            "app:storage" -> storageStatus()
            "app:requestStorage" -> onUi { requestStorage() }
            "app:requestNotifications" -> onUi { if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7) }
            "app:openUrl" -> onUi { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(s(0))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            "app:quit" -> onUi { Engine.shutdown(); MagneticService.stop(this); finishAndRemoveTask(); android.os.Process.killProcess(android.os.Process.myPid()) }
            "prefs:isDefaultHandler" -> isDefaultHandler()
            "prefs:makeDefaultHandler" -> onUi { openDefaultsSettings(); true }
            else -> throw NotImplementedError(method)
        }
    }

    // ------------------------------------------------------------------ helpers

    private fun storageStatus(): Map<String, Any?> = mapOf(
        "allFiles" to (Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()),
        "root" to Environment.getExternalStorageDirectory().absolutePath,
        "downloads" to Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS).absolutePath,
    )

    private fun requestStorage() {
        if (Build.VERSION.SDK_INT >= 30) {
            runCatching { startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName"))) }
                .onFailure { startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
        } else {
            requestPermissions(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE), 8)
        }
    }

    private fun isDefaultHandler(): Boolean {
        val r = packageManager.resolveActivity(Intent(Intent.ACTION_VIEW, Uri.parse("magnet:?xt=urn:btih:0")), 0)
        return r?.activityInfo?.packageName == packageName
    }

    private fun openDefaultsSettings() {
        val intent = if (Build.VERSION.SDK_INT >= 31) Intent(Settings.ACTION_APP_OPEN_BY_DEFAULT_SETTINGS, Uri.parse("package:$packageName"))
        else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
        startActivity(intent)
    }

    /** Desktop opened VLC or a chosen app; Android hands the stream to a video app. */
    private fun openExternal(ih: String, index: Int) {
        val info = Engine.stream(ih, index)
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(info["url"] as String), info["mime"] as String)
            .putExtra("title", info["name"] as String).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pref = Engine.prefs.optString("externalPlayer")
        onUi {
            if (pref == "vlc") {
                val vlc = Intent(intent).setPackage("org.videolan.vlc")
                if (vlc.resolveActivity(packageManager) == null) throw UserError("VLC wasn't found. Install it from videolan.org, or choose another player in Preferences.")
                startActivity(vlc)
            } else {
                startActivity(Intent.createChooser(intent, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }
    }

    private fun pipParams(): PictureInPictureParams? {
        if (Build.VERSION.SDK_INT < 26) return null
        val b = PictureInPictureParams.Builder().setAspectRatio(pipAspect)
        if (Build.VERSION.SDK_INT >= 31) b.setAutoEnterEnabled(playing).setSeamlessResizeEnabled(true)
        return b.build()
    }

    private fun updatePip() { if (Build.VERSION.SDK_INT >= 26) pipParams()?.let { runCatching { setPictureInPictureParams(it) } } }

    private fun enterPip() { if (Build.VERSION.SDK_INT >= 26) pipParams()?.let { runCatching { enterPictureInPictureMode(it) } } }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (playing && Build.VERSION.SDK_INT in 26..30) enterPip()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        events?.success(mapOf("type" to "pip", "active" to isInPictureInPictureMode))
    }
}
