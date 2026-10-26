package io.github.s70rm3892.sumi

import android.net.Uri
import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.File
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * `window.SumiNative` (see src/platform.ts). Methods run on the WebView's bridge thread;
 * anything touching UI is posted to the main thread by [MainActivity].
 */
class NativeBridge(private val activity: MainActivity) {
    private class PendingFile(val name: String, val mime: String, val file: File, val out: OutputStream)

    private val files = ConcurrentHashMap<String, PendingFile>()
    private val outDir: File by lazy { File(activity.cacheDir, "outgoing").apply { mkdirs() } }

    @JavascriptInterface
    fun version(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun hasScanner(): Boolean = activity.hasScanner()

    @JavascriptInterface
    fun scanDocument(pageLimit: Int) = activity.startScan(pageLimit)

    @JavascriptInterface
    fun beginFile(name: String, mime: String): String {
        val id = UUID.randomUUID().toString()
        val f = File(outDir, id)
        files[id] = PendingFile(name, mime, f, f.outputStream().buffered(1 shl 16))
        return id
    }

    @JavascriptInterface
    fun appendFile(id: String, base64: String) {
        files[id]?.out?.write(Base64.decode(base64, Base64.DEFAULT))
    }

    @JavascriptInterface
    fun finishFile(id: String, action: String) {
        val p = files.remove(id)
        if (p == null) {
            activity.callJsWithJson("onFileDone", JSONObject().put("ok", false))
            return
        }
        p.out.close()
        when (action) {
            "share" -> activity.shareFile(p.file, p.name, p.mime)
            "backup" -> activity.writeBackup(p.file, p.name)
            else -> activity.saveFile(p.file, p.name, p.mime)
        }
    }

    @JavascriptInterface
    fun openUrl(url: String) {
        val uri = Uri.parse(url)
        if (uri.scheme == "https" || uri.scheme == "http" || uri.scheme == "mailto") activity.openExternal(uri)
    }

    @JavascriptInterface
    fun setKeepScreenOn(on: Boolean) = activity.setKeepScreenOn(on)

    @JavascriptInterface
    fun takeIncoming(): String = activity.takeIncoming()

    /** The launcher shortcut the app was opened with ("" = none). */
    @JavascriptInterface
    fun takeShortcut(): String = activity.takeShortcut()

    @JavascriptInterface
    fun backupFolder(): String = activity.backupFolderName()

    @JavascriptInterface
    fun pickBackupFolder() = activity.pickBackupFolder()

    @JavascriptInterface
    fun setFocusLock(on: Boolean) = activity.setFocusLock(on)

    @JavascriptInterface
    fun inkStatus(): String = activity.ink.status

    @JavascriptInterface
    fun inkDownload() = activity.runOnUiThread { activity.ink.download() }

    @JavascriptInterface
    fun recognizeInk(json: String) = activity.runOnUiThread { activity.ink.recognize(json) }

    /** Low-latency wet ink: where and how the pen draws (JSON, see WetParams). */
    @JavascriptInterface
    fun setWetInk(json: String) = activity.wetInk.setParams(json)

    /** The page's pen stroke started at (x, y) CSS px in the writing area: the id of its wet stroke, or 0. */
    @JavascriptInterface
    fun wetClaim(x: Double, y: Double): Int = activity.wetInk.claim(x, y)

    /** The committed stroke [id] is on screen: drop the wet copy. */
    @JavascriptInterface
    fun wetDone(id: Int) {
        activity.wetInk.done(id)
    }

    /** The page discarded stroke [id] (no page under the pen, or it snapped to a shape). */
    @JavascriptInterface
    fun wetCancel(id: Int) {
        activity.wetInk.cancel(id)
    }

    /** 診断ログ: crashes and failures recorded by the app, JSON [{at, kind, text}]. */
    @JavascriptInterface
    fun diagnostics(): String = CrashLog.list(activity)

    @JavascriptInterface
    fun clearDiagnostics() = CrashLog.clear(activity)

    /** Something the page wants kept in the 診断ログ (e.g. a script error). */
    @JavascriptInterface
    fun noteDiagnostic(kind: String, text: String) = CrashLog.note(activity, kind.take(24).replace(Regex("[^a-z0-9-]"), ""), text.take(20_000))

    /** 就寝・復習のお知らせ: replace the daily reminders (JSON array, see Reminder); asks for permission if needed. */
    @JavascriptInterface
    fun setReminders(json: String) {
        val list = runCatching { Reminders.parse(json) }.getOrNull() ?: return
        Reminders.set(activity, list)
        if (list.isNotEmpty()) activity.runOnUiThread { activity.askNotificationPermission() }
    }

    @JavascriptInterface
    fun notificationsAllowed(): Boolean = Reminders.allowed(activity)

    /** The side button's action in the page's settings ("eraser" | "lasso" | "none"). */
    @JavascriptInterface
    fun setPenButtonAction(action: String) {
        activity.stylusFilter.action = action
    }
}
