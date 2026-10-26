package io.github.s70rm3892.sumi

import android.content.Context
import android.speech.tts.TextToSpeech
import java.util.Locale

/** What [Speech] needs from Android's TextToSpeech (an interface so the queueing can be tested). */
interface SpeechEngine {
    fun say(text: String, locale: Locale, rate: Float)
    fun stop()
    fun shutdown()
}

/**
 * 読み上げ: the WebView has no speech synthesis, so the page asks the shell. The engine starts on
 * first use; a request made before it is ready is spoken once it is (only the latest one).
 */
class Speech(private val create: (onReady: (Boolean) -> Unit) -> SpeechEngine) {
    private var engine: SpeechEngine? = null
    private var ready = false
    private var failed = false
    private var pending: Triple<String, Locale, Float>? = null

    @Synchronized
    fun speak(text: String, lang: String, rate: Float) {
        if (failed) return
        val req = Triple(text.take(4000), Locale.forLanguageTag(lang), rate.coerceIn(0.3f, 2.5f))
        if (ready) engine?.say(req.first, req.second, req.third)
        else {
            pending = req
            if (engine == null) engine = create(::onReady)
        }
    }

    @Synchronized
    private fun onReady(ok: Boolean) {
        ready = ok
        failed = !ok
        val p = pending ?: return
        pending = null
        if (ok) engine?.say(p.first, p.second, p.third)
    }

    @Synchronized
    fun stop() {
        pending = null
        if (ready) engine?.stop()
    }

    @Synchronized
    fun shutdown() {
        engine?.shutdown()
        engine = null
        ready = false
    }

    companion object {
        fun android(context: Context) = Speech { onReady ->
            lateinit var tts: TextToSpeech
            tts = TextToSpeech(context.applicationContext) { status -> onReady(status == TextToSpeech.SUCCESS) }
            object : SpeechEngine {
                override fun say(text: String, locale: Locale, rate: Float) {
                    tts.language = locale
                    tts.setSpeechRate(rate)
                    tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "sumi")
                }

                override fun stop() {
                    tts.stop()
                }

                override fun shutdown() {
                    tts.shutdown()
                }
            }
        }
    }
}
