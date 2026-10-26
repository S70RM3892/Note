package io.github.s70rm3892.sumi

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar
import java.util.TimeZone

/** A daily notification at hour:minute (就寝・復習). `text` is shown once, `repeatText` on later days. */
data class Reminder(val id: Int, val hour: Int, val minute: Int, val title: String, val text: String, val repeatText: String) {
    fun toJson(): JSONObject = JSONObject().put("id", id).put("h", hour).put("m", minute).put("title", title).put("text", text).put("repeatText", repeatText)

    companion object {
        fun fromJson(o: JSONObject): Reminder {
            val text = o.optString("text")
            return Reminder(o.getInt("id"), o.getInt("h").coerceIn(0, 23), o.getInt("m").coerceIn(0, 59), o.optString("title"), text, o.optString("repeatText", text))
        }
    }
}

/**
 * Daily reminders with inexact alarms (AlarmManager.setWindow: no exact-alarm permission). On
 * Android 12+ the window is at least 10 minutes, so it opens a little before the time asked for:
 * a bedtime reminder a few minutes early is fine, half an hour late is not. Alarms don't survive a
 * reboot, so [BootReceiver] schedules them again from the stored list.
 */
object Reminders {
    const val CHANNEL = "reminders"
    private const val CHANNEL_NAME = "就寝・復習のお知らせ"
    const val EXTRA_ID = "reminder"
    private const val PREFS = "reminders"
    private const val KEY = "list"
    const val WINDOW_MS = 10 * 60_000L
    const val LEAD_MS = 5 * 60_000L
    private const val DAY_MS = 24 * 3600_000L

    fun parse(json: String): List<Reminder> {
        val a = JSONArray(json)
        return (0 until a.length()).map { Reminder.fromJson(a.getJSONObject(it)) }
    }

    fun toJson(list: List<Reminder>): String = JSONArray().apply { list.forEach { put(it.toJson()) } }.toString()

    /** The next hour:minute strictly after `now`. */
    fun nextTrigger(now: Long, hour: Int, minute: Int, zone: TimeZone = TimeZone.getDefault()): Long {
        val c = Calendar.getInstance(zone)
        c.timeInMillis = now
        c.set(Calendar.HOUR_OF_DAY, hour)
        c.set(Calendar.MINUTE, minute)
        c.set(Calendar.SECOND, 0)
        c.set(Calendar.MILLISECOND, 0)
        if (c.timeInMillis <= now) c.add(Calendar.DAY_OF_YEAR, 1)
        return c.timeInMillis
    }

    /** Start of the alarm window for the next occurrence: a little early, never in the past. */
    fun windowStart(now: Long, r: Reminder, zone: TimeZone = TimeZone.getDefault()): Long = maxOf(now + 1000, nextTrigger(now, r.hour, r.minute, zone) - LEAD_MS)

    /**
     * Where to schedule from once `r` has fired at `now`: just past the occurrence that fired. The
     * window opens [LEAD_MS] early and can be deferred (even past midnight), so that occurrence is
     * the latest hour:minute at or before now + LEAD_MS.
     */
    fun afterFiring(now: Long, r: Reminder, zone: TimeZone = TimeZone.getDefault()): Long {
        val occurrence = nextTrigger(now + LEAD_MS - DAY_MS, r.hour, r.minute, zone)
        return maxOf(now, occurrence + 60_000)
    }

    fun load(ctx: Context): List<Reminder> = runCatching { parse(prefs(ctx).getString(KEY, "[]") ?: "[]") }.getOrDefault(emptyList())

    private fun save(ctx: Context, list: List<Reminder>) = prefs(ctx).edit().putString(KEY, toJson(list)).apply()

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Replace every reminder: cancel the old alarms, store and schedule the new list. */
    fun set(ctx: Context, list: List<Reminder>, now: Long = System.currentTimeMillis()) {
        load(ctx).forEach { alarms(ctx).cancel(pending(ctx, it.id)) }
        save(ctx, list)
        list.forEach { schedule(ctx, it, now) }
    }

    fun rescheduleAll(ctx: Context, now: Long = System.currentTimeMillis()) = load(ctx).forEach { schedule(ctx, it, now) }

    private fun schedule(ctx: Context, r: Reminder, now: Long) {
        alarms(ctx).setWindow(AlarmManager.RTC_WAKEUP, windowStart(now, r), WINDOW_MS, pending(ctx, r.id))
    }

    /** The alarm went off: show the notification and set up tomorrow's. */
    fun fire(ctx: Context, id: Int, now: Long = System.currentTimeMillis()) {
        val list = load(ctx)
        val r = list.find { it.id == id } ?: return
        notify(ctx, r)
        // Counts in `text` were right when the page scheduled it; later days get the general text
        // until the page is opened again and reschedules.
        val next = r.copy(text = r.repeatText)
        save(ctx, list.map { if (it.id == id) next else it })
        schedule(ctx, next, afterFiring(now, r))
    }

    fun allowed(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        return NotificationManagerCompat.from(ctx).areNotificationsEnabled()
    }

    private fun notify(ctx: Context, r: Reminder) {
        if (!allowed(ctx)) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(
            ctx,
            0,
            Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_reminder)
            .setContentTitle(r.title)
            .setContentText(r.text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(r.text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        nm.notify(r.id, n)
    }

    private fun alarms(ctx: Context) = ctx.getSystemService(AlarmManager::class.java)

    private fun pending(ctx: Context, id: Int): PendingIntent = PendingIntent.getBroadcast(
        ctx,
        id,
        Intent(ctx, ReminderReceiver::class.java).putExtra(EXTRA_ID, id),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}

/** The alarms themselves (not exported: only our PendingIntents reach it). */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getIntExtra(Reminders.EXTRA_ID, -1)
        if (id >= 0) Reminders.fire(context, id)
    }
}

/** After a reboot or an app update the alarms are gone: set them again. Only reschedules, so it is harmless if anything else calls it. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) Reminders.rescheduleAll(context)
    }
}
