package com.macrostablet

import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.Locale

/**
 * MACROS speech bridge: Android SpeechRecognizer + TextToSpeech.
 *
 * Written in-house rather than taken from a package. The maintained bare-RN
 * option requires Expo as a peer dependency, and this app is deliberately not
 * an Expo app; the widely used alternative is archived. Both APIs wrapped here
 * are small and stable, so owning ~120 lines is cheaper than either compromise
 * and leaves no third party between the microphone and MACROS.
 *
 * This module carries NO nutrition or recommendation logic. It turns speech
 * into a transcript and trusted text into audio; every decision stays in the
 * application layer.
 */
class MacrosSpeechModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  private var recognizer: SpeechRecognizer? = null
  private var tts: TextToSpeech? = null
  private var ttsReady = false

  override fun getName() = "MacrosSpeech"

  private fun emit(event: String, payload: WritableMap) {
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(event, payload)
  }

  private fun emitError(reason: String) {
    // A stable reason code, never an Android error string: the UI must be able
    // to say something human without an investor seeing developer wording.
    emit("MacrosSpeechError", Arguments.createMap().apply { putString("reason", reason) })
  }

  @ReactMethod
  fun isAvailable(promise: Promise) {
    promise.resolve(SpeechRecognizer.isRecognitionAvailable(ctx))
  }

  @ReactMethod
  fun startListening() {
    UiThreadUtil.runOnUiThread {
      try {
        // Speaking must interrupt whatever MACROS is saying, or the microphone
        // hears the appliance and not the person.
        tts?.stop()

        recognizer?.destroy()
        val r = SpeechRecognizer.createSpeechRecognizer(ctx)
        recognizer = r

        r.setRecognitionListener(object : RecognitionListener {
          override fun onReadyForSpeech(params: Bundle?) {
            emit("MacrosSpeechStart", Arguments.createMap())
          }

          override fun onResults(results: Bundle?) {
            val text = results
              ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
              ?.firstOrNull()
              .orEmpty()
            // Only the FINAL transcript crosses the bridge. Partial results
            // would let a half-heard phrase trigger a billable request.
            emit("MacrosSpeechResult", Arguments.createMap().apply {
              putString("transcript", text)
            })
          }

          override fun onError(error: Int) {
            emitError(
              when (error) {
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "permission_denied"
                SpeechRecognizer.ERROR_NO_MATCH,
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no_speech"
                SpeechRecognizer.ERROR_NETWORK,
                SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network"
                else -> "unavailable"
              }
            )
          }

          override fun onEndOfSpeech() {
            emit("MacrosSpeechEnd", Arguments.createMap())
          }

          override fun onBeginningOfSpeech() {}
          override fun onRmsChanged(rmsdB: Float) {}
          override fun onBufferReceived(buffer: ByteArray?) {}
          override fun onPartialResults(partialResults: Bundle?) {}
          override fun onEvent(eventType: Int, params: Bundle?) {}
        })

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
          putExtra(
            RecognizerIntent.EXTRA_LANGUAGE_MODEL,
            RecognizerIntent.LANGUAGE_MODEL_FREE_FORM
          )
          putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
          putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
          putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
        }
        r.startListening(intent)
      } catch (t: Throwable) {
        emitError("unavailable")
      }
    }
  }

  @ReactMethod
  fun stopListening() {
    UiThreadUtil.runOnUiThread {
      try { recognizer?.stopListening() } catch (t: Throwable) { /* already stopped */ }
    }
  }

  @ReactMethod
  fun speak(text: String) {
    UiThreadUtil.runOnUiThread {
      if (tts == null) {
        tts = TextToSpeech(ctx) { status ->
          ttsReady = status == TextToSpeech.SUCCESS
          if (ttsReady) {
            tts?.language = Locale.getDefault()
            // Queued rather than spoken on init: the first utterance would
            // otherwise be lost while the engine warms up.
            tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "macros")
          }
        }
        return@runOnUiThread
      }
      // FLUSH, not ADD: a newer answer replaces an older one rather than
      // queueing behind it.
      tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "macros")
    }
  }

  @ReactMethod
  fun stopSpeaking() {
    UiThreadUtil.runOnUiThread { tts?.stop() }
  }

  @ReactMethod fun addListener(eventName: String) { /* RCTEventEmitter contract */ }
  @ReactMethod fun removeListeners(count: Int) { /* RCTEventEmitter contract */ }

  override fun onCatalystInstanceDestroy() {
    recognizer?.destroy()
    tts?.shutdown()
  }
}
