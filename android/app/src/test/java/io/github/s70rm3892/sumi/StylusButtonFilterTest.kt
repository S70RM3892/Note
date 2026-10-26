package io.github.s70rm3892.sumi

import android.view.InputDevice
import android.view.MotionEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class StylusButtonFilterTest {
    private val stylus = MotionEvent.TOOL_TYPE_STYLUS
    private val finger = MotionEvent.TOOL_TYPE_FINGER

    private fun event(
        action: Int,
        buttons: Int,
        pointers: List<Pair<Int, Int>>, // (id, toolType)
        x: Float = 100f,
        history: List<Float> = emptyList(), // earlier x positions batched into this event
        t: Long = 1000,
    ): MotionEvent {
        val props = pointers.map { (id, tool) -> MotionEvent.PointerProperties().apply { this.id = id; toolType = tool } }.toTypedArray()
        fun coords(px: Float) = pointers.indices.map { i ->
            MotionEvent.PointerCoords().apply { this.x = px + i * 50; y = 200f; pressure = 0.6f; setAxisValue(MotionEvent.AXIS_TILT, 0.3f) }
        }.toTypedArray()
        val xs = history + x
        val ev = MotionEvent.obtain(
            0, t - xs.size + 1, action, pointers.size, props, coords(xs[0]), 0, buttons,
            1f, 1f, 0, 0, InputDevice.SOURCE_STYLUS or InputDevice.SOURCE_TOUCHSCREEN, 0,
        )
        for (k in 1 until xs.size) ev.addBatch(t - xs.size + 1 + k, coords(xs[k]), 0)
        return ev
    }

    @Test
    fun buttonHeldAtDownBecomesAnEraserForTheWholeStroke() {
        val f = StylusButtonFilter()
        val down = f.filter(event(MotionEvent.ACTION_DOWN, MotionEvent.BUTTON_STYLUS_PRIMARY, listOf(0 to stylus)))
        assertNotNull(down)
        assertEquals(MotionEvent.TOOL_TYPE_ERASER, down!!.getToolType(0))
        assertEquals(0, down.buttonState)
        assertEquals(0.6f, down.pressure, 1e-6f)
        assertEquals(0.3f, down.getAxisValue(MotionEvent.AXIS_TILT), 1e-6f)

        // Button released mid-stroke: still the eraser until the pen lifts; batched samples kept.
        val move = f.filter(event(MotionEvent.ACTION_MOVE, 0, listOf(0 to stylus), x = 140f, history = listOf(110f, 120f, 130f)))!!
        assertEquals(MotionEvent.TOOL_TYPE_ERASER, move.getToolType(0))
        assertEquals(3, move.historySize)
        assertEquals(110f, move.getHistoricalX(0), 1e-4f)
        assertEquals(130f, move.getHistoricalX(2), 1e-4f)
        assertEquals(140f, move.x, 1e-4f)
        assertEquals(1000L, move.eventTime)
        assertEquals(997L, move.getHistoricalEventTime(0))

        val up = f.filter(event(MotionEvent.ACTION_UP, 0, listOf(0 to stylus)))!!
        assertEquals(MotionEvent.TOOL_TYPE_ERASER, up.getToolType(0))

        // Next stroke without the button is left alone.
        assertNull(f.filter(event(MotionEvent.ACTION_DOWN, 0, listOf(0 to stylus))))
        assertNull(f.filter(event(MotionEvent.ACTION_MOVE, 0, listOf(0 to stylus))))
    }

    @Test
    fun secondaryButtonFromOlderDriversCountsToo() {
        val f = StylusButtonFilter()
        val down = f.filter(event(MotionEvent.ACTION_DOWN, MotionEvent.BUTTON_SECONDARY, listOf(0 to stylus)))!!
        assertEquals(MotionEvent.TOOL_TYPE_ERASER, down.getToolType(0))
        assertEquals(0, down.buttonState)
    }

    @Test
    fun lassoActionOnlyHidesTheButtonFromChromium() {
        val f = StylusButtonFilter().apply { action = "lasso" }
        val down = f.filter(event(MotionEvent.ACTION_DOWN, MotionEvent.BUTTON_STYLUS_PRIMARY, listOf(0 to stylus)))!!
        assertEquals(stylus, down.getToolType(0))
        assertEquals(0, down.buttonState)
        val move = f.filter(event(MotionEvent.ACTION_MOVE, MotionEvent.BUTTON_STYLUS_PRIMARY, listOf(0 to stylus)))!!
        assertEquals(0, move.buttonState)
        // Button already released: nothing to rewrite.
        assertNull(f.filter(event(MotionEvent.ACTION_UP, 0, listOf(0 to stylus))))
    }

    @Test
    fun fingersAndPlainPenPassThrough() {
        val f = StylusButtonFilter()
        assertNull(f.filter(event(MotionEvent.ACTION_DOWN, 0, listOf(0 to finger))))
        assertNull(f.filter(event(MotionEvent.ACTION_UP, 0, listOf(0 to finger))))
        assertNull(f.filter(event(MotionEvent.ACTION_DOWN, 0, listOf(0 to stylus))))
    }

    @Test
    fun penJoiningAPalmTouchIsConvertedOnlyForItsOwnPointer() {
        val f = StylusButtonFilter()
        assertNull(f.filter(event(MotionEvent.ACTION_DOWN, 0, listOf(0 to finger))))
        val pd = MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)
        val both = f.filter(event(pd, MotionEvent.BUTTON_STYLUS_PRIMARY, listOf(0 to finger, 1 to stylus)))!!
        assertEquals(finger, both.getToolType(0))
        assertEquals(MotionEvent.TOOL_TYPE_ERASER, both.getToolType(1))
        assertEquals(pd, both.action)
        assertEquals(150f, both.getX(1), 1e-4f)
        val pu = MotionEvent.ACTION_POINTER_UP or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)
        assertNotNull(f.filter(event(pu, 0, listOf(0 to finger, 1 to stylus))))
        // The pen is gone; the palm's remaining events are untouched.
        assertNull(f.filter(event(MotionEvent.ACTION_MOVE, 0, listOf(0 to finger))))
    }
}
