package org.velta.tunnelhelper

import android.content.Context

/** What the user entered. The tunnel link stays in app-private storage only. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("helper", Context.MODE_PRIVATE)

    var link: String
        get() = prefs.getString("link", "") ?: ""
        set(v) = prefs.edit().putString("link", v.trim()).apply()

    /** auto, always or off (see docs/agents/dns-tunnel.md "Routing"). */
    var mode: String
        get() = prefs.getString("mode", "auto") ?: "auto"
        set(v) = prefs.edit().putString("mode", v).apply()

    /** Hosts known NOT to be allowlisted, probed to detect the allowlist. */
    var probeHosts: String
        get() = prefs.getString("probe", "") ?: ""
        set(v) = prefs.edit().putString("probe", v.trim()).apply()

    /** The user wants the proxy on: a system restart of the service resumes it. */
    var running: Boolean
        get() = prefs.getBoolean("running", false)
        set(v) = prefs.edit().putBoolean("running", v).apply()

    fun probeTargets(): List<String> = splitHosts(probeHosts)

    companion object {
        fun splitHosts(s: String): List<String> =
            s.split(',', ' ', '\n', ';').map { it.trim() }.filter { it.isNotEmpty() }
    }
}
