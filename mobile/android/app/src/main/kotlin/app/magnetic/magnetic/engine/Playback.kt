package app.magnetic.magnetic.engine

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.graphics.BitmapFactory
import android.os.Build
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.media.app.NotificationCompat.MediaStyle
import app.magnetic.magnetic.R

/**
 * Lock-screen / headset / notification controls for what's playing (desktop: navigator.mediaSession).
 * Actions go back to the Flutter player as {type: 'media', action}.
 */
object Playback {
    private const val CHANNEL = "playback"
    private const val ID = 2
    private var session: MediaSessionCompat? = null
    @Volatile var onAction: ((String) -> Unit)? = null

    private fun session(c: Context): MediaSessionCompat = session ?: MediaSessionCompat(c, "Magnetic").also { s ->
        s.setCallback(object : MediaSessionCompat.Callback() {
            override fun onPlay() { onAction?.invoke("play") }
            override fun onPause() { onAction?.invoke("pause") }
            override fun onSkipToNext() { onAction?.invoke("next") }
            override fun onSkipToPrevious() { onAction?.invoke("previous") }
            override fun onFastForward() { onAction?.invoke("forward") }
            override fun onRewind() { onAction?.invoke("backward") }
            override fun onSeekTo(pos: Long) { onAction?.invoke("seek:${pos / 1000.0}") }
        })
        s.isActive = true
        session = s
    }

    /** {title, artist, album, art (bytes?), playing, position (s), duration (s), hasPrev, hasNext} */
    fun update(c: Context, m: Map<String, Any?>) {
        val s = session(c)
        val art = (m["art"] as? ByteArray)?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
        s.setMetadata(MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, m["title"] as? String ?: "")
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, m["artist"] as? String ?: "")
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, m["album"] as? String ?: "")
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, (((m["duration"] as? Number)?.toDouble() ?: 0.0) * 1000).toLong())
            .apply { if (art != null) putBitmap(MediaMetadataCompat.METADATA_KEY_ART, art) }
            .build())
        val playing = m["playing"] == true
        var actions = PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
            PlaybackStateCompat.ACTION_SEEK_TO or PlaybackStateCompat.ACTION_FAST_FORWARD or PlaybackStateCompat.ACTION_REWIND
        if (m["hasPrev"] == true) actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
        if (m["hasNext"] == true) actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_NEXT
        s.setPlaybackState(PlaybackStateCompat.Builder().setActions(actions)
            .setState(if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
                (((m["position"] as? Number)?.toDouble() ?: 0.0) * 1000).toLong(), if (playing) 1f else 0f)
            .build())

        if (Build.VERSION.SDK_INT >= 26) {
            c.getSystemService(NotificationManager::class.java)
                .createNotificationChannel(NotificationChannel(CHANNEL, Strings.t("Now playing"), NotificationManager.IMPORTANCE_LOW))
        }
        val n = NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_magnetic)
            .setContentTitle(m["title"] as? String ?: "")
            .setContentText(listOf(m["artist"], m["album"]).filterIsInstance<String>().filter { it.isNotEmpty() }.joinToString(", "))
            .setLargeIcon(art)
            .setOngoing(playing)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setStyle(MediaStyle().setMediaSession(s.sessionToken))
            .build()
        runCatching { NotificationManagerCompat.from(c).notify(ID, n) }
    }

    fun clear(c: Context) {
        session?.let { it.isActive = false; it.release() }
        session = null
        runCatching { NotificationManagerCompat.from(c).cancel(ID) }
    }
}
