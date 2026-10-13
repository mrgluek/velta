package org.velta.tunnelhelper

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.util.concurrent.Executors

/**
 * One screen: the tunnel link (pasted once, kept in app-private storage),
 * the probe hosts, the routing mode, start/stop and the live status. Once the
 * link checks out, link and probe hosts fold under a one-line summary.
 */
class MainActivity : Activity() {
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var settings: Settings

    private lateinit var linkEdit: EditText
    private lateinit var linkInfo: TextView
    private lateinit var probeEdit: EditText
    private lateinit var setupHeader: TextView
    private lateinit var setupBox: LinearLayout
    private var setupOpen = true
    private var linkSummary = ""
    private lateinit var modeGroup: RadioGroup
    private lateinit var startButton: Button
    private lateinit var stopButton: Button
    private lateinit var batteryButton: Button
    private lateinit var statusView: TextView

    private val poll = object : Runnable {
        override fun run() {
            refresh()
            main.postDelayed(this, 2_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = Settings(this)
        setContentView(buildUi())
        linkEdit.setText(settings.link)
        probeEdit.setText(settings.probeHosts)
        // Fold at once when a link is saved, so the key never flashes on screen
        // while describeLink checks it in the background (a bad link unfolds).
        setSetupOpen(settings.link.isEmpty())
        modeGroup.check(MODES.indexOf(settings.mode).coerceAtLeast(0) + 1)
        modeGroup.setOnCheckedChangeListener { _, id -> onMode(MODES[id - 1]) }
        describeLink(collapseIfOk = true)
    }

    override fun onResume() {
        super.onResume()
        main.post(poll)
    }

    override fun onPause() {
        main.removeCallbacks(poll)
        super.onPause()
    }

    override fun onDestroy() {
        worker.shutdown()
        super.onDestroy()
    }

    private fun buildUi(): View {
        val dp = resources.displayMetrics.density
        val pad = (16 * dp).toInt()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        fun label(text: String) = TextView(this).apply {
            this.text = text
            setPadding(0, pad, 0, (4 * dp).toInt())
            setTypeface(typeface, Typeface.BOLD)
        }.also { col.addView(it) }

        col.addView(TextView(this).apply {
            text = "Apps on this phone can use the SOCKS5 proxy ${TunnelService.LISTEN} (no username or password). " +
                "Connections go direct while the probe hosts answer, and through the DNS tunnel when " +
                "only allowlisted sites work. A direct connection that fails also retries through the tunnel."
        })

        // Link and probe hosts are set once: after that they fold away so the
        // status table gets the screen. Tapping the header unfolds them.
        setupHeader = TextView(this).apply {
            setPadding(0, pad, 0, 0)
            setTypeface(typeface, Typeface.BOLD)
            setOnClickListener { setSetupOpen(!setupOpen) }
        }
        col.addView(setupHeader)
        setupBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(setupBox)
        fun boxLabel(text: String) = TextView(this).apply {
            this.text = text
            setPadding(0, (8 * dp).toInt(), 0, (4 * dp).toInt())
            setTypeface(typeface, Typeface.BOLD)
        }.also { setupBox.addView(it) }

        boxLabel("Tunnel link")
        linkEdit = EditText(this).apply {
            hint = "velta://tunnel?v=1&zone=…&key=…"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_URI
            minLines = 2
            maxLines = 4
            textSize = 13f
        }
        setupBox.addView(linkEdit)
        linkInfo = TextView(this).apply { textSize = 13f }
        setupBox.addView(linkInfo)

        boxLabel("Probe hosts")
        setupBox.addView(TextView(this).apply {
            textSize = 13f
            text = "Hosts that are NOT on the allowlist, e.g. your relay (host or host:port, comma-separated). " +
                "Empty = learn them from traffic, which only works if nothing but a mail app uses the proxy."
        })
        probeEdit = EditText(this).apply {
            hint = "relay.example.org"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
                InputType.TYPE_TEXT_VARIATION_URI
            isSingleLine = true
            textSize = 13f
        }
        setupBox.addView(probeEdit)

        setupBox.addView(CheckBox(this).apply {
            text = "Short names first (soar default: start at 101 chars, grow to 253)"
            textSize = 13f
            isChecked = settings.shortNames
            setOnCheckedChangeListener { _, on ->
                settings.shortNames = on
            }
        })
        setupBox.addView(Button(this).apply {
            text = "Save"
            setOnClickListener { onSaveClicked() }
        })

        label("Route")
        modeGroup = RadioGroup(this).apply { orientation = RadioGroup.HORIZONTAL }
        MODE_LABELS.forEachIndexed { i, text ->
            modeGroup.addView(RadioButton(this).apply {
                id = i + 1
                this.text = text
            })
        }
        col.addView(modeGroup)

        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, pad, 0, 0)
        }
        startButton = Button(this).apply {
            text = "Start"
            setOnClickListener { onStartClicked() }
        }
        stopButton = Button(this).apply {
            text = "Stop"
            setOnClickListener { TunnelService.stop(this@MainActivity) }
        }
        val copyButton = Button(this).apply {
            text = "Copy report"
            setOnClickListener { copyReport() }
        }
        buttons.addView(startButton)
        buttons.addView(stopButton)
        buttons.addView(copyButton)
        col.addView(buttons)

        batteryButton = Button(this).apply {
            text = "Allow running in background"
            setOnClickListener { askBatteryExemption() }
        }
        col.addView(batteryButton)

        statusView = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 11f
            setTextIsSelectable(true)
            setPadding(0, pad, 0, 0)
        }
        col.addView(statusView)

        val scroll = ScrollView(this).apply { addView(col) }
        // targetSdk 35+ draws edge to edge: keep the content off the system bars.
        scroll.setOnApplyWindowInsetsListener { v, insets ->
            @Suppress("DEPRECATION")
            v.setPadding(
                insets.systemWindowInsetLeft,
                if (actionBar == null) insets.systemWindowInsetTop else 0,
                insets.systemWindowInsetRight,
                insets.systemWindowInsetBottom,
            )
            insets
        }
        return scroll
    }

    private fun saveFields() {
        settings.link = linkEdit.text.toString()
        settings.probeHosts = probeEdit.text.toString()
    }

    /** Stores link and probe hosts, folds them if the link is valid, and restarts a running proxy. */
    private fun onSaveClicked() {
        saveFields()
        val link = settings.link
        worker.execute {
            val err = try {
                Native.parse(link).optString("error")
            } catch (e: Throwable) {
                "native library: ${e.message ?: e}"
            }
            runOnUiThread {
                describeLink(collapseIfOk = true)
                if (err.isNotEmpty()) {
                    Toast.makeText(this, "Link: $err", Toast.LENGTH_LONG).show()
                } else if (TunnelService.active) {
                    TunnelService.start(this) // start while running = restart with the saved settings
                    main.postDelayed({ refresh() }, 500)
                }
            }
        }
    }

    private fun onStartClicked() {
        saveFields()
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        val link = settings.link
        worker.execute {
            val err = try {
                Native.parse(link).optString("error")
            } catch (e: Throwable) {
                "native library: ${e.message ?: e}"
            }
            runOnUiThread {
                describeLink(collapseIfOk = true)
                if (err.isNotEmpty()) {
                    Toast.makeText(this, "Link: $err", Toast.LENGTH_LONG).show()
                } else {
                    TunnelService.start(this)
                    main.postDelayed({ refresh() }, 500)
                }
            }
        }
    }

    private fun onMode(mode: String) {
        settings.mode = mode
        if (!TunnelService.active) return
        worker.execute {
            try {
                Native.setMode(mode.toByteArray(Charsets.UTF_8))
            } catch (_: Throwable) {
            }
            runOnUiThread { refresh() }
        }
    }

    /**
     * Validates the saved link and says which tunnel zone it names. A valid
     * link folds the setup fields when [collapseIfOk]; a bad one unfolds them.
     */
    private fun describeLink(collapseIfOk: Boolean = false) {
        val link = settings.link
        if (link.isEmpty()) {
            linkInfo.text = "Paste the velta://tunnel link you got for this tunnel."
            linkSummary = ""
            setSetupOpen(true)
            return
        }
        worker.execute {
            var ok = false
            var summary = ""
            val text = try {
                val cfg = Native.parse(link)
                val err = cfg.optString("error")
                if (err.isNotEmpty()) "Invalid link: $err"
                else {
                    ok = true
                    val extra = cfg.optJSONArray("resolvers")?.length() ?: 0
                    summary = "Link OK" + if (extra > 0) ", $extra extra resolvers" else ""
                    "Link OK: zone ${cfg.optString("zone")}" + if (extra > 0) ", $extra extra resolvers" else ""
                }
            } catch (e: Throwable) {
                "Native library missing or broken: ${e.message ?: e}"
            }
            runOnUiThread {
                linkInfo.text = text
                linkSummary = summary
                when {
                    !ok -> setSetupOpen(true)
                    collapseIfOk -> setSetupOpen(false)
                    else -> setSetupOpen(setupOpen)
                }
            }
        }
    }

    /** Shows or folds the link / probe-host fields; the header sums them up. */
    private fun setSetupOpen(open: Boolean) {
        setupOpen = open
        setupBox.visibility = if (open) View.VISIBLE else View.GONE
        setupHeader.text = if (open) {
            "▾ Tunnel link and probe hosts"
        } else {
            val probes = settings.probeTargets()
            val probeText = if (probes.isEmpty()) "learned from traffic" else probes.joinToString(", ")
            "▸ ${linkSummary.ifEmpty { "Tunnel link" }}\n   probe hosts: $probeText"
        }
    }

    private fun refresh() {
        val active = TunnelService.active
        startButton.visibility = if (active) View.GONE else View.VISIBLE
        stopButton.visibility = if (active) View.VISIBLE else View.GONE
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        batteryButton.visibility =
            if (pm.isIgnoringBatteryOptimizations(packageName)) View.GONE else View.VISIBLE
        worker.execute {
            val text = try {
                val err = TunnelService.lastError
                val body = StatusText.full(Native.status())
                if (err != null) "⚠ $err\n\n$body" else body
            } catch (e: Throwable) {
                "Native library missing or broken: ${e.message ?: e}"
            }
            runOnUiThread { statusView.text = text }
        }
    }

    private fun copyReport() {
        worker.execute {
            val report = try {
                StatusText.report(Native.status(), NetInfo.snapshot(this), settings)
            } catch (e: Throwable) {
                "error: ${e.message ?: e}"
            }
            runOnUiThread {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("Velta tunnel helper report", report))
                Toast.makeText(this, "Report copied (without the tunnel zone)", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun askBatteryExemption() {
        try {
            startActivity(
                Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:$packageName")),
            )
        } catch (_: Exception) {
            startActivity(Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    companion object {
        private val MODES = listOf("auto", "always", "off")
        private val MODE_LABELS = listOf("Auto", "Always tunnel", "Never tunnel")
    }
}
