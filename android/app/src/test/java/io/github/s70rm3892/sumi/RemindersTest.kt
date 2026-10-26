package io.github.s70rm3892.sumi

import android.Manifest
import android.app.AlarmManager
import android.app.Application
import android.app.NotificationManager
import android.content.Intent
import org.robolectric.RuntimeEnvironment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import java.util.Calendar
import java.util.TimeZone

@RunWith(RobolectricTestRunner::class)
class RemindersTest {
    private val tokyo = TimeZone.getTimeZone("Asia/Tokyo")
    private lateinit var app: Application

    private fun at(day: Int, h: Int, m: Int): Long = Calendar.getInstance(tokyo).apply {
        clear()
        set(2026, Calendar.OCTOBER, day, h, m, 0)
    }.timeInMillis

    private val bed = Reminder(1, 23, 0, "寝る時間", "23:00。寝ろ。", "23:00。寝ろ。")
    private val review = Reminder(2, 19, 0, "今日の復習", "今日の復習 5 ページ", "今日の復習をやろう")

    @Before
    fun setUp() {
        TimeZone.setDefault(tokyo)
        app = RuntimeEnvironment.getApplication()
    }

    @Test
    fun nextOccurrenceAndEarlyWindow() {
        assertEquals(at(26, 23, 0), Reminders.nextTrigger(at(26, 22, 0), 23, 0, tokyo))
        assertEquals(at(27, 23, 0), Reminders.nextTrigger(at(26, 23, 0), 23, 0, tokyo))
        assertEquals(at(27, 23, 0), Reminders.nextTrigger(at(26, 23, 30), 23, 0, tokyo))
        // The window opens 5 minutes early.
        assertEquals(at(26, 22, 55), Reminders.windowStart(at(26, 20, 0), bed, tokyo))
        // …but never in the past.
        assertEquals(at(26, 22, 58) + 1000, Reminders.windowStart(at(26, 22, 58), bed, tokyo))
    }

    @Test
    fun afterFiringSchedulesTheNextDayEvenWhenEarlyOrDeferred() {
        // Fired early (window opened 22:55): tomorrow, not again tonight.
        assertEquals(at(27, 22, 55), Reminders.windowStart(Reminders.afterFiring(at(26, 22, 57), bed, tokyo), bed, tokyo))
        // Fired late, inside the window.
        assertEquals(at(27, 22, 55), Reminders.windowStart(Reminders.afterFiring(at(26, 23, 8), bed, tokyo), bed, tokyo))
        // Deferred past midnight (Doze): tonight's is still ahead and must not be skipped.
        assertEquals(at(27, 22, 55), Reminders.windowStart(Reminders.afterFiring(at(27, 1, 0), bed, tokyo), bed, tokyo))
    }

    @Test
    fun parsesTheJsonThePageSends() {
        val list = Reminders.parse("""[{"id":1,"h":23,"m":0,"title":"寝る時間","text":"寝ろ"},{"id":2,"h":25,"m":-3,"title":"t","text":"a","repeatText":"b"}]""")
        assertEquals(listOf(1, 2), list.map { it.id })
        assertEquals("寝ろ", list[0].repeatText) // defaults to the text
        assertEquals(23, list[1].hour) // clamped
        assertEquals(0, list[1].minute)
        assertEquals(list, Reminders.parse(Reminders.toJson(list)))
    }

    @Test
    fun schedulesFiresNotifiesAndReschedules() {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val am = shadowOf(app.getSystemService(AlarmManager::class.java))
        Reminders.set(app, listOf(bed, review), now = at(26, 18, 0))
        val alarms = am.scheduledAlarms.sortedBy { it.triggerAtMs }
        assertEquals(listOf(at(26, 18, 55), at(26, 22, 55)), alarms.map { it.triggerAtMs })
        assertTrue(alarms.all { it.windowLengthMs == Reminders.WINDOW_MS })

        // The review alarm goes off: a notification with the count, tomorrow's set with the general text.
        val intent = Intent(app, ReminderReceiver::class.java).putExtra(Reminders.EXTRA_ID, 2)
        Reminders.fire(app, intent.getIntExtra(Reminders.EXTRA_ID, -1), now = at(26, 18, 58))
        val nm = shadowOf(app.getSystemService(NotificationManager::class.java))
        assertEquals(1, nm.allNotifications.size)
        assertEquals("今日の復習 5 ページ", shadowOf(nm.allNotifications[0]).contentText)
        assertEquals(at(27, 18, 55), am.scheduledAlarms.filter { it.operation == alarms[0].operation }.maxOf { it.triggerAtMs })
        assertEquals("今日の復習をやろう", Reminders.load(app).first { it.id == 2 }.text)

        // Replacing the list cancels what is no longer wanted.
        Reminders.set(app, listOf(bed), now = at(26, 19, 30))
        assertEquals(1, am.scheduledAlarms.size)
    }

    @Test
    fun bootReschedulesFromTheStoredList() {
        Reminders.set(app, listOf(bed), now = at(26, 18, 0))
        val am = shadowOf(app.getSystemService(AlarmManager::class.java))
        am.scheduledAlarms.toList().forEach { app.getSystemService(AlarmManager::class.java).cancel(it.operation!!) }
        assertEquals(0, am.scheduledAlarms.size)
        BootReceiver().onReceive(app, Intent(Intent.ACTION_BOOT_COMPLETED))
        assertEquals(1, am.scheduledAlarms.size)
        BootReceiver().onReceive(app, Intent("something.else"))
        assertEquals(1, am.scheduledAlarms.size)
    }
}
