package io.github.s70rm3892.sumi

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import org.json.JSONObject
import java.time.LocalDate
import java.time.temporal.ChronoUnit

/** What the widget shows. */
data class WidgetText(val exam: String, val days: String, val today: String, val due: String)

/**
 * ホーム画面のウィジェット: days to the next exam, today's writing time, pages due for review.
 * The page sends the numbers whenever the library opens; the days count down by themselves.
 */
class CountdownWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        render(context, manager, ids)
    }

    companion object {
        private const val PREFS = "widget"

        /** From the page's JSON {exam, examDate, todaySec, day, due} and today's date. */
        fun text(json: JSONObject?, today: LocalDate): WidgetText {
            val exam = json?.optString("exam").orEmpty()
            val date = runCatching { LocalDate.parse(json?.optString("examDate")) }.getOrNull()
            val days = if (date == null) null else ChronoUnit.DAYS.between(today, date)
            val sameDay = json?.optString("day") == today.toString()
            val sec = if (sameDay) json!!.optLong("todaySec") else 0L
            val min = sec / 60
            val studied = if (min < 60) "${min}分" else "${min / 60}時間${if (min % 60 > 0) "${min % 60}分" else ""}"
            val due = if (sameDay) json!!.optInt("due") else null
            return WidgetText(
                exam = if (days == null || days < 0) "入試日を設定" else "$exam まで",
                days = when {
                    days == null || days < 0 -> "—"
                    days == 0L -> "今日"
                    else -> "${days}日"
                },
                today = "今日 $studied",
                due = if (due == null) "" else "復習 ${due}ページ",
            )
        }

        fun save(context: Context, json: String) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("data", json).apply()
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, CountdownWidget::class.java))
            if (ids.isNotEmpty()) render(context, manager, ids)
        }

        private fun render(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("data", null)
            val t = text(raw?.let { runCatching { JSONObject(it) }.getOrNull() }, LocalDate.now())
            val open = PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            for (id in ids) {
                val v = RemoteViews(context.packageName, R.layout.widget_countdown)
                v.setTextViewText(R.id.widget_exam, t.exam)
                v.setTextViewText(R.id.widget_days, t.days)
                v.setTextViewText(R.id.widget_today, t.today)
                v.setTextViewText(R.id.widget_due, t.due)
                v.setOnClickPendingIntent(R.id.widget_root, open)
                manager.updateAppWidget(id, v)
            }
        }
    }
}
