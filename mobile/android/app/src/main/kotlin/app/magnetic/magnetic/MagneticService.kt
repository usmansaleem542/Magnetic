package app.magnetic.magnetic

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import app.magnetic.magnetic.engine.Engine
import app.magnetic.magnetic.engine.Notifications

/**
 * Keeps the engine downloading and seeding after you leave the app: the Android counterpart of
 * the desktop's "keep running in the tray" (pref closeToTray).
 */
class MagneticService : Service() {
    companion object {
        const val PAUSE_ALL = "pauseAll"
        const val RESUME_ALL = "resumeAll"
        const val QUIT = "quit"
        @Volatile var runningInstance: MagneticService? = null

        fun start(c: Context) {
            if (runningInstance != null) return
            runCatching { ContextCompat.startForegroundService(c, Intent(c, MagneticService::class.java)) }
        }

        fun stop(c: Context) { c.stopService(Intent(c, MagneticService::class.java)) }
    }

    private var lastCount = -1

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        runningInstance = this
        Engine.start(this)
        Notifications.createChannels(this)
        ServiceCompat.startForeground(
            this, Notifications.SERVICE_ID, Notifications.service(this, 0),
            if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0,
        )
        Engine.onActivity = { downloading, _ ->
            if (downloading != lastCount) {
                lastCount = downloading
                runCatching { NotificationManagerCompat.from(this).notify(Notifications.SERVICE_ID, Notifications.service(this, downloading)) }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            PAUSE_ALL -> Engine.io.execute { Engine.pauseAll() }
            RESUME_ALL -> Engine.io.execute { Engine.resumeAll() }
            QUIT -> {
                Engine.shutdown()
                stopSelf()
                MainActivity.current?.finishAndRemoveTask()
                android.os.Process.killProcess(android.os.Process.myPid())
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        Engine.onActivity = null
        runningInstance = null
        super.onDestroy()
    }
}
