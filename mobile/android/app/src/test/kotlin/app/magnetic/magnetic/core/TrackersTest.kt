package app.magnetic.magnetic.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TrackersTest {
    @Test
    fun parseTrackerList_acceptsTrackerProtocols_rejectsTheRest_deduplicates() {
        val (valid, invalid) = parseTrackerList(
            """udp://a.org:1337/announce
    udp://a.org:1337/announce/  https://b.org/announce, wss://c.org
    ftp://nope.org  udp://noport.org  hello"""
        )
        assertEquals(listOf("udp://a.org:1337/announce", "https://b.org/announce", "wss://c.org"), valid)
        assertEquals(listOf("ftp://nope.org", "udp://noport.org", "hello"), invalid)
    }

    @Test
    fun planTrackers_removedTrackersGo_extrasSkipDuplicatesOfOwn() {
        val plan = planTrackers(
            own = listOf("udp://own.org:1/announce", "udp://dead.org:1/announce"),
            added = listOf("wss://mine.org"),
            removed = listOf("udp://dead.org:1/announce"),
            global = listOf("udp://own.org:1/announce", "udp://global.org:1/announce"),
            useGlobal = true,
            isPrivate = false,
        )
        assertEquals(listOf("udp://own.org:1/announce"), plan.own)
        assertEquals(listOf("wss://mine.org", "udp://global.org:1/announce"), plan.extra)
    }

    @Test
    fun planTrackers_privateTorrentsAndOffSwitchSkipPreferencesList() {
        val own = listOf("https://private.org/announce?pk=1")
        val added = listOf("wss://mine.org")
        val global = listOf("udp://global.org:1/announce")
        assertEquals(listOf("wss://mine.org"), planTrackers(own, added, emptyList(), global, useGlobal = true, isPrivate = true).extra)
        assertEquals(listOf("wss://mine.org"), planTrackers(own, added, emptyList(), global, useGlobal = false, isPrivate = false).extra)
        assertEquals(listOf("wss://mine.org", "udp://global.org:1/announce"), planTrackers(own, added, emptyList(), global, true, false).extra)
    }

    @Test
    fun normaliseTracker_and_tidyError() {
        assertEquals("wss://x.org", normaliseTracker(" wss://x.org/ "))
        assertEquals("udp://x.org:1/", normaliseTracker("udp://x.org:1//")) // only one slash goes
        assertEquals("Connection refused", tidyError("connect ECONNREFUSED 1.2.3.4:80"))
    }

    @Test
    fun udpTrackersWithAndWithoutAnnounceCountAsOne() {
        val plan = planTrackers(
            own = listOf("udp://t.org:1337"),
            global = listOf("udp://t.org:1337/announce", "https://h.org/announce"),
        )
        assertEquals(listOf("https://h.org/announce"), plan.extra)
        assertEquals(listOf("udp://t.org:1337"), parseTrackerList("udp://t.org:1337 udp://T.org:1337/announce").valid)
        assertEquals("Couldn\u2019t connect", tidyError("Error connecting to wss://x.org"))
    }

    // tidyError cases the JS covered through noteEvent / instrumentTrackers
    @Test
    fun tidyError_mapsCommonFailures() {
        assertEquals("Not responding", tidyError("tracker request timed out (announce)"))
        assertEquals("Address not found", tidyError("getaddrinfo ENOTFOUND x"))
        assertEquals("Connection dropped", tidyError("socket hang up"))
        assertEquals("No response", tidyError(null))
        assertEquals("No response", tidyError(""))
        val long = "x".repeat(100)
        assertEquals("x".repeat(77) + "\u2026", tidyError(long))
        assertEquals("short", tidyError("short"))
    }

    @Test
    fun isValidTracker_followsUrlRules() {
        assertTrue(isValidTracker("udp://tracker.opentrackr.org:1337/announce"))
        assertTrue(isValidTracker("HTTP://Example.org/announce"))
        assertTrue(isValidTracker("udp://under_score.org:80"))
        assertFalse(isValidTracker("udp://noport.org"))
        assertFalse(isValidTracker("udp://a.org:99999"))
        assertFalse(isValidTracker("ftp://nope.org"))
        assertFalse(isValidTracker("hello"))
        assertFalse(isValidTracker("https://"))
        assertTrue(DEFAULT_TRACKERS.all(::isValidTracker))
    }

    @Test
    fun trackerKey_udpUsesLowercaseHostAndPort_othersKeepUrl() {
        assertEquals("udp://t.org:1337", trackerKey("udp://T.ORG:1337/announce/"))
        assertEquals("https://h.org/announce", trackerKey("https://h.org/announce/"))
        assertEquals("not a url", trackerKey("not a url"))
    }

    @Test
    fun mergeTrackers_unionInFirstSeenOrder_skippingNullsAndBlanks() {
        assertEquals(
            listOf("udp://a.org:1/announce", "wss://b.org"),
            mergeTrackers(listOf("udp://a.org:1/announce/", ""), null, listOf("udp://A.org:1", "wss://b.org/")),
        )
    }
}
