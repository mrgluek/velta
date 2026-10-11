package org.velta

import android.app.Activity
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.ComponentActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Real HTML5 fullscreen support (video) for the wry WebView.
 *
 * wry's RustWebChromeClient refuses custom views (`callback.onCustomViewHidden()`
 * in `onShowCustomView`), but the WebView has already hidden the system bars
 * for the fullscreen attempt by then — and its bar-restore path only runs from
 * `onHideCustomView`, so exiting left the app stuck with the status bar gone
 * (#111). This wrapper replaces only the custom-view pair with a real
 * implementation — custom view fullscreen on the decor, system bars hidden
 * while it is up, restored on exit (fullscreen button or BACK) — and forwards
 * every other override to the stock client (file chooser = chat attachments,
 * JS dialogs, camera permissions, geolocation, console, titles).
 *
 * Installed from MainActivity's post-onCreate WebView retry: `getWebChromeClient`
 * needs API 26, so API 24/25 devices keep the stock behavior (refused
 * fullscreen, as before). The generated class is final, hence wrapping instead
 * of subclassing; the forwarded set must track wry's client when it changes.
 */
class VeltaWebChromeClient(
  private val inner: WebChromeClient,
  private val activity: Activity,
) : WebChromeClient() {
  private var customView: View? = null
  private var customViewCallback: CustomViewCallback? = null
  private var insetsController: WindowInsetsControllerCompat? = null
  private var backCallback: OnBackPressedCallback? = null

  override fun onShowCustomView(view: View, callback: CustomViewCallback) {
    if (customView != null) {
      callback.onCustomViewHidden()
      return
    }
    customView = view
    customViewCallback = callback
    (activity.window.decorView as ViewGroup).addView(
      view,
      ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      ),
    )
    val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
    insetsController = controller
    controller.systemBarsBehavior =
      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    controller.hide(WindowInsetsCompat.Type.systemBars())
    // BACK must leave the video, not pop the SPA history underneath the
    // fullscreen surface. Registered last, so it wins over WryActivity's and
    // InAppBrowser's callbacks while the custom view is up.
    val back = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        exitFullscreen(fromWebView = false)
      }
    }
    backCallback = back
    (activity as? ComponentActivity)?.onBackPressedDispatcher?.addCallback(activity, back)
  }

  override fun onHideCustomView() {
    exitFullscreen(fromWebView = true)
  }

  private fun exitFullscreen(fromWebView: Boolean) {
    val view = customView ?: return
    (activity.window.decorView as ViewGroup).removeView(view)
    customView = null
    backCallback?.remove()
    backCallback = null
    insetsController?.show(WindowInsetsCompat.Type.systemBars())
    insetsController = null
    if (!fromWebView) {
      // We initiated the exit (BACK): tell the WebView its fullscreen attempt
      // is over so it restores the video element inline.
      customViewCallback?.onCustomViewHidden()
    }
    customViewCallback = null
  }

  // ---- forwarded to the stock wry client ----

  override fun onPermissionRequest(request: PermissionRequest) {
    inner.onPermissionRequest(request)
  }

  override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean =
    inner.onJsAlert(view, url, message, result)

  override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean =
    inner.onJsConfirm(view, url, message, result)

  override fun onJsPrompt(
    view: WebView,
    url: String,
    message: String,
    defaultValue: String,
    result: JsPromptResult,
  ): Boolean = inner.onJsPrompt(view, url, message, defaultValue, result)

  override fun onGeolocationPermissionsShowPrompt(
    origin: String,
    callback: GeolocationPermissions.Callback,
  ) {
    inner.onGeolocationPermissionsShowPrompt(origin, callback)
  }

  override fun onShowFileChooser(
    webView: WebView,
    filePathCallback: ValueCallback<Array<Uri?>?>,
    fileChooserParams: FileChooserParams,
  ): Boolean = inner.onShowFileChooser(webView, filePathCallback, fileChooserParams)

  override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean =
    inner.onConsoleMessage(consoleMessage)

  override fun onReceivedTitle(view: WebView, title: String) {
    inner.onReceivedTitle(view, title)
  }
}
