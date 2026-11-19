package app.magnetic.magnetic.engine

import org.junit.Assert.assertEquals
import org.junit.Test

class ScheduleTest {
    private fun e(ih: String, added: Long, paused: Boolean = false, complete: Boolean = false, running: Boolean = false) =
        ScheduleInput(ih, paused, complete, running, added)

    private fun run(
        list: List<ScheduleInput>, watching: String? = null, max: Int = 0, hold: Boolean = true, uploads: Boolean = false,
    ) = schedule(list, watching, max, hold, uploads)

    @Test fun noLimitRunsEverythingUnpaused() {
        val d = run(listOf(e("a", 1), e("b", 2), e("c", 3, paused = true)))
        assertEquals(Decision(true, null), d["a"])
        assertEquals(Decision(true, null), d["b"])
        assertEquals(Decision(false, null), d["c"])
    }

    @Test fun limitStartsOldestFirstAndQueuesTheRest() {
        val d = run(listOf(e("new", 3), e("old", 1), e("mid", 2)), max = 2)
        assertEquals(true, d["old"]!!.run)
        assertEquals(true, d["mid"]!!.run)
        assertEquals(Decision(false, "limit"), d["new"])
    }

    @Test fun runningTorrentsKeepTheirSlotBeforeOlderWaitingOnes() {
        val d = run(listOf(e("old", 1), e("busy", 5, running = true)), max = 1)
        assertEquals(true, d["busy"]!!.run)
        assertEquals("limit", d["old"]!!.queued)
    }

    @Test fun watchingHoldsOtherDownloads() {
        val d = run(listOf(e("a", 1), e("film", 2)), watching = "film")
        assertEquals(true, d["film"]!!.run)
        assertEquals(Decision(false, "watching"), d["a"])
    }

    @Test fun holdOffLetsOthersRunWhileWatching() {
        val d = run(listOf(e("a", 1), e("film", 2)), watching = "film", hold = false)
        assertEquals(true, d["a"]!!.run)
    }

    @Test fun watchingACompleteTorrentDoesNotHoldOthers() {
        val d = run(listOf(e("a", 1), e("film", 2, complete = true)), watching = "film")
        assertEquals(true, d["a"]!!.run)
        assertEquals(true, d["film"]!!.run) // the watched torrent always gets a slot
    }

    @Test fun finishedTorrentsSeedOnlyWithUploadsOn() {
        assertEquals(Decision(false, null), run(listOf(e("done", 1, complete = true)))["done"])
        assertEquals(Decision(true, null), run(listOf(e("done", 1, complete = true)), uploads = true)["done"])
    }

    @Test fun seedingDoesNotUseADownloadSlot() {
        val d = run(listOf(e("done", 1, complete = true), e("dl", 2)), max = 1, uploads = true)
        assertEquals(true, d["done"]!!.run)
        assertEquals(true, d["dl"]!!.run)
    }
}
