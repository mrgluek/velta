package org.velta.tunnelhelper

import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Turns the router's status JSON (tunnel.Status) into text for people. */
object StatusText {
    fun oneLine(s: JSONObject): String {
        if (!s.optBoolean("running")) return "not running"
        val session = if (s.optBoolean("session")) "up" else "down"
        return "route ${s.optString("route")} · ${stateName(s.optString("state"))} · tunnel $session"
    }

    fun full(s: JSONObject): String {
        if (!s.optBoolean("running")) return "Proxy is not running."
        val sb = StringBuilder()
        sb.append("Route: ${s.optString("route").uppercase()} since ${clock(s.optString("route_since"))}")
            .append(" (mode ${s.optString("mode")})\n")
        sb.append("Network: ${stateName(s.optString("state"))}\n")
        val probe = s.optString("last_probe")
        if (!probe.startsWith("0001-")) {
            val r = s.optJSONObject("last_result") ?: JSONObject()
            // Allowlisted sites are only checked when no probe host answered.
            val canary = when {
                !r.optBoolean("canary_checked") -> ""
                r.optBoolean("canary_ok") -> ", allowlisted sites answer"
                else -> ", allowlisted sites silent"
            }
            sb.append("Last check ${clock(probe)}: probe hosts ${r.optInt("relay_ok")}/${r.optInt("relays")} ok$canary\n")
        }
        sb.append("Probe hosts: ${list(s.optJSONArray("relays")).ifEmpty { "none yet" }}\n")
        sb.append("Tunnel session: ${if (s.optBoolean("session")) "up" else "down"}, ")
            .append("${s.optInt("resolvers")} resolvers, operator ${s.optString("operator").ifEmpty { "?" }}\n")
        sb.append("Network resolvers: ${list(s.optJSONArray("network_resolvers")).ifEmpty { "none" }}\n")
        if (s.optBoolean("dns_intercepted")) {
            val via = s.optString("dns_egress")
            sb.append("This network intercepts DNS${if (via.isNotEmpty()) " (answered via $via)" else ""}\n")
        }
        val active = s.optJSONObject("active") ?: JSONObject()
        sb.append("Open connections: direct ${active.optInt("direct")}, tunnel ${active.optInt("tunnel")}\n")
        val stats = s.optJSONObject("stats") ?: JSONObject()
        for (route in listOf("direct", "tunnel")) {
            val r = stats.optJSONObject(route) ?: continue
            sb.append("${route.replaceFirstChar { it.uppercase() }}: ${r.optLong("conns")} conns, ${r.optLong("fails")} failed, ")
                .append("up ${bytes(r.optLong("up"))}, down ${bytes(r.optLong("down"))}\n")
        }

        val paths = s.optJSONArray("paths") ?: JSONArray()
        if (paths.length() > 0) {
            // Narrow enough for a phone in portrait: the port is implied by the
            // transport (dot = 853, else 53), the resolver column is as wide as
            // the longest address, loss is a percentage. "len" is the path's
            // current query-name cap, to see soar grow it from 101 to 253.
            sb.append("\nResolver paths (working first):\n")
            val rows = (0 until paths.length()).map { paths.getJSONObject(it) }.sortedWith(
                compareByDescending<JSONObject> { working(it) }.thenByDescending { it.optInt("successes") },
            )
            val names = rows.map { shortResolver(it.optString("resolver")) }
            val w = (names.maxOfOrNull { it.length } ?: 0).coerceAtLeast(8)
            val fmt = "%-3s %-4s %-${w}s %4s %4s %5s %3s\n"
            sb.append(String.format(Locale.ROOT, fmt, "via", "st", "resolver", "rtt", "loss", "ok", "len"))
            rows.forEachIndexed { i, p ->
                val mark = when {
                    p.optBoolean("suspended") -> "susp"
                    p.optBoolean("verified") -> "ok"
                    else -> "?"
                }
                val rtt = p.optLong("rtt") / 1_000_000
                sb.append(String.format(Locale.ROOT, fmt,
                    p.optString("transport"), mark, names[i],
                    if (rtt > 0) rtt.toString() else "-",
                    "${(p.optDouble("loss", 0.0) * 100).toInt()}%",
                    p.optInt("successes").toString(),
                    p.optInt("name_len").takeIf { it > 0 }?.toString() ?: "-"))
            }
        }

        val events = s.optJSONArray("events") ?: JSONArray()
        if (events.length() > 0) {
            sb.append("\nEvents (newest last):\n")
            for (i in 0 until events.length()) {
                val e = events.getJSONObject(i)
                sb.append("  ${clock(e.optString("t"))} ${e.optString("msg")}\n")
            }
        }
        return sb.toString()
    }

    /**
     * The status for a bug report, without the tunnel zone (private, like
     * everything the link carries).
     */
    fun report(s: JSONObject, net: NetInfo.Snapshot, settings: Settings): String {
        val r = JSONObject(s.toString())
        r.remove("zone")
        r.put("helper", JSONObject()
            .put("listen", TunnelService.LISTEN)
            .put("mode_setting", settings.mode)
            .put("probe_hosts", JSONArray(settings.probeTargets()))
            .put("last_error", TunnelService.lastError ?: JSONObject.NULL))
        r.put("device_network", JSONObject()
            .put("transport", net.transport)
            .put("dns", JSONArray(net.dns))
            .put("operator", net.operator)
            .put("private_dns", net.privateDns))
        return r.toString(2)
    }

    private fun stateName(state: String): String = when (state) {
        "direct" -> "open (probe hosts answer directly)"
        "blocked" -> "allowlist on (probe hosts fail, allowlisted sites answer)"
        "offline" -> "offline (nothing answers)"
        "unknown" -> "not checked yet"
        else -> state
    }

    private fun working(p: JSONObject) =
        p.optBoolean("verified") && !p.optBoolean("suspended")

    /** "77.88.8.8:853" -> "77.88.8.8", "[2a0c::1]:53" -> "2a0c::1": the port shows in the transport column. */
    private fun shortResolver(r: String): String {
        val m = Regex("^\\[?(.*?)\\]?:(53|853)$").find(r) ?: return r
        return m.groupValues[1]
    }

    private fun list(a: JSONArray?): String =
        if (a == null) "" else (0 until a.length()).joinToString(", ") { a.optString(it) }

    private fun bytes(n: Long): String = when {
        n < 1024 -> "$n B"
        n < 1024 * 1024 -> String.format(Locale.ROOT, "%.1f KB", n / 1024.0)
        else -> String.format(Locale.ROOT, "%.1f MB", n / (1024.0 * 1024.0))
    }

    /** RFC 3339 from Go (fractional seconds, Z or ±hh:mm) as local HH:mm:ss. */
    fun clock(rfc3339: String): String {
        if (rfc3339.isEmpty()) return "?"
        return try {
            val trimmed = rfc3339.replace(Regex("\\.\\d+"), "")
            val parsed: Date = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.ROOT).parse(trimmed) ?: return rfc3339
            SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(parsed)
        } catch (_: Exception) {
            rfc3339
        }
    }
}
