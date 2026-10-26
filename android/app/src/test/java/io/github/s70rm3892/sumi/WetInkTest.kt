package io.github.s70rm3892.sumi

import android.app.Activity
import android.os.Looper
import android.view.InputDevice
import android.view.MotionEvent
import android.widget.FrameLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import java.time.Duration
import kotlin.math.pow

@RunWith(RobolectricTestRunner::class)
class WetInkTest {
    private class FakeSurface : WetSurface {
        val frames = mutableListOf<WetFrame>()
        var clears = 0
        var released = false
        var place = intArrayOf()
        var failRender = false
        /** What the predictor was fed: (action, pointerCount). */
        val recorded = mutableListOf<Pair<Int, Int>>()
        override fun isValid() = true
        override fun place(x: Int, y: Int, w: Int, h: Int) { place = intArrayOf(x, y, w, h) }
        override fun render(frame: WetFrame) {
            if (failRender) throw IllegalStateException("surface gone")
            frames += frame
        }
        override fun clear() { clears++ }
        override fun beginGesture() {}
        override fun recordAndPredict(ev: MotionEvent): MotionEvent? {
            // Like android.view.MotionPredictor: one pointer's consistent stream only.
            require(ev.pointerCount == 1) { "inconsistent MotionEvent stream" }
            recorded += ev.actionMasked to ev.pointerCount
            return null
        }
        override fun release() { released = true }
    }

    /** Floats a frame carries (its cost on the render thread). */
    private fun WetFrame.floats() = redraw.sumOf { it.circles.size } + (add?.circles?.size ?: 0) + (predict?.circles?.size ?: 0)

    private lateinit var container: FrameLayout
    private lateinit var fake: FakeSurface
    private lateinit var wet: WetInk
    private var created = intArrayOf()
    private val failures = mutableListOf<String>()
    private val errors = mutableListOf<Throwable>()

    // The page: writing area below a 56 px toolbar, DPR 2, zoom 1.5, ballpoint 2.2.
    private val json = """{"on":true,"rect":[0,56,1280,744],"dpr":2,"zoom":1.5,"color":"#1e4fd8","style":"ballpoint","width":2.2,"gamma":0.8,"stab":0.25}"""

    @Before
    fun setUp() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        container = FrameLayout(activity)
        activity.setContentView(container)
        fake = FakeSurface()
        wet = WetInk(container, onFail = { failures += it }, onError = { errors += it }) { _, x, y, w, h -> created = intArrayOf(x, y, w, h); fake }
        wet.setParams(json)
        idle()
    }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    /** Window px → CSS px of the writing area (what the page passes to claim). */
    private fun cx(x: Float): Double {
        val loc = IntArray(2).also { container.getLocationInWindow(it) }
        return (x - loc[0]) / 2.0
    }
    private fun cy(y: Float): Double {
        val loc = IntArray(2).also { container.getLocationInWindow(it) }
        return (y - loc[1]) / 2.0 - 56
    }

    private fun claimAt(x: Float, y: Float) = wet.claim(cx(x), cy(y))

    private fun ev(action: Int, x: Float, y: Float, p: Float, t: Long, tool: Int = MotionEvent.TOOL_TYPE_STYLUS, history: List<Triple<Float, Float, Long>> = emptyList()): MotionEvent {
        val props = arrayOf(MotionEvent.PointerProperties().apply { id = 0; toolType = tool })
        fun c(x: Float, y: Float) = arrayOf(MotionEvent.PointerCoords().apply { this.x = x; this.y = y; pressure = p })
        val first = history.firstOrNull()
        val e = MotionEvent.obtain(0, first?.third ?: t, action, 1, props, c(first?.first ?: x, first?.second ?: y), 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_STYLUS, 0)
        for (h in history.drop(1)) e.addBatch(h.third, c(h.first, h.second), 0)
        if (first != null) e.addBatch(t, c(x, y), 0)
        return e
    }

    @Test
    fun overlayCoversOnlyTheWritingArea() {
        assertEquals(listOf(0, 112, 2560, 1488), created.toList())
    }

    @Test
    fun strokeIsClaimedOnceThenErasedWhenTheCommittedStrokeIsOnScreen() {
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 1000), false)
        assertEquals(1, fake.frames.size)
        val id = claimAt(400f, 400f)
        assertTrue(id > 0)
        assertEquals(0, claimAt(400f, 400f)) // once
        wet.onTouch(ev(MotionEvent.ACTION_MOVE, 460f, 430f, 0.6f, 1012, history = listOf(Triple(420f, 410f, 1004L), Triple(440f, 420f, 1008L))), false)
        wet.onTouch(ev(MotionEvent.ACTION_UP, 470f, 432f, 0.3f, 1016), false)
        assertEquals(1, wet.pending)
        wet.done(id)
        idle()
        assertEquals(0, wet.pending)
        assertEquals(1, fake.clears)
    }

    @Test
    fun geometryMatchesTheModelerInDevicePixels() {
        val pts = listOf(Triple(400f, 400f, 1000L), Triple(430f, 405f, 1004L), Triple(470f, 420f, 1008L), Triple(520f, 450f, 1012L))
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, pts[0].first, pts[0].second, 0.5f, pts[0].third), false)
        for (q in pts.drop(1)) wet.onTouch(ev(MotionEvent.ACTION_MOVE, q.first, q.second, 0.5f, q.third), false)
        wet.onTouch(ev(MotionEvent.ACTION_UP, 520f, 450f, 0.5f, 1016), false)
        // Expected: the same modeler in CSS px relative to the writing area — window px minus the
        // container's position, ÷ DPR 2, minus the 56 px toolbar — drawn at ×2.
        val m = Modeler(ModelerParams.forStabilization(0.25))
        val p = 0.5.pow(0.8)
        val out = mutableListOf(m.reset(cx(400f), cy(400f), p, 1000.0))
        for (q in pts.drop(1)) out += m.update(cx(q.first), cy(q.second), p, q.third.toDouble())
        out += m.update(cx(520f), cy(450f), p, 1016.0)
        out += m.finish()
        // Both the page and the wet ink drop points closer than 0.45 screen px to the last kept one.
        val kept = mutableListOf(out[0])
        for (q in out.drop(1)) if (kotlin.math.hypot(q.x - kept.last().x, q.y - kept.last().y) >= 0.45) kept += q
        // Frames carry only what they add (each joined to the circle before it): rebuild the stroke.
        val all = ArrayList<Float>()
        for (f in fake.frames) {
            val a = f.add ?: continue
            for (k in a.from * 3 until a.circles.size) all += a.circles[k]
        }
        val drawn = all.toFloatArray()
        assertEquals(kept.size, drawn.size / 3)
        val r = (penRadius("ballpoint", 2.2f, p) * 1.5 * 2).toFloat()
        assertEquals(r, drawn[2], 1e-4f)
        // First circle and last circle in device px.
        assertEquals(cx(400f) * 2, drawn[0].toDouble(), 1e-3)
        assertEquals(cy(400f) * 2, drawn[1].toDouble(), 1e-3)
        val n = drawn.size / 3
        assertEquals(kept.last().x * 2, drawn[n * 3 - 3].toDouble(), 1e-3)
        assertEquals(kept.last().y * 2, drawn[n * 3 - 2].toDouble(), 1e-3)
    }

    @Test
    fun noWetInkOutsideTheAreaWithTheSideButtonOrForTheEraser() {
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 20f, 0.5f, 1000), false) // on the toolbar
        assertEquals(0, claimAt(400f, 20f))
        wet.onTouch(ev(MotionEvent.ACTION_UP, 400f, 20f, 0.5f, 1004), false)
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 2000), true) // side button (lasso)
        assertEquals(0, claimAt(400f, 400f))
        wet.onTouch(ev(MotionEvent.ACTION_UP, 400f, 400f, 0.5f, 2004), true)
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 3000, tool = MotionEvent.TOOL_TYPE_ERASER), false)
        assertEquals(0, claimAt(400f, 400f))
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 4000, tool = MotionEvent.TOOL_TYPE_FINGER), false)
        assertEquals(0, claimAt(400f, 400f))
        assertEquals(0, wet.pending)
        assertTrue(fake.frames.isEmpty())
    }

    @Test
    fun cancelDropsTheStroke() {
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 1000), false)
        val id = claimAt(400f, 400f)
        wet.cancel(id)
        idle()
        assertEquals(0, wet.pending)
        val frames = fake.frames.size
        wet.onTouch(ev(MotionEvent.ACTION_MOVE, 460f, 430f, 0.6f, 1012), false) // further moves draw nothing
        assertEquals(frames, fake.frames.size)
    }

    @Test
    fun unclaimedStrokesDisappearOnTheirOwn() {
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 1000), false)
        wet.onTouch(ev(MotionEvent.ACTION_UP, 410f, 400f, 0.5f, 1004), false)
        assertEquals(1, wet.pending)
        // A page that lags a second behind still finds its stroke on screen…
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1000))
        assertEquals(1, wet.pending)
        // …but one it never takes doesn't stay.
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(800))
        assertEquals(0, wet.pending)
    }

    @Test
    fun turningItOffReleasesTheOverlayAfterAWhile() {
        wet.setParams(json.replace("\"on\":true", "\"on\":false"))
        idle()
        assertFalse(fake.released)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(4500))
        assertTrue(fake.released)
    }

    private fun ev2(action: Int, pen: Pair<Float, Float>, palm: Pair<Float, Float>, t: Long, penIndex: Int = 0): MotionEvent {
        val penP = MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_STYLUS }
        val palmP = MotionEvent.PointerProperties().apply { id = 1; toolType = MotionEvent.TOOL_TYPE_FINGER }
        val penC = MotionEvent.PointerCoords().apply { x = pen.first; y = pen.second; pressure = 0.5f }
        val palmC = MotionEvent.PointerCoords().apply { x = palm.first; y = palm.second; pressure = 1f; touchMajor = 300f }
        val props = if (penIndex == 0) arrayOf(penP, palmP) else arrayOf(palmP, penP)
        val coords = if (penIndex == 0) arrayOf(penC, palmC) else arrayOf(palmC, penC)
        return MotionEvent.obtain(0, t, action, 2, props, coords, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN or InputDevice.SOURCE_STYLUS, 0)
    }

    @Test
    fun longStrokesCostTheSamePerFrameAtTheEndAsAtTheStart() {
        // A 2400 px line, one sample per px at 240 Hz (10 s of drawing), in a zigzag that
        // crosses itself so earlier parts sit inside later prediction boxes too.
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 300f, 400f, 0.5f, 0), false)
        var t = 0L
        for (i in 1..2400) {
            t += 4
            // Back and forth in rows 3 px apart: the line runs over what it drew before.
            val row = i / 600
            val x = if (row % 2 == 0) 300f + (i % 600) else 900f - (i % 600)
            val y = 400f + row * 3f
            wet.onTouch(ev(MotionEvent.ACTION_MOVE, x, y, 0.5f, t), false)
        }
        wet.onTouch(ev(MotionEvent.ACTION_UP, 300f, 409f, 0.5f, t + 4), false)
        assertTrue(failures.isEmpty())
        val worst = fake.frames.maxOf { it.floats() }
        // The old renderer copied every circle of every stroke into each frame (~10k floats here).
        assertTrue("worst frame carried $worst floats", worst < 1200)
    }

    @Test
    fun aPalmInTheSameGestureNeitherBreaksTheStrokeNorThePredictor() {
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 1000), false)
        wet.onTouch(ev2(MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), 405f to 400f, 900f to 700f, 1004), false)
        for (k in 1..20) wet.onTouch(ev2(MotionEvent.ACTION_MOVE, (405f + k * 5) to 400f, 900f to 700f, 1004L + k * 4), false)
        wet.onTouch(ev2(MotionEvent.ACTION_POINTER_UP or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), 505f to 400f, 900f to 700f, 1090), false)
        wet.onTouch(ev(MotionEvent.ACTION_MOVE, 520f, 400f, 0.5f, 1094), false)
        wet.onTouch(ev(MotionEvent.ACTION_UP, 525f, 400f, 0.5f, 1098), false)
        assertTrue(errors.isEmpty())
        assertTrue(failures.isEmpty())
        assertEquals(1, wet.pending)
        // The predictor saw one pointer: DOWN, MOVE…, UP.
        assertEquals(MotionEvent.ACTION_DOWN, fake.recorded.first().first)
        assertEquals(MotionEvent.ACTION_UP, fake.recorded.last().first)
        assertTrue(fake.recorded.all { it.second == 1 })
        // The stroke reaches the end.
        val lastAdd = fake.frames.last { it.add != null }.add!!
        assertEquals(cx(525f) * 2, lastAdd.circles[lastAdd.circles.size - 3].toDouble(), 3.0)
    }

    @Test
    fun aPenLandingWhileThePalmIsDownStillGetsWetInk() {
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 900f, 700f, 1f, 1000, tool = MotionEvent.TOOL_TYPE_FINGER), false)
        wet.onTouch(ev2(MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), 400f to 400f, 900f to 700f, 1004, penIndex = 1), false)
        assertEquals(1, wet.pending)
        assertTrue(claimAt(400f, 400f) > 0)
    }

    @Test
    fun aLaggingPagePairsEveryStrokeWithItsOwn() {
        // Three quick strokes are on screen before the page gets to the first one.
        val starts = listOf(400f to 400f, 460f to 400f, 520f to 400f)
        starts.forEachIndexed { k, (x, y) ->
            wet.onTouch(ev(MotionEvent.ACTION_DOWN, x, y, 0.5f, 1000L + k * 100), false)
            wet.onTouch(ev(MotionEvent.ACTION_MOVE, x + 20, y + 30, 0.5f, 1040L + k * 100), false)
            wet.onTouch(ev(MotionEvent.ACTION_UP, x + 22, y + 34, 0.5f, 1060L + k * 100), false)
        }
        val ids = starts.map { (x, y) -> claimAt(x, y) }
        assertEquals(3, ids.toSet().size)
        assertTrue(ids.all { it > 0 })
        // The second stroke commits first: only its wet copy goes.
        wet.done(ids[1])
        idle()
        assertEquals(2, wet.pending)
        wet.done(ids[0])
        wet.done(ids[2])
        idle()
        assertEquals(0, wet.pending)
    }

    @Test
    fun androidCancellingTheGestureKeepsWhatWasDrawnForThePage() {
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 1000), false)
        val id = claimAt(400f, 400f)
        wet.onTouch(ev(MotionEvent.ACTION_MOVE, 460f, 430f, 0.6f, 1012), false)
        wet.onTouch(ev(MotionEvent.ACTION_CANCEL, 460f, 430f, 0.6f, 1016), false)
        assertEquals(1, wet.pending) // the page commits it and says done
        wet.done(id)
        idle()
        assertEquals(0, wet.pending)
    }

    @Test
    fun renderErrorsNeverEscapeAndRepeatedOnesTurnWetInkOff() {
        fake.failRender = true
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 1000), false) // throws inside: caught
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 420f, 400f, 0.5f, 1100), false)
        assertTrue(failures.isEmpty())
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 440f, 400f, 0.5f, 1200), false)
        idle()
        assertEquals(3, errors.size)
        assertEquals(1, failures.size)
        assertTrue(fake.released)
        // Off for good: the page draws its own ink.
        fake.failRender = false
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 460f, 400f, 0.5f, 1300), false)
        assertEquals(0, claimAt(460f, 400f))
    }

    @Test
    fun aStrokeWhoseUpNeverCameEndsWhenTheNextOneStarts() {
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 1000), false)
        wet.onTouch(ev(MotionEvent.ACTION_MOVE, 440f, 400f, 0.5f, 1010), false)
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 600f, 400f, 0.5f, 2000), false)
        assertEquals(2, wet.pending)
        // The first one is finished and unclaimed: it goes after a while; the new one is drawing.
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1800))
        assertEquals(1, wet.pending)
    }
}
