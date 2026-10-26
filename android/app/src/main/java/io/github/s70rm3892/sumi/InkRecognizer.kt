package io.github.s70rm3892.sumi

import com.google.mlkit.common.MlKitException
import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.common.model.RemoteModelManager
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognition
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognitionModel
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognitionModelIdentifier
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognizer
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognizerOptions
import com.google.mlkit.vision.digitalink.recognition.Ink
import com.google.mlkit.vision.digitalink.recognition.RecognitionContext
import com.google.mlkit.vision.digitalink.recognition.WritingArea
import org.json.JSONArray
import org.json.JSONObject

/**
 * On-device Japanese handwriting recognition (ML Kit Digital Ink). The model (~20 MB) is
 * downloaded once through Google Play services; after that everything runs offline.
 * Results go back to the page through `__sumiNative.onInk` / `onInkModel`.
 */
class InkRecognizer(private val activity: MainActivity) {
    private val model: DigitalInkRecognitionModel? = try {
        DigitalInkRecognitionModelIdentifier.fromLanguageTag("ja")?.let { DigitalInkRecognitionModel.builder(it).build() }
    } catch (_: MlKitException) {
        null
    }
    private val models = RemoteModelManager.getInstance()
    private var recognizer: DigitalInkRecognizer? = null

    @Volatile
    var status: String = if (model == null) "unsupported" else "missing"
        private set

    init {
        model?.let { m ->
            models.isModelDownloaded(m).addOnSuccessListener { ok -> if (ok && status != "downloading") status = "ready" }
        }
    }

    fun download() {
        val m = model ?: return activity.callJsWithJson("onInkModel", JSONObject().put("ok", false).put("error", "unsupported"))
        status = "downloading"
        models.download(m, DownloadConditions.Builder().build())
            .addOnSuccessListener {
                status = "ready"
                activity.callJsWithJson("onInkModel", JSONObject().put("ok", true))
            }
            .addOnFailureListener { e ->
                status = "missing"
                activity.callJsWithJson("onInkModel", JSONObject().put("ok", false).put("error", e.message ?: e.toString()))
            }
    }

    /** One line of handwriting: {id, strokes: [[x, y, t, …], …], w, h, pre}. */
    fun recognize(json: String) {
        val req = JSONObject(json)
        val id = req.getString("id")
        fun fail(msg: String) = activity.callJsWithJson("onInk", JSONObject().put("id", id).put("error", msg))
        val m = model ?: return fail("unsupported")
        if (status != "ready") return fail("model not downloaded")
        val ink = Ink.builder()
        val strokes = req.getJSONArray("strokes")
        for (i in 0 until strokes.length()) {
            val pts = strokes.getJSONArray(i)
            val sb = Ink.Stroke.builder()
            var k = 0
            while (k + 2 < pts.length()) {
                sb.addPoint(Ink.Point.create(pts.getDouble(k).toFloat(), pts.getDouble(k + 1).toFloat(), pts.getLong(k + 2)))
                k += 3
            }
            ink.addStroke(sb.build())
        }
        val ctx = RecognitionContext.builder()
            .setPreContext(req.optString("pre", ""))
            .setWritingArea(WritingArea(req.getDouble("w").toFloat(), req.getDouble("h").toFloat()))
            .build()
        val r = recognizer ?: DigitalInkRecognition.getClient(DigitalInkRecognizerOptions.builder(m).build()).also { recognizer = it }
        r.recognize(ink.build(), ctx)
            .addOnSuccessListener { result ->
                val c = JSONArray()
                result.candidates.forEach { c.put(it.text) }
                activity.callJsWithJson("onInk", JSONObject().put("id", id).put("candidates", c))
            }
            .addOnFailureListener { e -> fail(e.message ?: e.toString()) }
    }
}
