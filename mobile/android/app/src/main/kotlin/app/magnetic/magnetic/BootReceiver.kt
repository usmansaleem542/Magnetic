package app.magnetic.magnetic

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import app.magnetic.magnetic.engine.Engine

/** Desktop "Open Magnetic when I log in": carry on downloading and seeding after the phone restarts. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        Engine.start(context)
        if (Engine.prefs.optBoolean("openAtLogin")) MagneticService.start(context)
    }
}
