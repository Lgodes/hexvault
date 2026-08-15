package com.hexvault.app

import android.graphics.BitmapFactory
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions
import com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.json.JSONArray
import org.json.JSONObject
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger

/** Trusted bridge exposed only to HexVault's own WebView. */
class NativeScannerBridge(private val webView: WebView) {
    private data class OcrCandidate(val script: String, val text: String)

    private val recognizers: List<Pair<String, TextRecognizer>> by lazy {
        listOf(
            "latin" to TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS),
            "japanese" to TextRecognition.getClient(JapaneseTextRecognizerOptions.Builder().build()),
            "chinese" to TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build()),
            "korean" to TextRecognition.getClient(KoreanTextRecognizerOptions.Builder().build())
        )
    }

    @JavascriptInterface
    fun recognizeText(dataUrl: String, requestId: String) {
        val encoded = dataUrl.substringAfter(',', "")
        val bytes = runCatching { Base64.decode(encoded, Base64.DEFAULT) }.getOrNull()
        val bitmap = bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
        if (bitmap == null) {
            deliver(requestId, emptyList())
            return
        }

        val image = InputImage.fromBitmap(bitmap, 0)
        val candidates = Collections.synchronizedList(mutableListOf<OcrCandidate>())
        val remaining = AtomicInteger(recognizers.size)
        recognizers.forEach { (script, recognizer) ->
            recognizer.process(image)
                .addOnSuccessListener { result ->
                    val text = result.text.trim()
                    if (text.isNotEmpty()) candidates.add(OcrCandidate(script, text))
                }
                .addOnCompleteListener {
                    if (remaining.decrementAndGet() == 0) {
                        deliver(requestId, candidates.distinctBy { it.text })
                        bitmap.recycle()
                    }
                }
        }
    }

    private fun score(candidate: OcrCandidate): Int {
        val text = candidate.text
        val scriptBonus = when (candidate.script) {
            "japanese" -> text.count { it.code in 0x3040..0x30ff } * 8
            "chinese" -> text.count { it.code in 0x4e00..0x9fff } * 5
            "korean" -> text.count { it.code in 0xac00..0xd7af } * 8
            else -> text.count { it.isLetterOrDigit() && it.code < 0x0250 } * 3
        }
        return text.length.coerceAtMost(500) + scriptBonus
    }

    private fun deliver(requestId: String, candidates: List<OcrCandidate>) {
        val ordered = candidates.sortedByDescending(::score).take(4)
        val payload = JSONObject().apply {
            put("id", requestId)
            put("text", ordered.firstOrNull()?.text.orEmpty())
            put("candidates", JSONArray().apply {
                ordered.forEach { candidate ->
                    put(JSONObject().put("script", candidate.script).put("text", candidate.text))
                }
            })
        }
        webView.post {
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('hexvault-native-ocr',{detail:$payload}));",
                null
            )
        }
    }

    fun close() = recognizers.forEach { (_, recognizer) -> recognizer.close() }
}
