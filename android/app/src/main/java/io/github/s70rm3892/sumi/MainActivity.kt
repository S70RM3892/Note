package io.github.s70rm3892.sumi

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.MotionEvent
import android.view.WindowManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewFeature
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Thin Android shell around the web app: a full-screen WebView serving the bundled build
 * from the app's own origin, plus what a browser can't do well on the tablet — the ML Kit
 * document scanner, saving/sharing files, "open with" PDFs, the S Pen side button while
 * hovering, and the back gesture.
 */
class MainActivity : ComponentActivity() {
    companion object {
        const val ORIGIN = "https://${WebViewAssetLoader.DEFAULT_DOMAIN}"
        const val START_URL = "$ORIGIN/assets/www/index.html"
        /** Files we hand to the page (scans, opened PDFs) are served from here. */
        const val FILES_URL = "$ORIGIN/files/"
    }

    private lateinit var container: FrameLayout
    private lateinit var web: WebView
    private lateinit var assetLoader: WebViewAssetLoader
    private val io = Executors.newSingleThreadExecutor()

    /** Directory behind [FILES_URL]. */
    val webFilesDir: File by lazy { File(cacheDir, "web-files").apply { mkdirs() } }
    private val shareDir: File by lazy { File(cacheDir, "share").apply { mkdirs() } }
    private val cameraDir: File by lazy { File(cacheDir, "camera").apply { mkdirs() } }

    private var pageReady = false
    private var penButton = false
    private var chooserCallback: ValueCallback<Array<Uri>>? = null
    private var cameraUri: Uri? = null
    private var pendingSave: File? = null
    private val incoming = mutableListOf<JSONObject>()

    private val pickDocuments = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val cb = chooserCallback
        chooserCallback = null
        cb?.onReceiveValue(if (r.resultCode == RESULT_OK) urisFrom(r.data) else null)
    }

    private val takePicture = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val cb = chooserCallback
        chooserCallback = null
        val uri = cameraUri
        cb?.onReceiveValue(if (ok && uri != null) arrayOf(uri) else null)
    }

    private val scanDocuments = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { r ->
        onScanResult(r)
    }

    private val createDocument = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        onSaveResult(r)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        cleanOldFiles()
        ink = InkRecognizer(this) // starts checking whether the handwriting model is already there

        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/files/", WebViewAssetLoader.InternalStoragePathHandler(this, webFilesDir))
            .build()

        container = FrameLayout(this)
        setContentView(container)
        // Keep the page above the on-screen keyboard (edge-to-edge disables adjustResize).
        ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
            v.setPadding(0, 0, 0, insets.getInsets(WindowInsetsCompat.Type.ime()).bottom)
            insets
        }
        web = createWebView()
        container.addView(web)
        hideSystemBars()

        onBackPressedDispatcher.addCallback(this) {
            web.evaluateJavascript(
                "(function(){try{var n=window.__sumiNative;return !!(n&&n.onBack&&n.onBack())}catch(e){return false}})()",
            ) { handled -> if (handled != "true") moveTaskToBack(true) }
        }

        handleIntent(intent)
        val restored = savedInstanceState?.getString("url")?.takeIf { it.startsWith(START_URL) }
        web.loadUrl(restored ?: START_URL)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView {
        val w = WebView(this)
        pageReady = false
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = true // file chooser results (content:// URIs)
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false) // pinch zoom is the app's own
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100
            offscreenPreRaster = true
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(w.settings, false) // the app has its own dark theme
        }
        w.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.toString().startsWith(ORIGIN)) return false
                openExternal(request.url)
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // The renderer crashed or was reclaimed: rebuild the WebView instead of taking the app down.
                // Notes live in IndexedDB, so the reload comes back to the same state.
                container.removeView(web)
                web.destroy()
                web = createWebView()
                container.addView(web)
                web.loadUrl(START_URL)
                return true
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                chooserCallback?.onReceiveValue(null)
                chooserCallback = callback
                return showFileChooser(params)
            }
        }
        w.addJavascriptInterface(NativeBridge(this), "SumiNative")
        return w
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.url?.let { outState.putString("url", it) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    override fun onDestroy() {
        io.shutdown()
        super.onDestroy()
    }

    /** Full screen; the bars come back temporarily with an edge swipe (so a palm at the edge doesn't leave the app). */
    private fun hideSystemBars() {
        val c = WindowCompat.getInsetsController(window, window.decorView)
        c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        c.hide(WindowInsetsCompat.Type.systemBars())
    }

    // ---------- S Pen side button ----------

    val stylusFilter = StylusButtonFilter()
    lateinit var ink: InkRecognizer

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        trackPenButton(ev)
        val fixed = stylusFilter.filter(ev) ?: return super.dispatchTouchEvent(ev)
        return try {
            super.dispatchTouchEvent(fixed)
        } finally {
            fixed.recycle()
        }
    }

    override fun dispatchGenericMotionEvent(ev: MotionEvent): Boolean {
        trackPenButton(ev)
        return super.dispatchGenericMotionEvent(ev)
    }

    /**
     * Tell the page whether the side button is held, from hover events too: it shows the
     * matching cursor and, for the lasso action, picks the tool before the pen lands. (For
     * the eraser the touch events themselves say so, see [StylusButtonFilter].)
     */
    private fun trackPenButton(ev: MotionEvent) {
        if (ev.pointerCount == 0) return
        val tool = ev.getToolType(0)
        if (tool != MotionEvent.TOOL_TYPE_STYLUS && tool != MotionEvent.TOOL_TYPE_ERASER) return
        val down = ev.buttonState and StylusButtonFilter.SIDE_BUTTONS != 0
        if (down != penButton) {
            penButton = down
            callJs("onPenButton", down.toString())
        }
    }

    // ---------- page callbacks ----------

    /** Call window.__sumiNative[fn](arg) if the page registered it; `arg` is a JS expression. */
    fun callJs(fn: String, arg: String = "") {
        runOnUiThread {
            web.evaluateJavascript("(function(){var n=window.__sumiNative;if(n&&n.$fn)n.$fn($arg)})()", null)
        }
    }

    fun callJsWithJson(fn: String, json: JSONObject) = callJs(fn, JSONObject.quote(json.toString()))

    fun toast(msg: String) = runOnUiThread { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show() }

    fun setKeepScreenOn(on: Boolean) = runOnUiThread {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    fun openExternal(uri: Uri) = runOnUiThread {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) {
            toast("開けるアプリがない")
        }
    }

    // ---------- file chooser (<input type=file>) ----------

    private fun showFileChooser(params: WebChromeClient.FileChooserParams): Boolean {
        val accept = params.acceptTypes.flatMap { it.split(',') }.map { it.trim() }.filter { it.isNotEmpty() }
        val imagesOnly = accept.isNotEmpty() && accept.all { it.startsWith("image/") }
        if (params.isCaptureEnabled && (accept.isEmpty() || imagesOnly)) {
            val f = File(cameraDir, "photo-${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(this, "$packageName.files", f)
            cameraUri = uri
            return try {
                takePicture.launch(uri)
                true
            } catch (_: ActivityNotFoundException) {
                chooserCallback = null
                toast("カメラアプリが見つからない")
                false
            }
        }
        // Extensions (".sumi") can't be expressed as MIME types: then allow everything.
        val mimes = accept.filter { it.contains('/') }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            if (mimes.isNotEmpty() && mimes.size == accept.size) {
                type = if (mimes.size == 1) mimes[0] else "*/*"
                if (mimes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, mimes.toTypedArray())
            } else type = "*/*"
            if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        return try {
            pickDocuments.launch(intent)
            true
        } catch (_: ActivityNotFoundException) {
            chooserCallback = null
            false
        }
    }

    private fun urisFrom(data: Intent?): Array<Uri>? {
        if (data == null) return null
        val clip = data.clipData
        if (clip != null && clip.itemCount > 0) return Array(clip.itemCount) { clip.getItemAt(it).uri }
        return data.data?.let { arrayOf(it) }
    }

    // ---------- ML Kit document scanner ----------

    fun hasScanner(): Boolean =
        GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(this) == ConnectionResult.SUCCESS

    fun startScan(pageLimit: Int) = runOnUiThread {
        val options = GmsDocumentScannerOptions.Builder()
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
            .setGalleryImportAllowed(true)
            .setPageLimit(pageLimit.coerceIn(1, 20))
            .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
            .build()
        GmsDocumentScanning.getClient(options).getStartScanIntent(this)
            .addOnSuccessListener { sender -> scanDocuments.launch(IntentSenderRequest.Builder(sender).build()) }
            .addOnFailureListener { e -> callJsWithJson("onScan", JSONObject().put("error", e.message ?: "scanner unavailable")) }
    }

    private fun onScanResult(r: ActivityResult) {
        val pages = if (r.resultCode == RESULT_OK) GmsDocumentScanningResult.fromActivityResultIntent(r.data)?.pages.orEmpty() else emptyList()
        io.execute {
            val urls = JSONArray()
            try {
                for (p in pages) {
                    val f = File(webFilesDir, "scan-${UUID.randomUUID()}.jpg")
                    contentResolver.openInputStream(p.imageUri)?.use { i -> f.outputStream().use { i.copyTo(it) } }
                    urls.put(FILES_URL + f.name)
                }
                callJsWithJson("onScan", JSONObject().put("urls", urls))
            } catch (e: Exception) {
                callJsWithJson("onScan", JSONObject().put("error", e.message ?: e.toString()))
            }
        }
    }

    // ---------- save / share files from the page ----------

    fun saveFile(file: File, name: String, mime: String) = runOnUiThread {
        pendingSave?.delete()
        pendingSave = file
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mime
            putExtra(Intent.EXTRA_TITLE, name)
        }
        try {
            createDocument.launch(intent)
        } catch (_: ActivityNotFoundException) {
            file.delete()
            pendingSave = null
            callJsWithJson("onFileDone", JSONObject().put("ok", false))
        }
    }

    private fun onSaveResult(r: ActivityResult) {
        val file = pendingSave ?: return
        pendingSave = null
        val target = r.data?.data
        if (r.resultCode != RESULT_OK || target == null) {
            file.delete()
            callJsWithJson("onFileDone", JSONObject().put("ok", false))
            return
        }
        io.execute {
            val ok = try {
                contentResolver.openOutputStream(target, "wt")?.use { out -> file.inputStream().use { it.copyTo(out) } } != null
            } catch (e: Exception) {
                toast("保存に失敗: ${e.message}")
                false
            } finally {
                file.delete()
            }
            callJsWithJson("onFileDone", JSONObject().put("ok", ok))
        }
    }

    fun shareFile(file: File, name: String, mime: String) = runOnUiThread {
        // Receivers show the file name, so give the shared copy its real name.
        val dir = File(shareDir, UUID.randomUUID().toString()).apply { mkdirs() }
        val named = File(dir, name.replace('/', '_'))
        if (!file.renameTo(named)) {
            file.copyTo(named, overwrite = true)
            file.delete()
        }
        val uri = FileProvider.getUriForFile(this, "$packageName.files", named)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_TITLE, name)
            clipData = ClipData.newRawUri(name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val ok = try {
            startActivity(Intent.createChooser(send, name))
            true
        } catch (_: ActivityNotFoundException) {
            false
        }
        callJsWithJson("onFileDone", JSONObject().put("ok", ok))
    }

    // ---------- files opened with / shared to the app ----------

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        val uris: List<Uri> = when (intent.action) {
            Intent.ACTION_VIEW -> listOfNotNull(intent.data)
            Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            Intent.ACTION_SEND_MULTIPLE -> IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else -> emptyList()
        }
        if (uris.isEmpty()) return
        val fallbackType = intent.type
        io.execute {
            val copied = uris.mapNotNull { copyIncoming(it, fallbackType) }
            synchronized(incoming) { incoming.addAll(copied) }
            // If the page isn't up yet it collects them itself on start.
            runOnUiThread { if (pageReady) callJs("onIncoming") }
        }
    }

    private fun copyIncoming(uri: Uri, fallbackType: String?): JSONObject? = try {
        val mime = contentResolver.getType(uri) ?: fallbackType ?: "application/octet-stream"
        var name = uri.lastPathSegment ?: "file"
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst() && !c.isNull(0)) name = c.getString(0)
        }
        name = name.substringAfterLast('/')
        if (mime == "application/pdf" && !name.endsWith(".pdf", ignoreCase = true)) name += ".pdf"
        val f = File(webFilesDir, "in-${UUID.randomUUID()}")
        contentResolver.openInputStream(uri)?.use { i -> f.outputStream().use { i.copyTo(it) } } ?: error("unreadable")
        JSONObject().put("url", FILES_URL + f.name).put("name", name).put("mime", mime)
    } catch (e: Exception) {
        toast("開けなかった: ${e.message}")
        null
    }

    fun takeIncoming(): String = synchronized(incoming) {
        val out = JSONArray(incoming).toString()
        incoming.clear()
        out
    }

    /** Scans, opened files and shared copies are only needed briefly. */
    private fun cleanOldFiles() {
        val cutoff = System.currentTimeMillis() - 24 * 3600 * 1000L
        io.execute {
            for (dir in listOf(webFilesDir, shareDir, cameraDir, File(cacheDir, "outgoing"))) {
                dir.walkBottomUp().filter { it != dir && it.lastModified() < cutoff }.forEach { it.delete() }
            }
        }
    }
}
