package io.github.s70rm3892.sumi

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.PorterDuff
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.SurfaceView
import android.view.View
import android.widget.FrameLayout
import androidx.graphics.lowlatency.CanvasFrontBufferedRenderer
import org.json.JSONObject
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/** What the page says about the pen right now (CSS px, page units, as in the page). */
data class WetParams(
    val on: Boolean,
    val left: Float,
    val top: Float,
    val width: Float,
    val height: Float,
    val dpr: Float,
    val zoom: Float,
    val color: Int,
    val style: String,
    val penWidth: Float,
    val gamma: Float,
    val stabilization: Float,
) {
    companion object {
        fun parse(json: String): WetParams {
            val o = JSONObject(json)
            val r = o.optJSONArray("rect")
            return WetParams(
                on = o.optBoolean("on"),
                left = r?.optDouble(0)?.toFloat() ?: 0f,
                top = r?.optDouble(1)?.toFloat() ?: 0f,
                width = r?.optDouble(2)?.toFloat() ?: 0f,
                height = r?.optDouble(3)?.toFloat() ?: 0f,
                dpr = o.optDouble("dpr", 1.0).toFloat(),
                zoom = o.optDouble("zoom", 1.0).toFloat(),
                color = try { Color.parseColor(o.optString("color", "#1a1a1a")) } catch (_: IllegalArgumentException) { Color.BLACK },
                style = o.optString("style", "ballpoint"),
                penWidth = o.optDouble("width", 2.2).toFloat(),
                gamma = o.optDouble("gamma", 0.8).toFloat(),
                stabilization = o.optDouble("stab", 0.25).toFloat(),
            )
        }
    }
}

/** Same as radiusFor() in src/core/ink.ts for a pen stroke (page units). */
fun penRadius(style: String, width: Float, p: Double): Double {
    val min = when (style) {
        "fountain" -> 0.18
        "marker" -> 1.0
        "pencil" -> 0.45
        else -> 0.5
    }
    val f = min + (1 - min) * 2 * min(1.0, max(0.0, p))
    return max(0.25, (width / 2.0) * f)
}

/** Points of one stroke (x, y in overlay device px). */
class PointList {
    var data = FloatArray(128)
        private set
    var size = 0
        private set

    fun add(x: Float, y: Float) {
        if (size + 2 > data.size) data = data.copyOf(data.size * 2)
        data[size++] = x
        data[size++] = y
    }

    fun count() = size / 2

    /** Points [from, count) as a new array. */
    fun copyFrom(from: Int): FloatArray = data.copyOfRange(max(0, from) * 2, size)
}

/** A piece of a stroke to paint: a polyline (device px) of constant width with round ends and joins. */
class WetRun(val color: Int, val width: Float, val pts: FloatArray)

/**
 * One frame for the front buffer. While writing, frames only add (nothing on the visible buffer
 * is ever erased mid-stroke, which is what showed as white jaggies); [wipe] is only used when
 * strokes must go and others stay (rare).
 */
class WetFrame(val wipe: Boolean, val runs: List<WetRun>)

object LinePainter {
    private val path = Path()

    fun paint(canvas: Canvas, run: WetRun, line: Paint, dot: Paint) {
        val p = run.pts
        val n = p.size / 2
        if (n == 0) return
        if (n == 1) {
            dot.color = run.color
            canvas.drawCircle(p[0], p[1], run.width / 2, dot)
            return
        }
        path.rewind()
        path.moveTo(p[0], p[1])
        for (i in 1 until n) path.lineTo(p[i * 2], p[i * 2 + 1])
        line.color = run.color
        line.strokeWidth = run.width
        canvas.drawPath(path, line)
    }
}

/** Where wet ink is shown: the real one is a front-buffered SurfaceView; tests use a fake. */
interface WetSurface {
    fun isValid(): Boolean
    fun place(x: Int, y: Int, w: Int, h: Int)
    fun render(frame: WetFrame)
    /** Wipe everything (one operation: what is under it is the same ink, committed by the page). */
    fun clear()
    fun release()
}

/** Overlay above the WebView's writing area: SurfaceView + Jetpack front-buffered renderer. */
class FrontBufferSurface(private val container: FrameLayout, x: Int, y: Int, w: Int, h: Int) : WetSurface {
    private val view = SurfaceView(container.context).apply {
        setZOrderOnTop(true)
        holder.setFormat(PixelFormat.TRANSLUCENT)
        isClickable = false
        isFocusable = false
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        setOnTouchListener { _, _ -> false }
    }
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val renderer: CanvasFrontBufferedRenderer<WetFrame>

    init {
        container.addView(view, FrameLayout.LayoutParams(w, h).apply { leftMargin = x; topMargin = y })
        renderer = CanvasFrontBufferedRenderer(view, object : CanvasFrontBufferedRenderer.Callback<WetFrame> {
            override fun onDrawFrontBufferedLayer(canvas: Canvas, bufferWidth: Int, bufferHeight: Int, param: WetFrame) {
                if (param.wipe) canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
                for (run in param.runs) LinePainter.paint(canvas, run, line, dot)
            }

            override fun onDrawMultiBufferedLayer(canvas: Canvas, bufferWidth: Int, bufferHeight: Int, params: Collection<WetFrame>) {
                canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
            }
        })
    }

    override fun isValid() = renderer.isValid()

    override fun place(x: Int, y: Int, w: Int, h: Int) {
        val lp = view.layoutParams as FrameLayout.LayoutParams
        if (lp.width != w || lp.height != h || lp.leftMargin != x || lp.topMargin != y) {
            lp.width = w; lp.height = h; lp.leftMargin = x; lp.topMargin = y
            view.layoutParams = lp
        }
    }

    override fun render(frame: WetFrame) = renderer.renderFrontBufferedLayer(frame)
    override fun clear() = renderer.clear()

    override fun release() {
        try {
            renderer.release(true)
        } catch (_: Throwable) {
        }
        container.removeView(view)
    }
}

/**
 * Low-latency "wet" ink for the APK: a uniform-width liner drawn natively into a front-buffered
 * overlay the moment the samples arrive, while the page still receives every event and commits
 * the real stroke. Each wet stroke has an id; the page claims its stroke by where the pen went
 * down (so a page that lags behind the pen still pairs every stroke with its own), skips its own
 * live ink for it, and says when the committed stroke is on screen (done).
 *
 * Drawing only ever adds to the visible buffer: no prediction that would have to be erased
 * again, so nothing flashes or tears under the pen. The hand-off waits until the pen is idle and
 * every stroke on the overlay is committed, then wipes the whole overlay in one go — the same
 * ink is underneath, so nothing visibly changes.
 *
 * Stability: frames carry only the new points, every posted task is guarded, and after repeated
 * errors it turns itself off and the page draws its own ink. The overlay covers only the writing
 * area and exists only while the page asks for it.
 */
class WetInk(
    private val container: FrameLayout,
    private val onFail: (String) -> Unit,
    private val onError: (Throwable) -> Unit = {},
    private val makeSurface: (FrameLayout, Int, Int, Int, Int) -> WetSurface = ::FrontBufferSurface,
) {
    companion object {
        /** After the last stroke is committed and the pen is idle this long, the overlay is wiped. */
        const val SETTLE_MS = 150L
        /** A finished stroke the page never claimed (it didn't take the stroke, or lags far behind). */
        const val UNCLAIMED_MS = 1500L
        /** A claimed stroke whose commit never came. */
        const val CLAIMED_MS = 5000L
        /** How far (CSS px) the page's pen-down may be from where the wet stroke started. */
        const val CLAIM_SLOP = 6.0
        const val MAX_STROKES = 256
        const val MAX_ERRORS = 3
    }

    private class Stroke(val id: Int, val color: Int, val width: Float, val modeler: Modeler, val startX: Double, val startY: Double, val startedAt: Long) {
        val points = PointList()
        /** Points already on screen. */
        var drawn = 0
        var claimed = false
        var finished = false
        var finishedAt = 0L
        /** The page committed it (its own ink is on screen now). */
        var done = false
        /** Given up on (never claimed, or its commit never came): may be wiped. */
        var stale = false
        var lastCssX = Double.NaN
        var lastCssY = Double.NaN
    }

    private val main = Handler(Looper.getMainLooper())
    private var params: WetParams? = null
    private var surface: WetSurface? = null
    private val strokes = ArrayDeque<Stroke>()
    private var active: Stroke? = null
    private var activePointer = -1
    private var offsetX = 0f
    private var offsetY = 0f
    private var nextId = 1
    private var errors = 0
    @Volatile private var failed = false

    /** Wet strokes still on the overlay (for tests and diagnostics). */
    val pending: Int get() = synchronized(this) { strokes.size }

    /** Run posted work so that nothing here can take the app down. */
    private fun guarded(block: () -> Unit) = synchronized(this) {
        try {
            block()
        } catch (e: Throwable) {
            fault(e)
        }
    }

    private val sweep = object : Runnable {
        override fun run() = guarded {
            val now = SystemClock.uptimeMillis()
            var changed = false
            for (s in strokes) {
                if (s.stale || s.done || !s.finished) continue
                if (now - s.finishedAt > (if (s.claimed) CLAIMED_MS else UNCLAIMED_MS)) {
                    s.stale = true
                    changed = true
                }
            }
            if (changed) settleSoon(0)
            if (strokes.isNotEmpty()) main.postDelayed(this, 150)
        }
    }

    private val settle = Runnable { guarded { settleNow() } }

    private fun settleSoon(delay: Long) {
        main.removeCallbacks(settle)
        main.postDelayed(settle, delay)
    }

    /** Wipe the overlay once nothing is being drawn and every stroke on it is committed (or given up). */
    private fun settleNow() {
        if (active != null || strokes.isEmpty()) return
        if (strokes.all { it.done || it.stale }) {
            strokes.clear()
            surface?.clear()
        }
    }

    /** From the page (any thread). */
    fun setParams(json: String) {
        val p = try { WetParams.parse(json) } catch (_: Exception) { return }
        main.post { guarded { applyParams(p) } }
    }

    private fun applyParams(p: WetParams) {
        val old = params
        params = p
        if (!p.on) {
            // Whatever is being drawn now ends here; it goes once the page has it (or gives up).
            active?.let { finish(it) }
            active = null
            settleSoon(SETTLE_MS)
            detachSoon()
            return
        }
        // The writing area moved or zoomed: ink already committed must not linger in the old place.
        if (old != null && (old.left != p.left || old.top != p.top || old.width != p.width || old.height != p.height || old.zoom != p.zoom)) settleNow()
        if (failed || p.width < 8 || p.height < 8) return
        main.removeCallbacks(detachRunnable)
        val x = (p.left * p.dpr).toInt()
        val y = (p.top * p.dpr).toInt()
        val w = (p.width * p.dpr).toInt()
        val h = (p.height * p.dpr).toInt()
        try {
            surface?.place(x, y, w, h) ?: run { surface = makeSurface(container, x, y, w, h) }
        } catch (e: Throwable) {
            fail(e)
        }
    }

    private val detachRunnable = Runnable { guarded { detach() } }

    /** Leaving the pen for a moment shouldn't rebuild the surface: wait a little first. */
    private fun detachSoon() {
        main.removeCallbacks(detachRunnable)
        main.postDelayed(detachRunnable, 4000)
    }

    private fun detach() {
        strokes.clear()
        active = null
        val sf = surface
        surface = null
        sf?.release()
    }

    private fun fail(e: Throwable) {
        if (failed) return
        failed = true
        onFail("低遅延ペンを止めて通常の描画に切り替えた: ${e.javaClass.simpleName} ${e.message ?: ""}".trim())
        try {
            detach()
        } catch (_: Throwable) {
        }
    }

    /** One error drops nothing but the frame; repeated ones turn wet ink off (posted: never mid-dispatch). */
    private fun fault(e: Throwable) {
        errors++
        try {
            onError(e)
        } catch (_: Throwable) {
        }
        if (errors >= MAX_ERRORS && !failed) main.post { synchronized(this) { fail(e) } }
    }

    // ---------- input (called with every touch event before the WebView gets it) ----------

    fun onTouch(ev: MotionEvent, sideButtonHeld: Boolean) {
        synchronized(this) {
            val p = params ?: return
            val sf = surface ?: return
            if (!p.on || failed) return
            try {
                when (ev.actionMasked) {
                    MotionEvent.ACTION_DOWN -> begin(ev, 0, p, sf, sideButtonHeld)
                    // The pen landing while a palm (or finger) is already down.
                    MotionEvent.ACTION_POINTER_DOWN -> if (active == null) begin(ev, ev.actionIndex, p, sf, sideButtonHeld)
                    MotionEvent.ACTION_MOVE -> move(ev, p)
                    MotionEvent.ACTION_UP -> end(ev, p)
                    MotionEvent.ACTION_POINTER_UP -> if (ev.getPointerId(ev.actionIndex) == activePointer) end(ev, p)
                    // Android took the gesture away: keep what was drawn, the page commits it and says done.
                    MotionEvent.ACTION_CANCEL -> active?.let { s ->
                        finish(s)
                        active = null
                    }
                }
            } catch (e: Throwable) {
                // Stop drawing this stroke; the page still commits it.
                active?.let { finish(it) }
                active = null
                fault(e)
            }
        }
    }

    private fun begin(ev: MotionEvent, index: Int, p: WetParams, sf: WetSurface, sideButtonHeld: Boolean) {
        // A stroke whose pen-up never came is over now.
        active?.let { finish(it) }
        active = null
        if (ev.getToolType(index) != MotionEvent.TOOL_TYPE_STYLUS || sideButtonHeld || !sf.isValid()) return
        val loc = IntArray(2)
        container.getLocationInWindow(loc)
        offsetX = loc[0].toFloat()
        offsetY = loc[1].toFloat()
        val cx = cssX(ev.getX(index), p)
        val cy = cssY(ev.getY(index), p)
        if (cx < 0 || cy < 0 || cx > p.width || cy > p.height) return
        main.removeCallbacks(settle)
        val width = (2 * penRadius(p.style, p.penWidth, 0.5) * p.zoom * p.dpr).toFloat()
        val s = Stroke(nextId++, p.color, width, Modeler(ModelerParams.forStabilization(p.stabilization.toDouble())), cx, cy, SystemClock.uptimeMillis())
        activePointer = ev.getPointerId(index)
        push(s, s.modeler.reset(cx, cy, pressure(ev.getPressure(index), p), timeOf(ev, -1)), p)
        strokes.addLast(s)
        if (strokes.size > MAX_STROKES) trim()
        active = s
        draw(s)
        main.removeCallbacks(sweep)
        main.postDelayed(sweep, 150)
    }

    private fun move(ev: MotionEvent, p: WetParams) {
        val s = active ?: return
        val i = ev.findPointerIndex(activePointer)
        if (i < 0) return
        for (h in 0 until ev.historySize) {
            for (q in s.modeler.update(cssX(ev.getHistoricalX(i, h), p), cssY(ev.getHistoricalY(i, h), p), pressure(ev.getHistoricalPressure(i, h), p), timeOf(ev, h))) push(s, q, p)
        }
        for (q in s.modeler.update(cssX(ev.getX(i), p), cssY(ev.getY(i), p), pressure(ev.getPressure(i), p), timeOf(ev, -1))) push(s, q, p)
        draw(s)
    }

    private fun end(ev: MotionEvent, p: WetParams) {
        val s = active ?: return
        val i = ev.findPointerIndex(activePointer)
        if (i >= 0) {
            for (q in s.modeler.update(cssX(ev.getX(i), p), cssY(ev.getY(i), p), pressure(ev.getPressure(i), p), timeOf(ev, -1))) push(s, q, p)
        }
        for (q in s.modeler.finish()) push(s, q, p)
        draw(s)
        finish(s)
        active = null
        settleSoon(SETTLE_MS)
    }

    private fun finish(s: Stroke) {
        if (s.finished) return
        s.finished = true
        s.finishedAt = SystemClock.uptimeMillis()
    }

    private fun cssX(x: Float, p: WetParams) = ((x - offsetX) / p.dpr - p.left).toDouble()
    private fun cssY(y: Float, p: WetParams) = ((y - offsetY) / p.dpr - p.top).toDouble()

    private fun pressure(raw: Float, p: WetParams): Double =
        if (raw > 0) min(1.0, raw.toDouble()).pow(p.gamma.toDouble()) else 0.5

    /** Event time in ms (sub-ms where the platform gives nanoseconds), like the page's timeStamp. */
    private fun timeOf(ev: MotionEvent, h: Int): Double =
        if (Build.VERSION.SDK_INT >= 34) {
            (if (h < 0) ev.eventTimeNanos else ev.getHistoricalEventTimeNanos(h)) / 1e6
        } else {
            (if (h < 0) ev.eventTime else ev.getHistoricalEventTime(h)).toDouble()
        }

    /** Add a modeled point, with the page's 0.45 screen-px minimum spacing. */
    private fun push(s: Stroke, q: ModelPoint, p: WetParams) {
        if (!s.lastCssX.isNaN() && hypot(q.x - s.lastCssX, q.y - s.lastCssY) < 0.45) return
        s.lastCssX = q.x
        s.lastCssY = q.y
        s.points.add((q.x * p.dpr).toFloat(), (q.y * p.dpr).toFloat())
    }

    /** Paint the points added since the last frame, joined to the last one painted. Adds only. */
    private fun draw(s: Stroke) {
        val sf = surface ?: return
        val n = s.points.count()
        if (n == s.drawn) return
        val run = WetRun(s.color, s.width, s.points.copyFrom(if (s.drawn > 0) s.drawn - 1 else 0))
        s.drawn = n
        sf.render(WetFrame(false, listOf(run)))
    }

    /** Wipe the overlay and paint [keep] again (only when some strokes must go and others stay). */
    private fun repaint(keep: List<Stroke>) {
        val sf = surface ?: return
        if (keep.isEmpty()) {
            sf.clear()
            return
        }
        sf.render(WetFrame(true, keep.map { WetRun(it.color, it.width, it.points.copyFrom(0)) }))
    }

    /** Far too many strokes without a pause: keep only the ones the page hasn't committed yet. */
    private fun trim() {
        strokes.removeAll { it.done || it.stale }
        while (strokes.size > MAX_STROKES) strokes.removeFirst()
        repaint(strokes.toList())
    }

    // ---------- the page's side of the hand-off ----------

    /**
     * The page's pen tool started at (x, y) (CSS px in the writing area): the id of the wet stroke
     * that started there (the oldest unclaimed one, in case the page lags several strokes behind),
     * or 0 when there is none and the page draws its own live ink. Called from the page's thread.
     */
    fun claim(x: Double, y: Double): Int = synchronized(this) {
        val now = SystemClock.uptimeMillis()
        val s = strokes.firstOrNull { !it.claimed && !it.stale && now - it.startedAt < 10_000 && hypot(it.startX - x, it.startY - y) <= CLAIM_SLOP } ?: return 0
        s.claimed = true
        return s.id
    }

    /** The page committed stroke [id] and it is on screen: the overlay is wiped once the pen rests. */
    fun done(id: Int) {
        main.post {
            guarded {
                strokes.firstOrNull { it.id == id }?.let {
                    it.done = true
                    settleSoon(SETTLE_MS)
                }
            }
        }
    }

    /** The page doesn't want stroke [id] (no page under the pen, or it became a shape): it goes now. */
    fun cancel(id: Int) {
        main.post {
            guarded {
                val s = strokes.firstOrNull { it.id == id } ?: return@guarded
                if (active === s) active = null
                strokes.remove(s)
                // Strokes the page already shows can go with it; only uncommitted ones are painted again.
                strokes.removeAll { it.done || it.stale }
                repaint(strokes.toList())
            }
        }
    }
}
