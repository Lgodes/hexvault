package com.hexvault.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat

class MainActivity : ComponentActivity() {
    companion object {
        private const val HEXVAULT_URL = "https://hexvault-t3qg.vercel.app/"
        private const val HEXVAULT_HOST = "hexvault-t3qg.vercel.app"
    }

    private var webView: WebView? = null
    private var scannerBridge: NativeScannerBridge? = null
    private var pendingCameraRequest: PermissionRequest? = null

    private val cameraPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val request = pendingCameraRequest
            pendingCameraRequest = null
            if (granted) request?.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
            else request?.deny()
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(6, 9, 15)
        window.navigationBarColor = Color.rgb(6, 9, 15)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val current = webView
                if (current?.canGoBack() == true) current.goBack() else moveTaskToBack(true)
            }
        })

        setContent {
            val view = remember {
                WebView(this).apply {
                    setBackgroundColor(Color.rgb(6, 9, 15))
                    settings.apply {
                        javaScriptEnabled = true
                        domStorageEnabled = true
                        databaseEnabled = true
                        mediaPlaybackRequiresUserGesture = false
                        mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                        allowFileAccess = false
                        allowContentAccess = true
                        builtInZoomControls = false
                        displayZoomControls = false
                        setSupportZoom(false)
                        userAgentString = "$userAgentString HexVaultAndroid/1.1.0"
                    }
                    val currentWebView = this
                    scannerBridge = NativeScannerBridge(currentWebView).also {
                        addJavascriptInterface(it, "HexVaultNative")
                    }
                    CookieManager.getInstance().apply {
                        setAcceptCookie(true)
                        setAcceptThirdPartyCookies(currentWebView, false)
                    }
                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(
                            view: WebView,
                            request: WebResourceRequest
                        ): Boolean {
                            val uri = request.url
                            return if (uri.scheme == "https" && uri.host == HEXVAULT_HOST) {
                                false
                            } else {
                                runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                                true
                            }
                        }

                        override fun onPageFinished(view: WebView, url: String) {
                            super.onPageFinished(view, url)
                            if (url.startsWith(HEXVAULT_URL)) {
                                view.evaluateJavascript(
                                    """
                                    (() => {
                                      if (window.__hexVaultAndroidKeyboardFix) return;
                                      window.__hexVaultAndroidKeyboardFix = true;
                                      const style = document.createElement('style');
                                      style.textContent = `
                                        .modal.on {
                                          height: var(--hexvault-visible-height, 100dvh) !important;
                                          max-height: var(--hexvault-visible-height, 100dvh) !important;
                                          top: 0 !important;
                                          bottom: auto !important;
                                        }
                                        .modal.on .sheet {
                                          max-height: calc(var(--hexvault-visible-height, 100dvh) - 8px) !important;
                                          overflow-y: auto !important;
                                          overscroll-behavior: contain !important;
                                          -webkit-overflow-scrolling: touch !important;
                                        }
                                      `;
                                      document.head.appendChild(style);
                                      const updateViewport = () => {
                                        const height = window.visualViewport?.height || window.innerHeight;
                                        document.documentElement.style.setProperty('--hexvault-visible-height', `${'$'}{height}px`);
                                        const focused = document.activeElement;
                                        if (focused && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName)) {
                                          setTimeout(() => focused.scrollIntoView({block:'center', behavior:'smooth'}), 100);
                                        }
                                      };
                                      window.visualViewport?.addEventListener('resize', updateViewport);
                                      window.visualViewport?.addEventListener('scroll', updateViewport);
                                      window.addEventListener('resize', updateViewport);
                                      document.addEventListener('focusin', () => setTimeout(updateViewport, 80));
                                      updateViewport();
                                    })();
                                    """.trimIndent(),
                                    null
                                )
                            }
                        }
                    }
                    webChromeClient = object : WebChromeClient() {
                        override fun onPermissionRequest(request: PermissionRequest) {
                            runOnUiThread {
                                val wantsCamera = request.resources.contains(
                                    PermissionRequest.RESOURCE_VIDEO_CAPTURE
                                )
                                if (!wantsCamera || request.origin.host != HEXVAULT_HOST) {
                                    request.deny()
                                    return@runOnUiThread
                                }
                                if (ContextCompat.checkSelfPermission(
                                        this@MainActivity,
                                        Manifest.permission.CAMERA
                                    ) == PackageManager.PERMISSION_GRANTED
                                ) {
                                    request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                                } else {
                                    pendingCameraRequest?.deny()
                                    pendingCameraRequest = request
                                    cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                                }
                            }
                        }
                    }
                    loadUrl(HEXVAULT_URL)
                }
            }
            webView = view
            AndroidView(factory = { view }, modifier = Modifier.fillMaxSize())
            DisposableEffect(Unit) {
                onDispose {
                    webView = null
                    scannerBridge?.close()
                    scannerBridge = null
                    view.stopLoading()
                    view.destroy()
                }
            }
        }
    }

    override fun onPause() {
        webView?.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
    }
}
