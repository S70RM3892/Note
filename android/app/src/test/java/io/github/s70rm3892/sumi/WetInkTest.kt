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
        override fun isValid() = true
        override fun place(x: Int, y: Int, w: Int, h: Int) { place = intArrayOf(x, y, w, h) }
        override fun render(frame: WetFrame) { frames += frame }
        override fun clear() { clears++ }
        override fun recordAndPredict(ev: MotionEvent): MotionEvent? = null
        override fun release() { released = true }
    }

    private lateinit var container: FrameLayout
    private lateinit var fake: FakeSurface
    private lateinit var wet: WetInk
    private var created = intArrayOf()

    // The page: writing area below a 56 px toolbar, DPR 2, zoom 1.5, ballpoint 2.2.
    private val json = """{"on":true,"rect":[0,56,1280,744],"dpr":2,"zoom":1.5,"color":"#1e4fd8","style":"ballpoint","width":2.2,"gamma":0.8,"stab":0.25}"""

    @Before
    fun setUp() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        container = FrameLayout(activity)
        activity.setContentView(container)
        fake = FakeSurface()
        wet = WetInk(container, onFail = {}) { _, x, y, w, h -> created = intArrayOf(x, y, w, h); fake }
        wet.setParams(json)
        idle()
    }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

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
        assertTrue(wet.claim())
        assertFalse(wet.claim())
        wet.onTouch(ev(MotionEvent.ACTION_MOVE, 460f, 430f, 0.6f, 1012, history = listOf(Triple(420f, 410f, 1004L), Triple(440f, 420f, 1008L))), false)
        wet.onTouch(ev(MotionEvent.ACTION_UP, 470f, 432f, 0.3f, 1016), false)
        assertEquals(1, wet.pending)
        wet.done()
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
        val loc = IntArray(2).also { container.getLocationInWindow(it) }
        fun cx(x: Float) = (x - loc[0]) / 2.0
        fun cy(y: Float) = (y - loc[1]) / 2.0 - 56
        val m = Modeler(ModelerParams.forStabilization(0.25))
        val p = 0.5.pow(0.8)
        val out = mutableListOf(m.reset(cx(400f), cy(400f), p, 1000.0))
        for (q in pts.drop(1)) out += m.update(cx(q.first), cy(q.second), p, q.third.toDouble())
        out += m.update(cx(520f), cy(450f), p, 1016.0)
        out += m.finish()
        // Both the page and the wet ink drop points closer than 0.45 screen px to the last kept one.
        val kept = mutableListOf(out[0])
        for (q in out.drop(1)) if (kotlin.math.hypot(q.x - kept.last().x, q.y - kept.last().y) >= 0.45) kept += q
        val drawn = fake.frames.last().add!!
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
        assertFalse(wet.claim())
        wet.onTouch(ev(MotionEvent.ACTION_UP, 400f, 20f, 0.5f, 1004), false)
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 2000), true) // side button (lasso)
        assertFalse(wet.claim())
        wet.onTouch(ev(MotionEvent.ACTION_UP, 400f, 400f, 0.5f, 2004), true)
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 3000, tool = MotionEvent.TOOL_TYPE_ERASER), false)
        assertFalse(wet.claim())
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 4000, tool = MotionEvent.TOOL_TYPE_FINGER), false)
        assertFalse(wet.claim())
        assertEquals(0, wet.pending)
        assertTrue(fake.frames.isEmpty())
    }

    @Test
    fun cancelDropsTheStroke() {
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 1000), false)
        assertTrue(wet.claim())
        wet.cancel()
        idle()
        assertEquals(0, wet.pending)
        wet.onTouch(ev(MotionEvent.ACTION_MOVE, 460f, 430f, 0.6f, 1012), false) // further moves draw nothing
        assertEquals(1, fake.frames.size)
    }

    @Test
    fun unclaimedStrokesDisappearOnTheirOwn() {
        wet.onTouch(ev(MotionEvent.ACTION_DOWN, 400f, 400f, 0.5f, 1000), false)
        wet.onTouch(ev(MotionEvent.ACTION_UP, 410f, 400f, 0.5f, 1004), false)
        assertEquals(1, wet.pending)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(600))
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
}
