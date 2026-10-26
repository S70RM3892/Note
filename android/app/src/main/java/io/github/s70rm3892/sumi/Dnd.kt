package io.github.s70rm3892.sumi

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.provider.Settings

/**
 * おやすみモード while the exam timer runs: notifications stop, alarms still ring. Turning it off
 * puts back what was set before — unless the user changed it in the meantime. The earlier setting
 * is kept on disk, so it comes back even if the app was closed in between.
 */
class Dnd(private val context: Context) {
    private val nm = context.getSystemService(NotificationManager::class.java)
    private val prefs = context.getSharedPreferences("dnd", Context.MODE_PRIVATE)

    /** The user let this app change Do Not Disturb (Settings → 通知 → おやすみモードへのアクセス). */
    fun allowed(): Boolean = nm.isNotificationPolicyAccessGranted

    fun request() {
        context.startActivity(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun set(on: Boolean) {
        if (!allowed()) return
        if (on) {
            if (!prefs.contains(PREV)) prefs.edit().putInt(PREV, nm.currentInterruptionFilter).apply()
            nm.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_ALARMS)
        } else {
            val prev = prefs.getInt(PREV, -1)
            if (prev == -1) return
            if (nm.currentInterruptionFilter == NotificationManager.INTERRUPTION_FILTER_ALARMS) nm.setInterruptionFilter(prev)
            prefs.edit().remove(PREV).apply()
        }
    }

    private companion object {
        const val PREV = "prev"
    }
}
