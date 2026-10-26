package io.github.s70rm3892.sumi

import kotlin.math.ceil
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Kotlin twin of src/core/modeler.ts (after Google's Ink Stroke Modeler): wobble smoothing,
 * resampling, a spring-mass pen tip and end-of-stroke catch-up. The wet ink drawn here must
 * match the stroke the page commits, so this is a line-for-line port; ModelerTest checks it
 * against the vectors the TypeScript test writes. Units: CSS px on screen and ms.
 */
data class ModelerParams(
    val wobbleWindow: Double = 40.0,
    val speedFloor: Double = 0.03,
    val speedCeiling: Double = 0.09,
    val springMass: Double = SPRING_MASS,
    val drag: Double = 2 * DAMPING / sqrt(SPRING_MASS),
    val minRate: Double = 480.0 / 1000,
    val stopDistance: Double = 0.05,
    val endIterations: Int = 40,
    val landDistance: Double = 1.5,
    val pressureSamples: Int = 20,
) {
    companion object {
        const val SPRING_MASS = (11.0 / 32400) * 1e6 * 0.15
        const val DAMPING = 0.66

        /** The pen tool's 手ぶれ補正 mapping (PenTool.modelParams). */
        fun forStabilization(k: Double): ModelerParams {
            val d = ModelerParams()
            val f = 1 + 3 * k
            return d.copy(wobbleWindow = d.wobbleWindow + 100 * k, speedFloor = d.speedFloor * f, speedCeiling = d.speedCeiling * f)
        }
    }
}

data class ModelPoint(val x: Double, val y: Double, val p: Double, val t: Double)

class Modeler(var params: ModelerParams = ModelerParams()) {
    private class Wob(val x: Double, val y: Double, val t: Double, val dist: Double, val dur: Double)
    private class Raw(val x: Double, val y: Double, val p: Double)
    private data class Tip(var x: Double, var y: Double, var vx: Double, var vy: Double, var t: Double)

    private val wob = ArrayDeque<Wob>()
    private var wsx = 0.0
    private var wsy = 0.0
    private var wdist = 0.0
    private var wdur = 0.0
    private var tip = Tip(0.0, 0.0, 0.0, 0.0, 0.0)
    private var ax = 0.0
    private var ay = 0.0
    private var at = 0.0
    private val raw = ArrayDeque<Raw>()
    private var lx = 0.0
    private var ly = 0.0
    private var lp = 0.5
    private var lt = 0.0

    fun reset(x: Double, y: Double, p: Double, t: Double): ModelPoint {
        wob.clear()
        wob.addLast(Wob(x, y, t, 0.0, 0.0))
        wsx = 0.0; wsy = 0.0; wdist = 0.0; wdur = 0.0
        tip = Tip(x, y, 0.0, 0.0, t)
        ax = x; ay = y; at = t
        raw.clear()
        raw.addLast(Raw(x, y, p))
        lx = x; ly = y; lp = p; lt = t
        return ModelPoint(x, y, p, t)
    }

    fun update(x: Double, y: Double, p: Double, tIn: Double): List<ModelPoint> {
        var t = tIn
        if (t <= lt) t = lt + 0.25
        lx = x; ly = y; lp = p; lt = t
        raw.addLast(Raw(x, y, p))
        if (raw.size > params.pressureSamples) raw.removeFirst()
        val (sx, sy) = smooth(x, y, t)
        val a0x = ax; val a0y = ay; val a0t = at
        val n = min(MAX_STEPS, max(1, ceil((t - a0t) * params.minRate).toInt()))
        val out = ArrayList<ModelPoint>(n)
        for (i in 1..n) {
            val k = i.toDouble() / n
            step(a0x + (sx - a0x) * k, a0y + (sy - a0y) * k, a0t + (t - a0t) * k)
            out.add(point())
        }
        ax = sx; ay = sy; at = t
        return out
    }

    fun predict(): List<ModelPoint> {
        val saved = tip.copy()
        val out = endOfStroke()
        tip = saved
        return out
    }

    fun finish(): List<ModelPoint> = endOfStroke()

    private fun smooth(x: Double, y: Double, t: Double): Pair<Double, Double> {
        val prev = wob.last()
        val dur = t - prev.t
        val s = Wob(x, y, t, hypot(x - prev.x, y - prev.y), dur)
        wob.addLast(s)
        wsx += x * dur
        wsy += y * dur
        wdist += s.dist
        wdur += dur
        while (wob.first().t < t - params.wobbleWindow) {
            val f = wob.removeFirst()
            wsx -= f.x * f.dur
            wsy -= f.y * f.dur
            wdist -= f.dist
            wdur -= f.dur
        }
        if (wdur <= 1e-9) return x to y
        val avx = wsx / wdur
        val avy = wsy / wdur
        val speed = wdist / wdur
        val k = min(1.0, max(0.0, (speed - params.speedFloor) / max(1e-9, params.speedCeiling - params.speedFloor)))
        return (avx + (x - avx) * k) to (avy + (y - avy) * k)
    }

    private fun step(axIn: Double, ayIn: Double, t: Double) {
        val s = tip
        val dt = t - s.t
        val accx = (axIn - s.x) / params.springMass - params.drag * s.vx
        val accy = (ayIn - s.y) / params.springMass - params.drag * s.vy
        s.vx += dt * accx
        s.vy += dt * accy
        s.x += dt * s.vx
        s.y += dt * s.vy
        s.t = t
    }

    private fun endOfStroke(): List<ModelPoint> {
        val out = ArrayList<ModelPoint>()
        var dt = 1 / params.minRate
        for (i in 0 until params.endIterations) {
            val prev = tip.copy()
            step(lx, ly, prev.t + dt)
            val c = tip
            val moved = hypot(c.x - prev.x, c.y - prev.y)
            if (moved < params.stopDistance) {
                tip = prev
                break
            }
            val dx = c.x - prev.x
            val dy = c.y - prev.y
            val u = ((lx - prev.x) * dx + (ly - prev.y) * dy) / (moved * moved)
            if (u < 1) {
                tip = prev
                dt *= 0.5
                continue
            }
            out.add(point())
            if (hypot(c.x - lx, c.y - ly) < params.stopDistance) break
        }
        val end = out.lastOrNull() ?: point()
        if (hypot(end.x - lx, end.y - ly) > params.landDistance) out.add(ModelPoint(lx, ly, lp, max(end.t, lt)))
        return out
    }

    private fun point(): ModelPoint = ModelPoint(tip.x, tip.y, pressureAt(tip.x, tip.y), tip.t)

    private fun pressureAt(x: Double, y: Double): Double {
        if (raw.size == 1) return raw.first().p
        var best = Double.POSITIVE_INFINITY
        var p = raw.last().p
        for (i in 0 until raw.size - 1) {
            val a = raw[i]
            val b = raw[i + 1]
            val dx = b.x - a.x
            val dy = b.y - a.y
            val l = dx * dx + dy * dy
            val u = if (l > 0) min(1.0, max(0.0, ((x - a.x) * dx + (y - a.y) * dy) / l)) else 0.0
            val qx = a.x + dx * u
            val qy = a.y + dy * u
            val d = (x - qx) * (x - qx) + (y - qy) * (y - qy)
            if (d <= best) {
                best = d
                p = a.p + (b.p - a.p) * u
            }
        }
        return p
    }

    private companion object {
        const val MAX_STEPS = 400
    }
}
