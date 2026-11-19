package app.magnetic.magnetic.engine

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.magnetic.magnetic.MagneticService
import app.magnetic.magnetic.MainActivity
import app.magnetic.magnetic.R

object Notifications {
    const val CHANNEL_DONE = "done"
    const val CHANNEL_SERVICE = "background"
    const val SERVICE_ID = 1

    fun createChannels(c: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = c.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_DONE, Strings.t("Download complete"), NotificationManager.IMPORTANCE_DEFAULT))
        nm.createNotificationChannel(NotificationChannel(CHANNEL_SERVICE, "Magnetic", NotificationManager.IMPORTANCE_LOW))
    }

    private fun openApp(c: Context) = PendingIntent.getActivity(
        c, 0, Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun canPost(c: Context) = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Desktop: title "Download complete", body = torrent name. */
    fun downloadComplete(c: Context, name: String) {
        if (!canPost(c)) return
        val n = NotificationCompat.Builder(c, CHANNEL_DONE)
            .setSmallIcon(R.drawable.ic_stat_magnetic)
            .setContentTitle(Strings.t("Download complete"))
            .setContentText(name)
            .setContentIntent(openApp(c))
            .setAutoCancel(true)
            .build()
        runCatching { NotificationManagerCompat.from(c).notify(name.hashCode(), n) }
    }

    /** The background notification (the desktop tray): "Magnetic: {n} downloading", Pause all / Resume all / Quit. */
    fun service(c: Context, downloading: Int): android.app.Notification {
        val action = { a: String, code: Int ->
            PendingIntent.getService(c, code, Intent(c, MagneticService::class.java).setAction(a), PendingIntent.FLAG_IMMUTABLE)
        }
        val text = if (downloading > 0) Strings.t("Magnetic: {n} downloading", mapOf("n" to downloading)) else "Magnetic"
        return NotificationCompat.Builder(c, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_magnetic)
            .setContentTitle(text)
            .setContentIntent(openApp(c))
            .setOngoing(true)
            .setSilent(true)
            .addAction(0, Strings.t("Pause all"), action(MagneticService.PAUSE_ALL, 1))
            .addAction(0, Strings.t("Resume all"), action(MagneticService.RESUME_ALL, 2))
            .addAction(0, Strings.t("Quit"), action(MagneticService.QUIT, 3))
            .build()
    }
}
