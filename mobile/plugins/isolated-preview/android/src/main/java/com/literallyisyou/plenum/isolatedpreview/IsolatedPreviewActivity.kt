package com.literallyisyou.plenum.isolatedpreview

import android.app.Activity
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.util.Locale

/**
 * Shows one artifact preview. Declared in the plugin's manifest with android:process=":isolatedpreview", so it runs in
 * its own process: no Capacitor bridge, no JavaScript interface, and no access to the app's memory.
 *
 * Sandbox (SANDBOX_POLICY in mobile/plugins/isolated-preview/src/core.js): JavaScript on; no file, content or
 * geolocation access; no DOM storage or database; every network request answered with 403 by shouldInterceptRequest
 * except data: URLs; every navigation refused; no new windows; FLAG_SECURE so the page cannot be captured.
 */
class IsolatedPreviewActivity : Activity() {

    private var web: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val html = readHtmlAndDelete()
        val title = intent.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() }
            ?: getString(R.string.isolated_preview_default_title)

        // This process has its own WebView data folder, separate from the app's main process.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                WebView.setDataDirectorySuffix(DATA_SUFFIX)
            } catch (e: IllegalStateException) {
                // A WebView already exists in this process; the suffix stays as it was.
            }
        }

        val density = resources.displayMetrics.density
        fun dp(value: Int): Int = (value * density).toInt()

        val label = TextView(this).apply {
            text = title
            textSize = 16f
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        // Close is a 48dp touch target at least, as Android asks for any control.
        val close = Button(this).apply {
            text = getString(R.string.isolated_preview_close)
            minHeight = dp(48)
            minimumHeight = dp(48)
            minWidth = dp(48)
            minimumWidth = dp(48)
            setOnClickListener { finish() }
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(8), dp(8), dp(8))
            addView(label)
            addView(close)
        }

        val view = WebView(this)
        configure(view)
        web = view
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(bar, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            addView(view, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        setContentView(root)
        fitInsideSystemBars(root)
        val page = if (html.isEmpty()) EXPIRED_PAGE else html
        view.loadDataWithBaseURL("about:blank", page, "text/html", "utf-8", null)
    }

    // At targetSdk 35 and later the window runs edge to edge on Android 15+, so the title bar would sit under the status bar
    // and the page under the keyboard. The window is edge to edge on every version here, and the root is padded by the status
    // and navigation bars, the display cutout and the keyboard (wave 4, k1).
    // statusBarColor and navigationBarColor are deprecated at API 35, where the system ignores them; they are set only below it.
    @Suppress("DEPRECATION")
    private fun fitInsideSystemBars(root: View) {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            window.statusBarColor = Color.TRANSPARENT
            window.navigationBarColor = Color.TRANSPARENT
        }
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, root).apply {
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(root)
    }

    override fun onDestroy() {
        web?.let {
            it.stopLoading()
            it.destroy()
        }
        web = null
        super.onDestroy()
    }

    private fun configure(view: WebView) {
        WebView.setWebContentsDebuggingEnabled(false)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            setGeolocationEnabled(false)
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = true

            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                // Inline data: images and fonts are part of the page itself, so they pass. Everything else is refused.
                val scheme = request?.url?.scheme?.lowercase(Locale.ROOT)
                if (scheme == "data") return null
                return blocked()
            }
        }
    }

    private fun blocked(): WebResourceResponse =
        WebResourceResponse("text/plain", "utf-8", 403, "Blocked by the preview", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    // The HTML was written by IsolatedPreviewPlugin into previewDirectory(). Only a file inside that folder is read, and
    // it is deleted after the read, whatever the outcome.
    private fun readHtmlAndDelete(): String {
        val path = intent.getStringExtra(EXTRA_PATH) ?: return ""
        val file = File(path)
        val inside = try {
            file.canonicalFile.parentFile == previewDirectory(this).canonicalFile
        } catch (e: IOException) {
            false
        }
        if (!inside) return ""
        return try {
            file.readText(Charsets.UTF_8)
        } catch (e: IOException) {
            ""
        } finally {
            file.delete()
        }
    }

    companion object {
        const val EXTRA_PATH = "com.literallyisyou.plenum.isolatedpreview.PATH"
        const val EXTRA_TITLE = "com.literallyisyou.plenum.isolatedpreview.TITLE"
        private const val DATA_SUFFIX = "isolated-preview"
        private const val EXPIRED_PAGE =
            "<!doctype html><meta charset=\"utf-8\"><p>This preview is no longer available. Open the artifact again.</p>"
    }
}
