package io.github.s70rm3892.sumi

import android.content.Context
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 診断ログ: crashes and other failures written to the app's files, so that after "it crashed"
 * there is a stack trace to look at. The page lists them (Settings → 診断ログ) and asks about
 * new crashes on the next start.
 */
object CrashLog {
    private const val KEEP = 30

    private fun dir(ctx: Context) = File(ctx.filesDir, "diag").apply { mkdirs() }

    /** Record uncaught exceptions on every thread, then let Android handle them as before. */
    fun install(ctx: Context) {
        val app = ctx.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            runCatching { note(app, "crash", "thread ${t.name}\n${Log.getStackTraceString(e)}") }
            previous?.uncaughtException(t, e)
        }
    }

    /** Write one entry (kind: crash | renderer | wetink | …). Never throws. */
    fun note(ctx: Context, kind: String, text: String) {
        runCatching {
            val now = System.currentTimeMillis()
            val head = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) · ${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"
            File(dir(ctx), "$now-$kind.txt").writeText("$head\n$text")
            val files = dir(ctx).listFiles()?.sortedBy { it.name } ?: return
            files.dropLast(KEEP).forEach { it.delete() }
        }
    }

    /** All entries, oldest first: JSON [{at, kind, text}]. */
    fun list(ctx: Context): String {
        val out = JSONArray()
        runCatching {
            dir(ctx).listFiles()?.sortedBy { it.name }?.forEach { f ->
                val at = f.name.substringBefore('-').toLongOrNull() ?: return@forEach
                val kind = f.name.substringAfter('-').removeSuffix(".txt")
                out.put(JSONObject().put("at", at).put("kind", kind).put("text", f.readText().take(20_000)))
            }
        }
        return out.toString()
    }

    fun clear(ctx: Context) {
        runCatching { dir(ctx).listFiles()?.forEach { it.delete() } }
    }
}
