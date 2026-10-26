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

    fun add(x: Float, y: Float, r: Float) {
        if (size + 3 > data.size) data = data.copyOf(data.size * 2)
        data[size++] = x
        data[size++] = y
        data[size++] = r
    }

    fun count() = size / 3
    fun snapshot(): FloatArray = data.copyOf(size)
}

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
}

/** One frame for the front buffer: wipe a region and repaint what stays there, append, predict. */
class WetFrame(
    val clear: RectF?,
    val redraw: List<Pair<Int, FloatArray>>,
    val color: Int,
    val add: FloatArray?,
    val addFrom: Int,
    val predict: FloatArray?,
)

/** Where wet ink is shown: the real one is a front-buffered SurfaceView; tests use a fake. */
interface WetSurface {
    fun isValid(): Boolean
    fun place(x: Int, y: Int, w: Int, h: Int)
    fun render(frame: WetFrame)
    fun clear()
    /** Record a real event; returns the platform's prediction (caller recycles it) or null. */
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
    private val predictor: MotionEventPredictor

    init {
        container.addView(view, FrameLayout.LayoutParams(w, h).apply { leftMargin = x; topMargin = y })
        renderer = CanvasFrontBufferedRenderer(view, object : CanvasFrontBufferedRenderer.Callback<WetFrame> {
            override fun onDrawFrontBufferedLayer(canvas: Canvas, bufferWidth: Int, bufferHeight: Int, param: WetFrame) = draw(canvas, param)

            override fun onDrawMultiBufferedLayer(canvas: Canvas, bufferWidth: Int, bufferHeight: Int, params: Collection<WetFrame>) {
                canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
            }
        })
        predictor = MotionEventPredictor.newInstance(view)
    }

    private fun draw(canvas: Canvas, f: WetFrame) {
        f.clear?.let { box ->
            canvas.save()
            canvas.clipRect(box)
            canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
            for ((color, c) in f.redraw) {
                paint.color = color
                CirclePainter.paint(canvas, c, paint)
            }
            canvas.restore()
        }
        paint.color = f.color
        f.add?.let { CirclePainter.paint(canvas, it, paint, f.addFrom) }
        f.predict?.let { CirclePainter.paint(canvas, it, paint) }
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

    override fun recordAndPredict(ev: MotionEvent): MotionEvent? {
        predictor.record(ev)
        return if (ev.actionMasked == MotionEvent.ACTION_MOVE) predictor.predict() else null
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
 * predictor), while the page still receives every event and commits the real stroke. The page
 * claims the wet stroke when its pen tool starts (so it skips its own live drawing), and says
 * when the committed stroke is on screen; then the wet copy is erased. Both sides use the same
 * modeler (Modeler.kt / modeler.ts) and the same circle geometry, so nothing visibly changes at
 * the hand-off.
 *
 * Safety: the overlay only covers the writing area (never the toolbar), exists only while the
 * page asks for it (a notebook open, the pen selected, the setting on), and if the renderer
 * can't start the page keeps drawing its own ink.
 */
class WetInk(
    private val container: FrameLayout,
    private val onFail: (String) -> Unit,
    private val makeSurface: (FrameLayout, Int, Int, Int, Int) -> WetSurface = ::FrontBufferSurface,
) {
    private class Stroke(val color: Int, val modeler: Modeler) {
        val circles = CircleList()
        var claimed = false
        var finished = false
        var finishedAt = 0L
        var lastCssX = Double.NaN
        var lastCssY = Double.NaN
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
    @Volatile private var failed = false

    /** Wet strokes still on screen (for tests and diagnostics). */
    val pending: Int get() = synchronized(this) { strokes.size }

    private val sweep = object : Runnable {
        override fun run() = synchronized(this@WetInk) {
            val now = SystemClock.uptimeMillis()
            // Finished strokes the page never claimed (or never confirmed) don't stay forever.
            val stale = strokes.filter { it.finished && now - it.finishedAt > (if (it.claimed) 1500 else 350) }
            stale.forEach { remove(it) }
            if (strokes.isNotEmpty()) main.postDelayed(this, 150)
        }
    }

    /** From the page (any thread). */
    fun setParams(json: String) {
        val p = try { WetParams.parse(json) } catch (_: Exception) { return }
        main.post { applyParams(p) }
    }

    private fun applyParams(p: WetParams) {
        synchronized(this) {
            params = p
            if (!p.on) {
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
    }

    private val detachRunnable = Runnable { synchronized(this) { detach() } }

    /** Leaving the pen for a moment shouldn't rebuild the surface: wait a little first. */
    private fun detachSoon() {
        main.removeCallbacks(detachRunnable)
        main.postDelayed(detachRunnable, 4000)
    }

    private fun detach() {
        strokes.clear()
        active = null
        surface?.release()
        surface = null
        predBox = null
    }

    private fun fail(e: Throwable) {
        failed = true
        onFail("低遅延ペンが使えないので通常の描画に切り替えた: ${e.message}")
        try {
            detach()
        } catch (_: Throwable) {
        }
    }

    // ---------- input (called with every touch event before the WebView gets it) ----------

    fun onTouch(ev: MotionEvent, sideButtonHeld: Boolean) {
        synchronized(this) {
            val p = params ?: return
            val sf = surface ?: return
            if (!p.on || failed) return
            try {
                when (ev.actionMasked) {
                    MotionEvent.ACTION_DOWN -> begin(ev, p, sf, sideButtonHeld)
                    MotionEvent.ACTION_MOVE -> move(ev, p, sf)
                    MotionEvent.ACTION_UP -> end(ev, p)
                    MotionEvent.ACTION_POINTER_UP -> if (ev.getPointerId(ev.actionIndex) == activePointer) end(ev, p)
                    MotionEvent.ACTION_CANCEL -> active?.let { remove(it) }.also { active = null }
                }
            } catch (e: Throwable) {
                fail(e)
            }
        }
    }

    private fun begin(ev: MotionEvent, p: WetParams, sf: WetSurface, sideButtonHeld: Boolean) {
        active = null
        if (ev.getToolType(0) != MotionEvent.TOOL_TYPE_STYLUS || sideButtonHeld || !sf.isValid()) return
        val loc = IntArray(2)
        container.getLocationInWindow(loc)
        offsetX = loc[0].toFloat()
        offsetY = loc[1].toFloat()
        val cx = cssX(ev.getX(0), p)
        val cy = cssY(ev.getY(0), p)
        if (cx < 0 || cy < 0 || cx > p.width || cy > p.height) return
        val s = Stroke(p.color, Modeler(ModelerParams.forStabilization(p.stabilization.toDouble())))
        activePointer = ev.getPointerId(0)
        push(s, s.modeler.reset(cx, cy, pressure(ev.getPressure(0), p), timeOf(ev, -1)), p)
        strokes.addLast(s)
        active = s
        sf.recordAndPredict(ev)?.recycle()
        render(s, 0, predictFor(s, p, null))
        main.removeCallbacks(sweep)
        main.postDelayed(sweep, 150)
    }

    private fun move(ev: MotionEvent, p: WetParams, sf: WetSurface) {
        val s = active ?: return
        val i = ev.findPointerIndex(activePointer)
        if (i < 0) return
        val predicted = sf.recordAndPredict(ev)
        val from = s.circles.count()
        for (h in 0 until ev.historySize) {
            for (q in s.modeler.update(cssX(ev.getHistoricalX(i, h), p), cssY(ev.getHistoricalY(i, h), p), pressure(ev.getHistoricalPressure(i, h), p), timeOf(ev, h))) push(s, q, p)
        }
        for (q in s.modeler.update(cssX(ev.getX(i), p), cssY(ev.getY(i), p), pressure(ev.getPressure(i), p), timeOf(ev, -1))) push(s, q, p)
        render(s, from, predictFor(s, p, predicted))
    }

    private fun end(ev: MotionEvent, p: WetParams) {
        val s = active ?: return
        val i = ev.findPointerIndex(activePointer)
        val from = s.circles.count()
        if (i >= 0) {
            for (q in s.modeler.update(cssX(ev.getX(i), p), cssY(ev.getY(i), p), pressure(ev.getPressure(i), p), timeOf(ev, -1))) push(s, q, p)
        }
        for (q in s.modeler.finish()) push(s, q, p)
        render(s, from, null)
        s.finished = true
        s.finishedAt = SystemClock.uptimeMillis()
        active = null
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
            val i = predicted.findPointerIndex(activePointer).takeIf { it >= 0 } ?: 0
            // Predicted in the same (window) coordinates as the recorded events.
            c.add((cssX(predicted.getX(i), p) * p.dpr).toFloat(), (cssY(predicted.getY(i), p) * p.dpr).toFloat(), r)
            predicted.recycle()
        }
        return if (c.count() > 1) c.snapshot() else null
    }

    private fun render(s: Stroke, from: Int, predict: FloatArray?) {
        val sf = surface ?: return
        val clear = predBox
        val redraw = if (clear != null) strokes.map { it.color to it.circles.snapshot() } else emptyList()
        predBox = predict?.let { CirclePainter.bounds(it) }
        sf.render(WetFrame(clear, redraw, s.color, s.circles.snapshot(), max(0, from - 1), predict))
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
        val box = CirclePainter.bounds(s.circles.snapshot()) ?: return
        predBox?.let { box.union(it) }
        predBox = null
        sf.render(WetFrame(box, strokes.map { it.color to it.circles.snapshot() }, Color.TRANSPARENT, null, 0, null))
    }

    // ---------- the page's side of the hand-off ----------

    /**
     * The page's pen tool started: is there a wet stroke for this gesture? (It then skips its own
     * live ink.) Called synchronously from the page's thread; ACTION_DOWN was handled before the
     * WebView even received the event.
     */
    fun claim(): Boolean = synchronized(this) {
        val s = active ?: return false
        if (s.claimed) return false
        s.claimed = true
        return true
    }

    /** The page committed a stroke and it is on screen: erase the oldest wet copy. */
    fun done() {
        main.post { synchronized(this) { strokes.firstOrNull { it.claimed && it.finished }?.let { remove(it) } } }
    }

    /** The page doesn't want this one (no page under the pen, or it became a shape). */
    fun cancel() {
        main.post {
            synchronized(this) {
                (active ?: strokes.lastOrNull())?.let { remove(it) }
                active = null
            }
        }
    }
}
