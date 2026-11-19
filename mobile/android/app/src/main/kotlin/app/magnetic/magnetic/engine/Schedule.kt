package app.magnetic.magnetic.engine

/**
 * Port of `schedule()` in web-app/main.js: decides which torrents run, which wait in the queue
 * (and why), and which stop. Pure so it can be tested; Engine applies the result.
 */
data class ScheduleInput(
    val infoHash: String,
    val paused: Boolean,
    val complete: Boolean,
    val running: Boolean,
    val addedAt: Long,
)

data class Decision(val run: Boolean, val queued: String?) // queued: "watching" | "limit" | null

fun schedule(
    entries: List<ScheduleInput>,
    watching: String?,
    maxActiveDownloads: Int,
    pauseOthersWhileWatching: Boolean,
    allowUploads: Boolean,
): Map<String, Decision> {
    val slotsTotal = if (maxActiveDownloads > 0) maxActiveDownloads else Int.MAX_VALUE
    val watched = entries.firstOrNull { it.infoHash == watching }
    val holding = watched != null && !watched.paused && !watched.complete && pauseOthersWhileWatching

    val allowed = mutableSetOf<String>()
    var slots = slotsTotal
    if (watched != null && !watched.paused) {
        allowed += watched.infoHash
        slots--
    }
    if (!holding) {
        entries.filter { !it.paused && !it.complete && it.infoHash !in allowed }
            .sortedWith(compareBy<ScheduleInput> { if (it.running) 0 else 1 }.thenBy { it.addedAt })
            .forEach { if (slots > 0) { allowed += it.infoHash; slots-- } }
    }

    return entries.associate { e ->
        e.infoHash to when {
            e.paused -> Decision(run = false, queued = null)
            e.infoHash in allowed || (e.complete && allowUploads) -> Decision(run = true, queued = null)
            e.complete -> Decision(run = false, queued = null) // uploads off: finished torrents go offline
            else -> Decision(run = false, queued = if (holding) "watching" else "limit")
        }
    }
}
