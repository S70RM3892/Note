package io.github.s70rm3892.sumi

import android.view.MotionEvent

/**
 * Chromium gives every touch sequence that *starts* with a stylus whose side button is held to
 * its stylus text selector and never forwards it to the page ("Always return true … This
 * prevents forwarding of a partial touch stream", content/browser/renderer_host/input/
 * stylus_text_selector.cc). In a WebView, "hold the button and write" therefore does nothing.
 *
 * This rewrites such gestures before the WebView sees them: the side-button bits are cleared,
 * and when the button means "eraser" the pen pointer becomes TOOL_TYPE_ERASER, which Blink
 * reports as a pen with the eraser bit set (`buttons & 32`). The signal travels inside the
 * event, so the page can't see the stroke before it learns about the button. The decision is
 * made when the pointer goes down and kept until it goes up, so each pointer's stream stays
 * consistent even if the button is released mid-stroke.
 */
class StylusButtonFilter {
    companion object {
        const val SIDE_BUTTONS = MotionEvent.BUTTON_STYLUS_PRIMARY or MotionEvent.BUTTON_SECONDARY
    }

    /** What the page does with the side button: "eraser", "lasso" or "none". */
    @Volatile
    var action: String = "eraser"

    /** Pointer ids (of the current gesture) that are being reported as an eraser. */
    private val eraserIds = HashSet<Int>()

    /** A rewritten copy of [ev] (the caller recycles it), or null to pass [ev] through as is. */
    fun filter(ev: MotionEvent): MotionEvent? {
        val masked = ev.actionMasked
        if (masked == MotionEvent.ACTION_DOWN) eraserIds.clear()
        if (masked == MotionEvent.ACTION_DOWN || masked == MotionEvent.ACTION_POINTER_DOWN) {
            val i = ev.actionIndex
            if (ev.getToolType(i) == MotionEvent.TOOL_TYPE_STYLUS && ev.buttonState and SIDE_BUTTONS != 0 && action == "eraser") {
                eraserIds.add(ev.getPointerId(i))
            }
        }
        val strip = ev.buttonState and SIDE_BUTTONS != 0 && hasStylus(ev)
        val out = if (eraserIds.isNotEmpty() || strip) rewrite(ev) else null
        when (masked) {
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> eraserIds.clear()
            MotionEvent.ACTION_POINTER_UP -> eraserIds.remove(ev.getPointerId(ev.actionIndex))
        }
        return out
    }

    private fun hasStylus(ev: MotionEvent): Boolean =
        (0 until ev.pointerCount).any { ev.getToolType(it) == MotionEvent.TOOL_TYPE_STYLUS }

    /** Same event, history included, with eraser pointers retyped and the side-button bits cleared. */
    private fun rewrite(ev: MotionEvent): MotionEvent {
        val n = ev.pointerCount
        val props = Array(n) { i ->
            MotionEvent.PointerProperties().also { p ->
                ev.getPointerProperties(i, p)
                if (p.id in eraserIds) p.toolType = MotionEvent.TOOL_TYPE_ERASER
            }
        }
        val coords = Array(n) { MotionEvent.PointerCoords() }
        val h = ev.historySize
        fun fill(pos: Int) {
            for (i in 0 until n) {
                if (pos < h) ev.getHistoricalPointerCoords(i, pos, coords[i]) else ev.getPointerCoords(i, coords[i])
            }
        }
        fun time(pos: Int) = if (pos < h) ev.getHistoricalEventTime(pos) else ev.eventTime
        fill(0)
        val out = MotionEvent.obtain(
            ev.downTime, time(0), ev.action, n, props, coords, ev.metaState,
            ev.buttonState and SIDE_BUTTONS.inv(), ev.xPrecision, ev.yPrecision,
            ev.deviceId, ev.edgeFlags, ev.source, ev.flags,
        )
        for (pos in 1..h) {
            fill(pos)
            out.addBatch(time(pos), coords, ev.metaState)
        }
        return out
    }
}
