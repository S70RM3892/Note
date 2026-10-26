package io.github.s70rm3892.sumi

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Modeler.kt must give the same points as src/core/modeler.ts (vectors written by the TS test). */
@RunWith(RobolectricTestRunner::class)
class ModelerTest {
    private fun params(o: JSONObject) = ModelerParams(
        wobbleWindow = o.getDouble("wobbleWindow"),
        speedFloor = o.getDouble("speedFloor"),
        speedCeiling = o.getDouble("speedCeiling"),
        springMass = o.getDouble("springMass"),
        drag = o.getDouble("drag"),
        minRate = o.getDouble("minRate"),
        stopDistance = o.getDouble("stopDistance"),
        endIterations = o.getInt("endIterations"),
        landDistance = o.getDouble("landDistance"),
        pressureSamples = o.getInt("pressureSamples"),
    )

    private fun assertPoints(name: String, expected: JSONArray, actual: List<ModelPoint>) {
        assertEquals("$name: count", expected.length(), actual.size)
        for (i in 0 until expected.length()) {
            val e = expected.getJSONObject(i)
            val a = actual[i]
            assertEquals("$name[$i].x", e.getDouble("x"), a.x, 1e-6)
            assertEquals("$name[$i].y", e.getDouble("y"), a.y, 1e-6)
            assertEquals("$name[$i].p", e.getDouble("p"), a.p, 1e-6)
            assertEquals("$name[$i].t", e.getDouble("t"), a.t, 1e-6)
        }
    }

    @Test
    fun matchesTheTypeScriptModeler() {
        val text = javaClass.classLoader!!.getResource("modeler_vectors.json").readText()
        val cases = JSONArray(text)
        for (c in 0 until cases.length()) {
            val case = cases.getJSONObject(c)
            val name = case.getString("name")
            val m = Modeler(params(case.getJSONObject("params")))
            val input = case.getJSONArray("input")
            val predictAt = case.getInt("predictAt")
            fun inp(i: Int) = input.getJSONArray(i).let { DoubleArray(4) { k -> it.getDouble(k) } }
            val first = inp(0)
            val out = mutableListOf(m.reset(first[0], first[1], first[2], first[3]))
            var predicted: List<ModelPoint> = emptyList()
            for (i in 1 until input.length()) {
                val s = inp(i)
                out += m.update(s[0], s[1], s[2], s[3])
                if (i == predictAt) predicted = m.predict()
            }
            if (predictAt == 0) predicted = m.predict()
            out += m.finish()
            assertPoints(name, case.getJSONArray("output"), out)
            assertPoints("$name/predict", case.getJSONArray("predicted"), predicted)
        }
    }

    @Test
    fun stabilizationMappingMatchesThePenTool() {
        val p = ModelerParams.forStabilization(0.25)
        assertEquals(65.0, p.wobbleWindow, 1e-9)
        assertEquals(0.03 * 1.75, p.speedFloor, 1e-12)
        assertEquals(0.09 * 1.75, p.speedCeiling, 1e-12)
    }
}
