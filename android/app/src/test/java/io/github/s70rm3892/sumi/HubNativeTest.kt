package io.github.s70rm3892.sumi

import android.app.Application
import android.app.NotificationManager
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import java.time.LocalDate
import java.util.Locale

@RunWith(RobolectricTestRunner::class)
class HubNativeTest {
    private class FakeEngine : SpeechEngine {
        val said = mutableListOf<Triple<String, Locale, Float>>()
        var stops = 0

        override fun say(text: String, locale: Locale, rate: Float) {
            said += Triple(text, locale, rate)
        }

        override fun stop() {
            stops++
        }

        override fun shutdown() {}
    }

    @Test
    fun speechWaitsForTheEngineAndSpeaksOnlyTheLatestRequest() {
        val engine = FakeEngine()
        var ready: ((Boolean) -> Unit)? = null
        var created = 0
        val s = Speech { onReady ->
            created++
            ready = onReady
            engine
        }
        s.speak("first", "en-US", 1f)
        s.speak("take off", "en-US", 0.8f)
        assertEquals(1, created)
        assertTrue(engine.said.isEmpty())
        ready!!(true)
        assertEquals(listOf(Triple("take off", Locale.US, 0.8f)), engine.said)
        s.speak("離陸する", "ja-JP", 9f) // rate kept in range
        assertEquals(Triple("離陸する", Locale.JAPAN, 2.5f), engine.said.last())
        s.stop()
        assertEquals(1, engine.stops)
    }

    @Test
    fun speechThatCannotStartStaysQuiet() {
        val engine = FakeEngine()
        var ready: ((Boolean) -> Unit)? = null
        val s = Speech { onReady ->
            ready = onReady
            engine
        }
        s.speak("hello", "en-US", 1f)
        ready!!(false)
        s.speak("again", "en-US", 1f)
        assertTrue(engine.said.isEmpty())
    }

    @Test
    fun widgetCountsDownAndForgetsYesterdaysNumbers() {
        val json = JSONObject("""{"exam":"共通テスト","examDate":"2027-01-16","todaySec":5400,"day":"2026-10-26","due":3}""")
        assertEquals(WidgetText("共通テスト まで", "82日", "今日 1時間30分", "復習 3ページ"), CountdownWidget.text(json, LocalDate.parse("2026-10-26")))
        // The next day without opening the app: one day fewer, nothing studied yet.
        assertEquals(WidgetText("共通テスト まで", "81日", "今日 0分", ""), CountdownWidget.text(json, LocalDate.parse("2026-10-27")))
        assertEquals("今日", CountdownWidget.text(json, LocalDate.parse("2027-01-16")).days)
        assertEquals(WidgetText("入試日を設定", "—", "今日 0分", ""), CountdownWidget.text(null, LocalDate.parse("2026-10-26")))
    }

    @Test
    fun dndTurnsOnForTheTimerAndPutsBackTheEarlierSetting() {
        val app = RuntimeEnvironment.getApplication() as Application
        val nm = app.getSystemService(NotificationManager::class.java)
        val dnd = Dnd(app)
        // Not allowed yet: nothing changes.
        dnd.set(true)
        assertEquals(NotificationManager.INTERRUPTION_FILTER_ALL, nm.currentInterruptionFilter)
        shadowOf(nm).setNotificationPolicyAccessGranted(true)
        assertTrue(dnd.allowed())
        dnd.set(true)
        assertEquals(NotificationManager.INTERRUPTION_FILTER_ALARMS, nm.currentInterruptionFilter)
        dnd.set(true) // twice: the original is still what comes back
        dnd.set(false)
        assertEquals(NotificationManager.INTERRUPTION_FILTER_ALL, nm.currentInterruptionFilter)
        // The user switched to something else meanwhile: leave it alone.
        dnd.set(true)
        nm.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_NONE)
        dnd.set(false)
        assertEquals(NotificationManager.INTERRUPTION_FILTER_NONE, nm.currentInterruptionFilter)
    }
}
