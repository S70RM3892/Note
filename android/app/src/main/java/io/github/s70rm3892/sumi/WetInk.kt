package io.github.s70rm3892.sumi

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.PorterDuff
import android.graphics.RectF
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.SurfaceView
import android.view.View
import android.widget.FrameLayout
import androidx.graphics.lowlatency.CanvasFrontBufferedRenderer
import androidx.input.motionprediction.MotionEventPredictor
import org.json.JSONObject
import kotlin.math.abs
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

/**
 * Circles of one stroke (x, y, r in overlay device px) and how to paint them: the union of the
 * circles joined by their outer tangents, exactly like LiveInkPainter in src/core/ink.ts.
 */
class CircleList {
    var data = FloatArray(96)
        private set
    var size = 0
        private set
    private var minX = Float.POSITIVE_INFINITY
    private var minY = Float.POSITIVE_INFINITY
    private var maxX = Float.NEGATIVE_INFINITY
    private var maxY = Float.NEGATIVE_INFINITY

    fun add(x: Float, y: Float, r: Float) {
        if (size + 3 > data.size) data = data.copyOf(data.size * 2)
        data[size++] = x
        data[size++] = y
        data[size++] = r
        minX = min(minX, x - r)
        minY = min(minY, y - r)
        maxX = max(maxX, x + r)
        maxY = max(maxY, y + r)
    }

    fun count() = size / 3
    fun snapshot(): FloatArray = data.copyOf(size)

    /** Circles [from, count) as a new array. */
    fun copyFrom(from: Int): FloatArray = data.copyOfRange(max(0, from) * 3, size)

    fun bounds(): RectF? = if (size == 0) null else RectF(minX - 2, minY - 2, maxX + 2, maxY + 2)

    fun mayTouch(box: RectF): Boolean = size > 0 && minX - 2 < box.right && maxX + 2 > box.left && minY - 2 < box.bottom && maxY + 2 > box.top
}

/** Circles to paint: circles[from…], each joined to the one before it (from = 1 starts with a join). */
class WetRun(val color: Int, val circles: FloatArray, val from: Int)

object CirclePainter {
    private val quad = Path()

    /** Paint circles[from…] (each joined to the one before it), clipped by the canvas. */
    fun paint(canvas: Canvas, c: FloatArray, paint: Paint, from: Int = 0) {
        val n = c.size / 3
        for (i in max(0, from) until n) {
            val x = c[i * 3]
            val y = c[i * 3 + 1]
            val r = max(0.35f, c[i * 3 + 2])
            if (i > 0) {
                val px = c[i * 3 - 3]
                val py = c[i * 3 - 2]
                val pr = max(0.35f, c[i * 3 - 1])
                val d = hypot(x - px, y - py)
                if (d > abs(pr - r) + 1e-3f) {
                    // Outer tangents of the two circles (see tangents() in ink.ts).
                    val ux = (x - px) / d
                    val uy = (y - py) / d
                    val nx = -uy
                    val ny = ux
                    val cs = max(-1f, min(1f, (pr - r) / d))
                    val sn = kotlin.math.sqrt(1 - cs * cs)
                    val lx = ux * cs + nx * sn
                    val ly = uy * cs + ny * sn
                    val rx = ux * cs - nx * sn
                    val ry = uy * cs - ny * sn
                    quad.rewind()
                    quad.moveTo(px + pr * lx, py + pr * ly)
                    quad.lineTo(x + r * lx, y + r * ly)
                    quad.lineTo(x + r * rx, y + r * ry)
                    quad.lineTo(px + pr * rx, py + pr * ry)
                    quad.close()
                    canvas.drawPath(quad, paint)
                }
            }
            canvas.drawCircle(x, y, r, paint)
        }
    }

    fun bounds(c: FloatArray, from: Int = 0): RectF? {
        var b: RectF? = null
        for (i in max(0, from) until c.size / 3) {
            val x = c[i * 3]
            val y = c[i * 3 + 1]
            val r = c[i * 3 + 2] + 2
            if (b == null) b = RectF(x - r, y - r, x + r, y + r) else b.union(x - r, y - r, x + r, y + r)
        }
        return b
    }

    /**
     * The parts of a stroke that paint inside [box]: runs of circles whose piece (the circle and
     * its join to the previous one) reaches the box. A frame repaints only these, so its cost
     * doesn't grow with the length of the stroke.
     */
    fun runsIn(color: Int, list: CircleList, box: RectF, out: MutableList<WetRun>) {
        if (!list.mayTouch(box)) return
        val d = list.data
        val n = list.count()
        var start = -1
        for (i in 0..n) {
            val hit = i < n && pieceTouches(d, i, box)
            if (hit && start < 0) start = i
            if (!hit && start >= 0) {
                val from = if (start > 0) 1 else 0
                out += WetRun(color, d.copyOfRange((start - from) * 3, i * 3), from)
                start = -1
            }
        }
    }

    private fun pieceTouches(d: FloatArray, i: Int, box: RectF): Boolean {
        val r = max(0.35f, d[i * 3 + 2]) + 2
        var l = d[i * 3] - r
        var t = d[i * 3 + 1] - r
        var rt = d[i * 3] + r
        var b = d[i * 3 + 1] + r
        if (i > 0) {
            val pr = max(0.35f, d[i * 3 - 1]) + 2
            l = min(l, d[i * 3 - 3] - pr)
            t = min(t, d[i * 3 - 2] - pr)
            rt = max(rt, d[i * 3 - 3] + pr)
            b = max(b, d[i * 3 - 2] + pr)
        }
        return l < box.right && rt > box.left && t < box.bottom && b > box.top
    }
}

/** One frame for the front buffer: wipe a region and repaint what stays there, append, predict. */
class WetFrame(
    val clear: RectF?,
    val redraw: List<WetRun>,
    val add: WetRun?,
    val predict: WetRun?,
)

/** A copy of [ev] holding only pointer [index], as [action] (history included). The caller recycles it. */
fun singlePointer(ev: MotionEvent, index: Int, action: Int): MotionEvent {
    val props = arrayOf(MotionEvent.PointerProperties().also { ev.getPointerProperties(index, it) })
    val coords = arrayOf(MotionEvent.PointerCoords())
    val h = if (action == MotionEvent.ACTION_MOVE) ev.historySize else 0
    fun fill(pos: Int) = if (pos < h) ev.getHistoricalPointerCoords(index, pos, coords[0]) else ev.getPointerCoords(index, coords[0])
    fun time(pos: Int) = if (pos < h) ev.getHistoricalEventTime(pos) else ev.eventTime
    fill(0)
    val out = MotionEvent.obtain(
        ev.downTime, time(0), action, 1, props, coords, ev.metaState, ev.buttonState,
        ev.xPrecision, ev.yPrecision, ev.deviceId, ev.edgeFlags, ev.source, ev.flags,
    )
    for (pos in 1..h) {
        fill(pos)
        out.addBatch(time(pos), coords, ev.metaState)
    }
    return out
}

/** Where wet ink is shown: the real one is a front-buffered SurfaceView; tests use a fake. */
interface WetSurface {
    fun isValid(): Boolean
    fun place(x: Int, y: Int, w: Int, h: Int)
    fun render(frame: WetFrame)
    fun clear()
    /** A new stroke: the motion predictor starts a fresh gesture. */
    fun beginGesture()
    /** Record a single-pointer event of the stroke; returns the platform's prediction (caller recycles it) or null. */
    fun recordAndPredict(ev: MotionEvent): MotionEvent?
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
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val renderer: CanvasFrontBufferedRenderer<WetFrame>
    private var predictor: MotionEventPredictor? = null

    init {
        container.addView(view, FrameLayout.LayoutParams(w, h).apply { leftMargin = x; topMargin = y })
        renderer = CanvasFrontBufferedRenderer(view, object : CanvasFrontBufferedRenderer.Callback<WetFrame> {
            override fun onDrawFrontBufferedLayer(canvas: Canvas, bufferWidth: Int, bufferHeight: Int, param: WetFrame) = draw(canvas, param)

            override fun onDrawMultiBufferedLayer(canvas: Canvas, bufferWidth: Int, bufferHeight: Int, params: Collection<WetFrame>) {
                canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
            }
        })
    }

    private fun draw(canvas: Canvas, f: WetFrame) {
        f.clear?.let { box ->
            canvas.save()
            canvas.clipRect(box)
            canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
            for (run in f.redraw) paintRun(canvas, run)
            canvas.restore()
        }
        f.add?.let { paintRun(canvas, it) }
        f.predict?.let { paintRun(canvas, it) }
    }

    private fun paintRun(canvas: Canvas, run: WetRun) {
        paint.color = run.color
        CirclePainter.paint(canvas, run.circles, paint, run.from)
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

    override fun beginGesture() {
        // Made once and kept: creating one can load the system's prediction model.
        if (predictor == null) predictor = runCatching { MotionEventPredictor.newInstance(view) }.getOrNull()
    }

    override fun recordAndPredict(ev: MotionEvent): MotionEvent? {
        val pr = predictor ?: return null
        return try {
            pr.record(ev)
            if (ev.actionMasked == MotionEvent.ACTION_MOVE) pr.predict() else null
        } catch (_: Throwable) {
            // An inconsistent stream (e.g. a gesture Android cancelled): start over with a new predictor.
            predictor = null
            null
        }
    }

    override fun release() {
        try {
            renderer.release(true)
        } catch (_: Throwable) {
        }
        container.removeView(view)
    }
}

/**
 * Low-latency "wet" ink for the APK. Pen strokes are drawn natively into a front-buffered
 * overlay the moment the samples arrive (Jetpack graphics-core, plus Android's motion
 * predictor), while the page still receives every event and commits the real stroke. Each wet
 * stroke has an id; the page claims its stroke by where the pen went down (so a page that lags
 * behind the pen still pairs every stroke with its own), skips its own live ink for it, and says
 * when the committed stroke is on screen; then that wet copy is erased. Both sides use the same
 * modeler (Modeler.kt / modeler.ts) and the same circle geometry, so nothing visibly changes at
 * the hand-off.
 *
 * Stability: a frame only repaints around the pen tip (its cost doesn't grow with the stroke),
 * the predictor sees one pointer's stream (a palm in the same gesture can't upset it), every
 * posted task is guarded, and after repeated errors it turns itself off and the page draws its
 * own ink. The overlay covers only the writing area and exists only while the page asks for it.
 */
class WetInk(
    private val container: FrameLayout,
    private val onFail: (String) -> Unit,
    private val onError: (Throwable) -> Unit = {},
    private val makeSurface: (FrameLayout, Int, Int, Int, Int) -> WetSurface = ::FrontBufferSurface,
) {
    companion object {
        /** A finished stroke the page never claimed (it didn't take the stroke, or lags far behind). */
        const val UNCLAIMED_MS = 1500L
        /** A claimed stroke whose commit never came. */
        const val CLAIMED_MS = 5000L
        /** How far (CSS px) the page's pen-down may be from where the wet stroke started. */
        const val CLAIM_SLOP = 6.0
        const val MAX_STROKES = 64
        const val MAX_ERRORS = 3
    }

    private class Stroke(val id: Int, val color: Int, val modeler: Modeler, val startX: Double, val startY: Double, val startedAt: Long) {
        val circles = CircleList()
        var claimed = false
        var finished = false
        var finishedAt = 0L
        var lastCssX = Double.NaN
        var lastCssY = Double.NaN
        var predicting = true
    }

    private val main = Handler(Looper.getMainLooper())
    private var params: WetParams? = null
    private var surface: WetSurface? = null
    private val strokes = ArrayDeque<Stroke>()
    private var active: Stroke? = null
    private var activePointer = -1
    private var predBox: RectF? = null
    private var offsetX = 0f
    private var offsetY = 0f
    private var nextId = 1
    private var errors = 0
    @Volatile private var failed = false

    /** Wet strokes still on screen (for tests and diagnostics). */
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
            val stale = strokes.filter {
                if (it.finished) now - it.finishedAt > (if (it.claimed) CLAIMED_MS else UNCLAIMED_MS) else now - it.startedAt > 120_000
            }
            stale.forEach { remove(it) }
            if (strokes.isNotEmpty()) main.postDelayed(this, 150)
        }
    }

    /** From the page (any thread). */
    fun setParams(json: String) {
        val p = try { WetParams.parse(json) } catch (_: Exception) { return }
        main.post { guarded { applyParams(p) } }
    }

    private fun applyParams(p: WetParams) {
        params = p
        if (!p.on) {
            // Whatever is being drawn now ends here; the sweep (or the page) takes it off.
            active?.let { finish(it) }
            active = null
            detachSoon()
            return
        }
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
        predBox = null
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
                    MotionEvent.ACTION_MOVE -> move(ev, p, sf)
                    MotionEvent.ACTION_UP -> end(ev, p, sf)
                    MotionEvent.ACTION_POINTER_UP -> if (ev.getPointerId(ev.actionIndex) == activePointer) end(ev, p, sf)
                    // Android took the gesture away: keep what was drawn, the page commits it and says done.
                    MotionEvent.ACTION_CANCEL -> active?.let { s ->
                        record(sf, s, ev, ev.findPointerIndex(activePointer), MotionEvent.ACTION_CANCEL)?.recycle()
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
        val s = Stroke(nextId++, p.color, Modeler(ModelerParams.forStabilization(p.stabilization.toDouble())), cx, cy, SystemClock.uptimeMillis())
        activePointer = ev.getPointerId(index)
        push(s, s.modeler.reset(cx, cy, pressure(ev.getPressure(index), p), timeOf(ev, -1)), p)
        strokes.addLast(s)
        while (strokes.size > MAX_STROKES) remove(strokes.first())
        active = s
        sf.beginGesture()
        record(sf, s, ev, index, MotionEvent.ACTION_DOWN)?.recycle()
        render(s, 0, predictFor(s, p, null))
        main.removeCallbacks(sweep)
        main.postDelayed(sweep, 150)
    }

    private fun move(ev: MotionEvent, p: WetParams, sf: WetSurface) {
        val s = active ?: return
        val i = ev.findPointerIndex(activePointer)
        if (i < 0) return
        val from = s.circles.count()
        for (h in 0 until ev.historySize) {
            for (q in s.modeler.update(cssX(ev.getHistoricalX(i, h), p), cssY(ev.getHistoricalY(i, h), p), pressure(ev.getHistoricalPressure(i, h), p), timeOf(ev, h))) push(s, q, p)
        }
        for (q in s.modeler.update(cssX(ev.getX(i), p), cssY(ev.getY(i), p), pressure(ev.getPressure(i), p), timeOf(ev, -1))) push(s, q, p)
        render(s, from, predictFor(s, p, record(sf, s, ev, i, MotionEvent.ACTION_MOVE)))
    }

    private fun end(ev: MotionEvent, p: WetParams, sf: WetSurface) {
        val s = active ?: return
        val i = ev.findPointerIndex(activePointer)
        val from = s.circles.count()
        if (i >= 0) {
            for (q in s.modeler.update(cssX(ev.getX(i), p), cssY(ev.getY(i), p), pressure(ev.getPressure(i), p), timeOf(ev, -1))) push(s, q, p)
            record(sf, s, ev, i, MotionEvent.ACTION_UP)?.recycle()
        }
        for (q in s.modeler.finish()) push(s, q, p)
        finish(s)
        active = null
        render(s, from, null)
    }

    private fun finish(s: Stroke) {
        if (s.finished) return
        s.finished = true
        s.finishedAt = SystemClock.uptimeMillis()
    }

    /** Feed the predictor this stroke's pointer only (a consistent one-pointer stream). */
    private fun record(sf: WetSurface, s: Stroke, ev: MotionEvent, index: Int, action: Int): MotionEvent? {
        if (!s.predicting || index < 0) return null
        val one = singlePointer(ev, index, action)
        return try {
            sf.recordAndPredict(one)
        } catch (_: Throwable) {
            s.predicting = false
            null
        } finally {
            one.recycle()
        }
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
        s.circles.add((q.x * p.dpr).toFloat(), (q.y * p.dpr).toFloat(), (penRadius(p.style, p.penWidth, q.p) * p.zoom * p.dpr).toFloat())
    }

    /** Catch-up to the pen tip plus the platform's predicted point (drawn once, wiped next frame). */
    private fun predictFor(s: Stroke, p: WetParams, predicted: MotionEvent?): FloatArray? {
        val n = s.circles.count()
        if (n == 0) {
            predicted?.recycle()
            return null
        }
        val c = CircleList()
        val d = s.circles.data
        c.add(d[n * 3 - 3], d[n * 3 - 2], d[n * 3 - 1])
        var r = d[n * 3 - 1]
        for (q in s.modeler.predict()) {
            r = (penRadius(p.style, p.penWidth, q.p) * p.zoom * p.dpr).toFloat()
            c.add((q.x * p.dpr).toFloat(), (q.y * p.dpr).toFloat(), r)
        }
        if (predicted != null) {
            // Predicted in the same (window) coordinates as the recorded events.
            if (predicted.pointerCount > 0) c.add((cssX(predicted.getX(0), p) * p.dpr).toFloat(), (cssY(predicted.getY(0), p) * p.dpr).toFloat(), r)
            predicted.recycle()
        }
        return if (c.count() > 1) c.snapshot() else null
    }

    /** Paint what this stroke added since circle [from] (+ a fresh prediction), wiping the last prediction. */
    private fun render(s: Stroke, from: Int, predict: FloatArray?) {
        val sf = surface ?: return
        val clear = predBox
        val redraw = ArrayList<WetRun>()
        if (clear != null) for (o in strokes) CirclePainter.runsIn(o.color, o.circles, clear, redraw)
        predBox = predict?.let { CirclePainter.bounds(it) }
        val start = max(0, from - 1)
        val add = if (s.circles.count() > start) WetRun(s.color, s.circles.copyFrom(start), if (from > 0) 1 else 0) else null
        sf.render(WetFrame(clear, redraw, add, predict?.let { WetRun(s.color, it, 0) }))
    }

    private fun remove(s: Stroke) {
        if (!strokes.remove(s)) return
        if (active === s) active = null
        val sf = surface ?: return
        if (strokes.isEmpty()) {
            predBox = null
            sf.clear()
            return
        }
        val box = s.circles.bounds() ?: return
        predBox?.let { box.union(it) }
        predBox = null
        val redraw = ArrayList<WetRun>()
        for (o in strokes) CirclePainter.runsIn(o.color, o.circles, box, redraw)
        sf.render(WetFrame(box, redraw, null, null))
    }

    // ---------- the page's side of the hand-off ----------

    /**
     * The page's pen tool started at (x, y) (CSS px in the writing area): the id of the wet stroke
     * that started there (the oldest unclaimed one, in case the page lags several strokes behind),
     * or 0 when there is none and the page draws its own live ink. Called from the page's thread.
     */
    fun claim(x: Double, y: Double): Int = synchronized(this) {
        val now = SystemClock.uptimeMillis()
        val s = strokes.firstOrNull { !it.claimed && now - it.startedAt < 10_000 && hypot(it.startX - x, it.startY - y) <= CLAIM_SLOP } ?: return 0
        s.claimed = true
        return s.id
    }

    /** The page committed stroke [id] and it is on screen: erase the wet copy. */
    fun done(id: Int) {
        main.post { guarded { strokes.firstOrNull { it.id == id }?.let { remove(it) } } }
    }

    /** The page doesn't want stroke [id] (no page under the pen, or it became a shape). */
    fun cancel(id: Int) {
        main.post { guarded { strokes.firstOrNull { it.id == id }?.let { remove(it) } } }
    }
}
