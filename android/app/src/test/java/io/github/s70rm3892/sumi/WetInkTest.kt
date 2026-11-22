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
        var failRender = false
        override fun isValid() = true
        override fun place(x: Int, y: Int, w: Int, h: Int) {}
        override fun render(frame: WetFrame) {
            if (failRender) throw IllegalStateException("surface gone")
            frames += frame
        }
        override fun clear() { clears++ }
        override fun release() { released = true }
    }

    /** Floats a frame carries (its cost on the render thread). */
    private fun WetFrame.floats() = runs.sumOf { it.pts.size }

    private lateinit var container: FrameLayout
    private lateinit var fake: FakeSurface
    private lateinit var wet: WetInk
    private var created = intArrayOf()
    private val failures = mutableListOf<String>()
    private val errors = mutableListOf<Throwable>()

    // The page: writing area below a 56 px toolbar, DPR 2, zoom 1.5, liner 2.2.
    private val json = """{"on":true,"rect":[0,56,1280,744],"dpr":2,"zoom":1.5,"color":"#1e4fd8","style":"marker","width":2.2,"gamma":0.8,"stab":0.25}"""

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
    private fun idleFor(ms: Long) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))

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

    private fun ev2(action: Int, pen: Pair<Float, Float>, palm: Pair<Float, Float>, t: Long, penIndex: Int = 0): MotionEvent {
        val penP = MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_STYLUS }
        val palmP = MotionEvent.PointerProperties().apply { id = 1; toolType = MotionEvent.TOOL_TYPE_FINGER }
        val penC = MotionEvent.PointerCoords().apply { x = pen.first; y = pen.second; pressure = 0.5f }
        val palmC = MotionEvent.PointerCoords().apply { x = palm.first; y = palm.second; pressure = 1f; touchMajor = 300f }
        val props = if (penIndex == 0) arrayOf(penP, palmP) else arrayOf(palmP, penP)
        val coords = if (penIndex == 0) arrayOf(penC, palmC) else arrayOf(palmC, penC)
        return MotionEvent.obtain(0, t, action, 2, props, coords, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN or InputDevice.SOURCE_STYLUS, 0)
    }

    private fun stroke(x: Float, y: Float, t: Long, dx: Float = 40f) {
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, x, y, 0.5f, t), false)
        wet.onTouch(ev(MotionEvent.ACTION_MOVE, x + dx / 2, y + 10, 0.5f, t + 8), false)
        wet.onTouch(ev(MotionEvent.ACTION_UP, x + dx, y + 12, 0.5f, t + 16), false)
    }

    /** All points painted, in order (each run after the first repeats the last painted point). */
    private fun painted(): List<Pair<Float, Float>> {
        val out = mutableListOf<Pair<Float, Float>>()
        for (f in fake.frames) for (r in f.runs) {
            val start = if (out.isEmpty()) 0 else 1
            for (k in start until r.pts.size / 2) out += r.pts[k * 2] to r.pts[k * 2 + 1]
        }
        return out
    }

    @Test
    fun overlayCoversOnlyTheWritingArea() {
        assertEquals(listOf(0, 112, 2560, 1488), created.toList())
    }

    @Test
    fun aUniformLinerOfThePenWidth() {
        stroke(400f, 400f, 1000)
        val widths = fake.frames.flatMap { f -> f.runs.map { it.width } }.toSet()
        // 2.2 page units × zoom 1.5 × DPR 2, whatever the pressure.
        assertEquals(setOf(2.2f * 1.5f * 2f), widths)
    }

    @Test
    fun writingOnlyEverAddsToTheScreen() {
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 300f, 400f, 0.5f, 0), false)
        var t = 0L
        for (i in 1..2400) {
            t += 4
            val row = i / 600
            val x = if (row % 2 == 0) 300f + (i % 600) else 900f - (i % 600)
            wet.onTouch(ev(MotionEvent.ACTION_MOVE, x, 400f + row * 3f, 0.3f + (i % 7) / 10f, t), false)
        }
        wet.onTouch(ev(MotionEvent.ACTION_UP, 300f, 409f, 0.5f, t + 4), false)
        assertTrue(failures.isEmpty())
        // No frame wipes anything while writing (that showed as white jaggies on the front buffer)…
        assertTrue(fake.frames.none { it.wipe })
        assertEquals(0, fake.clears)
        // …and each frame carries only the new points, however long the line gets.
        val worst = fake.frames.maxOf { it.floats() }
        assertTrue("worst frame carried $worst floats", worst < 40)
    }

    @Test
    fun geometryMatchesTheModelerInDevicePixels() {
        val pts = listOf(Triple(400f, 400f, 1000L), Triple(430f, 405f, 1004L), Triple(470f, 420f, 1008L), Triple(520f, 450f, 1012L))
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, pts[0].first, pts[0].second, 0.5f, pts[0].third), false)
        for (q in pts.drop(1)) wet.onTouch(ev(MotionEvent.ACTION_MOVE, q.first, q.second, 0.5f, q.third), false)
        wet.onTouch(ev(MotionEvent.ACTION_UP, 520f, 450f, 0.5f, 1016), false)
        val m = Modeler(ModelerParams.forStabilization(0.25))
        val p = 0.5.pow(0.8)
        val out = mutableListOf(m.reset(cx(400f), cy(400f), p, 1000.0))
        for (q in pts.drop(1)) out += m.update(cx(q.first), cy(q.second), p, q.third.toDouble())
        out += m.update(cx(520f), cy(450f), p, 1016.0)
        out += m.finish()
        // Both the page and the wet ink drop points closer than 0.45 screen px to the last kept one.
        val kept = mutableListOf(out[0])
        for (q in out.drop(1)) if (kotlin.math.hypot(q.x - kept.last().x, q.y - kept.last().y) >= 0.45) kept += q
        val drawn = painted()
        assertEquals(kept.size, drawn.size)
        kept.zip(drawn).forEach { (k, d) ->
            assertEquals(k.x * 2, d.first.toDouble(), 1e-3)
            assertEquals(k.y * 2, d.second.toDouble(), 1e-3)
        }
    }

    @Test
    fun theHandOffWaitsUntilThePenRestsAndEverythingIsCommitted() {
        stroke(400f, 400f, 1000)
        val a = claimAt(400f, 400f)
        // The next stroke starts before the page has committed the first.
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 500f, 400f, 0.5f, 1050), false)
        val b = claimAt(500f, 400f)
        wet.done(a)
        idleFor(400)
        assertEquals(0, fake.clears) // still writing the second: nothing is wiped
        wet.onTouch(ev(MotionEvent.ACTION_MOVE, 520f, 410f, 0.5f, 1060), false)
        wet.onTouch(ev(MotionEvent.ACTION_UP, 540f, 412f, 0.5f, 1070), false)
        idleFor(400)
        assertEquals(0, fake.clears) // the second isn't committed yet
        assertEquals(2, wet.pending)
        wet.done(b)
        idleFor(100)
        assertEquals(0, fake.clears) // committed, but give its frame a moment on screen
        idleFor(100)
        assertEquals(1, fake.clears) // one wipe of the whole overlay
        assertEquals(0, wet.pending)
        assertTrue(fake.frames.none { it.wipe })
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
    fun cancelTakesTheStrokeOffAtOnceAndStopsDrawingIt() {
        stroke(300f, 300f, 500)
        val first = claimAt(300f, 300f)
        wet.done(first)
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 1000), false)
        val id = claimAt(400f, 400f)
        wet.cancel(id) // snapped to a shape: the page draws the preview itself
        idle()
        assertEquals(0, wet.pending) // the committed first one goes with it
        assertEquals(1, fake.clears)
        val frames = fake.frames.size
        wet.onTouch(ev(MotionEvent.ACTION_MOVE, 460f, 430f, 0.6f, 1012), false) // further moves draw nothing
        assertEquals(frames, fake.frames.size)
    }

    @Test
    fun cancelKeepsStrokesThePageHasNotCommittedYet() {
        stroke(300f, 300f, 500) // not committed yet
        claimAt(300f, 300f)
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 1000), false)
        wet.cancel(claimAt(400f, 400f))
        idle()
        assertEquals(1, wet.pending)
        val last = fake.frames.last()
        assertTrue(last.wipe)
        assertEquals(1, last.runs.size)
    }

    @Test
    fun unclaimedStrokesGoOnTheirOwn() {
        stroke(400f, 400f, 1000, dx = 10f)
        assertEquals(1, wet.pending)
        // A page that lags a second behind still finds its stroke on screen…
        idleFor(1000)
        assertEquals(1, wet.pending)
        // …but one it never takes doesn't stay.
        idleFor(1000)
        assertEquals(0, wet.pending)
    }

    @Test
    fun turningItOffReleasesTheOverlayAfterAWhile() {
        wet.setParams(json.replace("\"on\":true", "\"on\":false"))
        idle()
        assertFalse(fake.released)
        idleFor(4500)
        assertTrue(fake.released)
    }

    @Test
    fun aPalmInTheSameGestureDoesNotBreakTheStroke() {
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 1000), false)
        wet.onTouch(ev2(MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), 405f to 400f, 900f to 700f, 1004), false)
        for (k in 1..20) wet.onTouch(ev2(MotionEvent.ACTION_MOVE, (405f + k * 5) to 400f, 900f to 700f, 1004L + k * 4), false)
        wet.onTouch(ev2(MotionEvent.ACTION_POINTER_UP or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), 505f to 400f, 900f to 700f, 1090), false)
        wet.onTouch(ev(MotionEvent.ACTION_MOVE, 520f, 400f, 0.5f, 1094), false)
        wet.onTouch(ev(MotionEvent.ACTION_UP, 525f, 400f, 0.5f, 1098), false)
        assertTrue(errors.isEmpty())
        assertTrue(failures.isEmpty())
        assertEquals(1, wet.pending)
        assertEquals(cx(525f) * 2, painted().last().first.toDouble(), 3.0)
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
        val starts = listOf(400f to 400f, 460f to 400f, 520f to 400f)
        starts.forEachIndexed { k, (x, y) -> stroke(x, y, 1000L + k * 100, dx = 22f) }
        val ids = starts.map { (x, y) -> claimAt(x, y) }
        assertEquals(3, ids.toSet().size)
        assertTrue(ids.all { it > 0 })
        wet.done(ids[1])
        idleFor(300)
        assertEquals(3, wet.pending) // the others aren't committed yet: nothing is wiped
        wet.done(ids[0])
        wet.done(ids[2])
        idleFor(300)
        assertEquals(0, wet.pending)
        assertEquals(1, fake.clears)
    }

    @Test
    fun androidCancellingTheGestureKeepsWhatWasDrawnForThePage() {
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 1000), false)
        val id = claimAt(400f, 400f)
        wet.onTouch(ev(MotionEvent.ACTION_MOVE, 460f, 430f, 0.6f, 1012), false)
        wet.onTouch(ev(MotionEvent.ACTION_CANCEL, 460f, 430f, 0.6f, 1016), false)
        assertEquals(1, wet.pending)
        wet.done(id)
        idleFor(300)
        assertEquals(0, wet.pending)
    }

    @Test
    fun renderErrorsNeverEscapeAndRepeatedOnesTurnWetInkOff() {
        fake.failRender = true
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 1000), false)
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 420f, 400f, 0.5f, 1100), false)
        assertTrue(failures.isEmpty())
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 440f, 400f, 0.5f, 1200), false)
        idle()
        assertEquals(3, errors.size)
        assertEquals(1, failures.size)
        assertTrue(fake.released)
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
        val second = claimAt(600f, 400f)
        wet.onTouch(ev(MotionEvent.ACTION_UP, 640f, 400f, 0.5f, 2010), false)
        wet.done(second)
        // The first is finished and never claimed: it is given up after a while, then all is wiped.
        idleFor(1800)
        assertEquals(0, wet.pending)
    }

    @Test
    fun movingOrZoomingThePageWipesCommittedInkRightAway() {
        stroke(400f, 400f, 1000)
        wet.done(claimAt(400f, 400f))
        wet.setParams(json.replace("\"zoom\":1.5", "\"zoom\":2"))
        idle()
        assertEquals(0, wet.pending)
        assertEquals(1, fake.clears)
    }
}
