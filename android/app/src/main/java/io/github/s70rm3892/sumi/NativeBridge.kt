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
        if (action == "share") activity.shareFile(p.file, p.name, p.mime) else activity.saveFile(p.file, p.name, p.mime)
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
}
