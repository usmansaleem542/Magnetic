// Port of web-app/lib/trackers.js (list handling and error tidying; live status is not ported).
package app.magnetic.magnetic.core

import java.net.URI

val DEFAULT_TRACKERS: List<String> = listOf(
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://exodus.desync.com:6969/announce",
    "wss://tracker.openwebtorrent.com",
    "wss://tracker.webtorrent.dev",
)

private val PROTOCOLS = setOf("http", "https", "udp", "ws", "wss")

// JS String.prototype.trim and \s also cover U+FEFF, which Kotlin's isWhitespace does not.
private fun isJsSpace(c: Char) = c.isWhitespace() || c == '﻿'

/** bittorrent-tracker drops one trailing slash; match it so URLs compare equal. */
fun normaliseTracker(url: String): String {
    val s = url.trim(::isJsSpace)
    return if (s.endsWith("/")) s.dropLast(1) else s
}

/** The bits of a WHATWG URL the tracker logic uses: lowercase scheme, hostname, port ("" if none). */
internal data class TrackerUrl(val scheme: String, val hostname: String, val port: String)

private val DEFAULT_PORTS = mapOf("http" to 80, "https" to 443, "ws" to 80, "wss" to 443)

internal fun parseTrackerUrl(url: String): TrackerUrl? {
    val uri = try { URI(url) } catch (e: Exception) { return null }
    val scheme = uri.scheme?.lowercase() ?: return null
    var host: String? = uri.host
    var port: Int = uri.port
    if (host == null) {
        // java.net.URI gives up on hosts that aren't strict RFC 2396 (e.g. underscores);
        // WHATWG URL accepts them, so split the authority ourselves.
        // No authority at all ("udp:x", "udp:///x"): WHATWG gives non-special schemes an empty host.
        val auth = uri.rawAuthority ?: return if (scheme in DEFAULT_PORTS) null else TrackerUrl(scheme, "", "")
        val hostPort = auth.substringAfterLast('@')
        val colon = if (hostPort.startsWith("[")) hostPort.indexOf(':', hostPort.indexOf(']').coerceAtLeast(0)) else hostPort.lastIndexOf(':')
        host = if (colon >= 0) hostPort.substring(0, colon) else hostPort
        port = -1
        if (colon >= 0) {
            val p = hostPort.substring(colon + 1)
            if (p.isNotEmpty()) {
                if (!p.all { it in '0'..'9' }) return null
                port = p.toIntOrNull()?.takeIf { it <= 65535 } ?: return null
            }
        }
    }
    if (port > 65535) return null // WHATWG rejects out-of-range ports; java.net.URI doesn't
    // WHATWG URL lowercases hosts of special schemes and hides their default port
    val special = scheme in DEFAULT_PORTS
    if (special && host.isEmpty()) return null
    val hostname = if (special) host.lowercase() else host
    val portStr = if (port < 0 || (special && DEFAULT_PORTS[scheme] == port)) "" else port.toString()
    return TrackerUrl(scheme, hostname, portStr)
}

/** Identity for de-duplication: UDP trackers ignore the path, so host and port decide. */
fun trackerKey(url: String): String {
    val n = normaliseTracker(url)
    val u = parseTrackerUrl(n)
    if (u != null && u.scheme == "udp") return "udp://${u.hostname.lowercase()}:${u.port}"
    return n
}

fun isValidTracker(url: String): Boolean {
    val u = parseTrackerUrl(url) ?: return false
    return u.scheme in PROTOCOLS && u.hostname.isNotEmpty() && (u.scheme != "udp" || u.port.isNotEmpty())
}

data class ParsedTrackers(val valid: List<String>, val invalid: List<String>)

private val LIST_SPLIT = Regex("[\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF,]+") // JS \\s, spelled out: Android regex has no (?U)

/** Split pasted text (lines, spaces or commas) into valid and invalid tracker URLs, de-duplicated. */
fun parseTrackerList(text: String): ParsedTrackers {
    val valid = mutableListOf<String>()
    val invalid = mutableListOf<String>()
    for (raw in text.split(LIST_SPLIT)) {
        if (raw.isEmpty()) continue
        val url = normaliseTracker(raw)
        if (!isValidTracker(url)) {
            if (raw !in invalid) invalid.add(raw)
            continue
        }
        if (valid.none { trackerKey(it) == trackerKey(url) }) valid.add(url)
    }
    return ParsedTrackers(valid, invalid)
}

/** Union of lists, normalised, in first-seen order. */
fun mergeTrackers(vararg lists: List<String>?): List<String> {
    val out = mutableListOf<String>()
    val keys = HashSet<String>()
    for (list in lists) for (u in list.orEmpty()) {
        val n = normaliseTracker(u)
        if (n.isEmpty() || !keys.add(trackerKey(n))) continue
        out.add(n)
    }
    return out
}

data class TrackerPlan(val own: List<String>, val extra: List<String>)

/**
 * Trackers for one torrent: its own (minus removed) and the extra ones we announce to.
 * Private torrents never get the Preferences list: that would leak them to public trackers.
 */
fun planTrackers(
    own: List<String> = emptyList(),
    added: List<String> = emptyList(),
    removed: List<String> = emptyList(),
    global: List<String> = emptyList(),
    useGlobal: Boolean = true,
    isPrivate: Boolean = false,
): TrackerPlan {
    val gone = removed.map(::trackerKey).toSet()
    val ownList = mergeTrackers(own).filter { trackerKey(it) !in gone }
    val ownKeys = ownList.map(::trackerKey).toSet()
    val extra = mergeTrackers(added, if (useGlobal && !isPrivate) global else emptyList())
        .filter { trackerKey(it) !in gone && trackerKey(it) !in ownKeys }
    return TrackerPlan(ownList, extra)
}

private val TIMED_OUT = Regex("timed out", RegexOption.IGNORE_CASE)
private val NOT_FOUND = Regex("ENOTFOUND|EAI_AGAIN|getaddrinfo", RegexOption.IGNORE_CASE)
private val REFUSED = Regex("ECONNREFUSED", RegexOption.IGNORE_CASE)
private val RESET = Regex("ECONNRESET|socket hang up", RegexOption.IGNORE_CASE)
private val CONNECT = Regex("Connection error|Error connecting", RegexOption.IGNORE_CASE)

/** A short, human message for a tracker failure. */
fun tidyError(message: String?): String {
    val m = if (message.isNullOrEmpty()) "No response" else message
    return when {
        TIMED_OUT.containsMatchIn(m) -> "Not responding"
        NOT_FOUND.containsMatchIn(m) -> "Address not found"
        REFUSED.containsMatchIn(m) -> "Connection refused"
        RESET.containsMatchIn(m) -> "Connection dropped"
        CONNECT.containsMatchIn(m) -> "Couldn’t connect"
        m.length > 80 -> m.substring(0, 77) + "…"
        else -> m
    }
}
