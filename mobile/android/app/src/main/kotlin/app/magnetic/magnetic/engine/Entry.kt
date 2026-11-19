package app.magnetic.magnetic.engine

import org.json.JSONArray
import org.json.JSONObject

/** File as remembered between runs (desktop `entry.files`). */
data class SavedFile(val name: String, val path: String, val length: Long, val progress: Double)

/** One torrent in the library, persisted in state.json (same fields as the desktop app). */
class Entry(
    val infoHash: String,
    var magnet: String,
    var torrentFile: String?,
    var name: String,
    var path: String,
    var paused: Boolean,
    var deselected: MutableList<Int>,
    var length: Long,
    var progress: Double,
    var files: List<SavedFile>,
    val addedAt: Long,
) {
    var uploaded = 0L
    var uploadedBase = 0L
    var spaceChecked = false
    var notified = false
    var queued: String? = null
    var seedLimitReached = false
    var ownTrackers: List<String> = emptyList()
    var addedTrackers: List<String> = emptyList()
    var removedTrackers: List<String> = emptyList()

    fun toJson(): JSONObject = JSONObject().apply {
        put("infoHash", infoHash); put("magnet", magnet); put("torrentFile", torrentFile ?: JSONObject.NULL)
        put("name", name); put("path", path); put("paused", paused); put("deselected", JSONArray(deselected))
        put("length", length); put("progress", progress); put("addedAt", addedAt)
        put("files", JSONArray(files.map { JSONObject().put("name", it.name).put("path", it.path).put("length", it.length).put("progress", it.progress) }))
        put("uploaded", uploaded); put("uploadedBase", uploadedBase); put("spaceChecked", spaceChecked); put("notified", notified)
        put("queued", queued ?: JSONObject.NULL); put("seedLimitReached", seedLimitReached)
        put("ownTrackers", JSONArray(ownTrackers)); put("addedTrackers", JSONArray(addedTrackers)); put("removedTrackers", JSONArray(removedTrackers))
    }

    companion object {
        fun fromJson(o: JSONObject) = Entry(
            infoHash = o.getString("infoHash"),
            magnet = o.optString("magnet"),
            torrentFile = o.optString("torrentFile").takeIf { it.isNotEmpty() && it != "null" },
            name = o.optString("name"),
            path = o.optString("path"),
            paused = o.optBoolean("paused"),
            deselected = o.optJSONArray("deselected").ints().toMutableList(),
            length = o.optLong("length"),
            progress = o.optDouble("progress", 0.0).let { if (it.isNaN()) 0.0 else it },
            files = o.optJSONArray("files").objects().map {
                SavedFile(it.optString("name"), it.optString("path"), it.optLong("length"), it.optDouble("progress", 0.0))
            },
            addedAt = o.optLong("addedAt", System.currentTimeMillis()),
        ).apply {
            uploaded = o.optLong("uploaded"); uploadedBase = o.optLong("uploadedBase")
            spaceChecked = o.optBoolean("spaceChecked"); notified = o.optBoolean("notified")
            queued = o.optString("queued").takeIf { it == "watching" || it == "limit" }
            seedLimitReached = o.optBoolean("seedLimitReached")
            ownTrackers = o.optJSONArray("ownTrackers").strings()
            addedTrackers = o.optJSONArray("addedTrackers").strings()
            removedTrackers = o.optJSONArray("removedTrackers").strings()
        }
    }
}

fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).map { getString(it) }
fun JSONArray?.ints(): List<Int> = if (this == null) emptyList() else (0 until length()).map { getInt(it) }
fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).map { getJSONObject(it) }

/** Converts org.json values to plain Kotlin maps/lists for the Flutter method channel. */
fun Any?.toPlain(): Any? = when (this) {
    is JSONObject -> keys().asSequence().associateWith { get(it).toPlain() }
    is JSONArray -> (0 until length()).map { get(it).toPlain() }
    JSONObject.NULL -> null
    else -> this
}
