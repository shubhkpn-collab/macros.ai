package com.macrostablet

import android.content.Intent
import android.media.AudioManager
import android.content.Context
import android.media.MediaPlayer
import android.util.Base64
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
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
  private var lastLevelAt = 0L
  private var tts: TextToSpeech? = null
  private var ttsReady = false
  private var player: MediaPlayer? = null
  private var tempAudio: File? = null
  /** Guards against emitting two endings for one utterance. */
  private var finishEmitted = true
  private var premiumFailureEmitted = true
  /**
   * Identity of the utterance currently owning the output path.
   *
   * Native events carried no identity, so a delayed completion from utterance A
   * could clear the state of utterance B. Timing cannot distinguish them; an
   * explicit id can.
   */
  private var currentSpeechId: String? = null
  /** Text and id waiting for the TTS engine to finish initializing. */
  private var pendingTtsText: String? = null
  private var pendingTtsId: String? = null

  @ReactMethod
  fun getKitchenToken(promise: Promise) {
    promise.resolve(if (BuildConfig.KITCHEN_PREVIEW) ctx.currentActivity?.intent?.getStringExtra("macrosKitchenToken") else null)
  }

  private var previousAudioMode: Int? = null
  private var previousSpeaker: Boolean? = null

  @ReactMethod
  fun beginKitchenAudio(promise: Promise) {
    ctx.runOnUiQueueThread {
      try {
        val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (previousAudioMode == null) {
          previousAudioMode = audio.mode
          previousSpeaker = audio.isSpeakerphoneOn
        }
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        audio.isSpeakerphoneOn = true
        promise.resolve(null)
      } catch (_: Exception) { promise.reject("audio_unavailable", "Audio output unavailable") }
    }
  }

  @ReactMethod
  fun endKitchenAudio() {
    ctx.runOnUiQueueThread {
      val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      previousAudioMode?.let { audio.mode = it }
      previousSpeaker?.let { audio.isSpeakerphoneOn = it }
      previousAudioMode = null
      previousSpeaker = null
    }
  }

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
        // Listening must interrupt whatever MACROS is saying, or the microphone
        // hears the appliance and not the person.
        tts?.stop()
        releasePlayer()
        // Interruption is terminal too: the user wants to talk, not to hear
        // the sentence again in another voice.
        premiumFailureEmitted = true
        emitFinishOnce(currentSpeechId)

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
          override fun onRmsChanged(rmsdB: Float) {
            // Amplitude ONLY, for the orb waveform. No audio is recorded,
            // stored or sent anywhere; this single number is drawn and dropped.
            // Throttled so the bridge is not flooded by a callback that fires
            // many times a second.
            val now = System.currentTimeMillis()
            if (now - lastLevelAt < 60) return
            lastLevelAt = now
            emit("MacrosSpeechLevel", Arguments.createMap().apply {
              putDouble("rmsDb", rmsdB.toDouble())
            })
          }
          override fun onBufferReceived(buffer: ByteArray?) {}
          override fun onPartialResults(partialResults: Bundle?) {
            // One restrained line beneath the orb, never a transcript log.
            val text = partialResults
              ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
              ?.firstOrNull()
              .orEmpty()
            if (text.isNotEmpty()) {
              emit("MacrosSpeechPartial", Arguments.createMap().apply {
                putString("transcript", text)
              })
            }
          }
          override fun onEvent(eventType: Int, params: Bundle?) {}
        })

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
          putExtra(
            RecognizerIntent.EXTRA_LANGUAGE_MODEL,
            RecognizerIntent.LANGUAGE_MODEL_FREE_FORM
          )
          putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
          putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
          // Partial results drive the live caption and the wake acknowledgement.
          // Only the FINAL transcript is ever acted on.
          putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
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

  /**
   * Speak in the appliance's own voice.
   *
   * The engine initializes asynchronously, and `tts != null` does NOT mean it
   * is ready. Previously a second utterance arriving mid-initialization called
   * speak() before the engine was usable, while the init callback still closed
   * over the FIRST sentence — so the stale one could be spoken instead. The
   * pending text and its id are now stored in fields, so the newest utterance
   * always replaces an older waiting one.
   */
  @ReactMethod
  fun speak(text: String, speechId: String) {
    UiThreadUtil.runOnUiThread {
      currentSpeechId = speechId
      finishEmitted = false

      if (ttsReady && tts != null) {
        // FLUSH: a newer answer replaces an older one rather than queueing.
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, speechId)
        return@runOnUiThread
      }

      // Latest wins while the engine warms up.
      pendingTtsText = text
      pendingTtsId = speechId

      if (tts != null) return@runOnUiThread

      tts = TextToSpeech(ctx) { status ->
        ttsReady = status == TextToSpeech.SUCCESS
        val queuedText = pendingTtsText
        val queuedId = pendingTtsId
        pendingTtsText = null
        pendingTtsId = null

        if (!ttsReady) {
          // A terminal event for the waiting utterance, or the orb would keep
          // breathing over an engine that never started.
          emitFinishOnce(queuedId)
          return@TextToSpeech
        }
        tts?.language = Locale.getDefault()
        attachProgressListener()
        if (queuedText != null) {
          tts?.speak(queuedText, TextToSpeech.QUEUE_FLUSH, null, queuedId)
        }
      }
    }
  }

  @ReactMethod
  fun stopSpeaking() {
    UiThreadUtil.runOnUiThread {
      val ending = currentSpeechId
      tts?.stop()
      releasePlayer()
      pendingTtsText = null
      pendingTtsId = null
      // A user-initiated stop is TERMINAL. Suppressing any pending premium
      // failure keeps an interruption from triggering fallback speech.
      premiumFailureEmitted = true
      // Stopping is an ending too: without this the orb would keep breathing
      // after the user interrupted it.
      emitFinishOnce(ending)
    }
  }

  /**
   * Report when an utterance ends so the UI can return to rest.
   *
   * Failure emits the same event: a silent speaker must not leave the orb
   * pulsing forever, which reads as a hung device.
   */
  private fun attachProgressListener() {
    tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String?) {}
      override fun onDone(utteranceId: String?) {
        // The Android utterance id IS the speech id.
        emitFinishOnce(utteranceId)
      }
      @Deprecated("Required by the base class")
      override fun onError(utteranceId: String?) {
        emitFinishOnce(utteranceId)
      }
    })
  }

  /**
   * Play premium audio returned by MACROS.
   *
   * Base64 in, sound out. Written to the app cache because MediaPlayer wants a
   * file, and deleted the moment playback ends — a kitchen appliance running
   * for weeks must not accumulate audio on disk.
   */
  @ReactMethod
  fun playBase64Audio(audioBase64: String, mimeType: String, speechId: String) {
    UiThreadUtil.runOnUiThread {
      /**
       * ARM THE LIFECYCLE FIRST.
       *
       * The guards previously reset only after MIME validation, Base64 decode
       * and file creation — so a corrupted payload threw, called the failure
       * emitter while the guard was still set from the previous utterance, and
       * the event was silently swallowed. JS then never fell back and the
       * utterance hung. Everything that can fail must be inside the armed
       * window.
       */
      currentSpeechId = speechId
      finishEmitted = false
      premiumFailureEmitted = false

      if (mimeType != "audio/mpeg") {
        emitPremiumFailureOnce(speechId)
        return@runOnUiThread
      }
      try {
        // Whatever was playing is stale the moment new audio arrives.
        releasePlayer()
        tts?.stop()

        val bytes = Base64.decode(audioBase64, Base64.DEFAULT)
        if (bytes.isEmpty()) {
          emitPremiumFailureOnce(speechId)
          return@runOnUiThread
        }

        val file = File.createTempFile("macros-speech", ".mp3", ctx.cacheDir)
        file.writeBytes(bytes)
        tempAudio = file

        val mp = MediaPlayer()
        player = mp
        mp.setDataSource(file.absolutePath)
        mp.setOnPreparedListener {
          /**
           * START FIRST, THEN ANNOUNCE.
           *
           * The event must mean "playback was instructed to start", not merely
           * "preparation finished" — the orb lights on it, and preparing is not
           * hearing. If start() throws, the premium failure path runs and no
           * playback-start is emitted, so the fallback is free to speak.
           */
          try {
            it.start()
            emit("MacrosSpeechPlaybackStart", Arguments.createMap().apply {
              putString("speechId", speechId)
            })
          } catch (t: Throwable) {
            releasePlayer()
            emitPremiumFailureOnce(speechId)
          }
        }
        mp.setOnCompletionListener {
          releasePlayer()
          // The id captured when THIS player was created, not whatever is
          // current by the time the callback fires.
          emitFinishOnce(speechId)
        }
        mp.setOnErrorListener { _, _, _ ->
          releasePlayer()
          /**
           * A premium failure is NOT the end of the utterance — JS is about to
           * speak the same sentence natively. Emitting the terminal done event
           * here would race that fallback, clearing `speaking` and the pending
           * text while the native tier was still starting up.
           *
           * Native TTS emits the real ending when it finishes.
           */
          emitPremiumFailureOnce(speechId)
          true
        }
        mp.prepareAsync()
      } catch (t: Throwable) {
        // Base64 corruption, file IO or MediaPlayer construction. The guard was
        // armed before any of it, so this event genuinely reaches JS.
        releasePlayer()
        emitPremiumFailureOnce(speechId)
      }
    }
  }

  /** Release the player and delete its temporary file. Safe to call twice. */
  private fun releasePlayer() {
    try { player?.stop() } catch (t: Throwable) { /* not started */ }
    player?.release()
    player = null
    tempAudio?.delete()
    tempAudio = null
  }

  /**
   * Premium failed, at most once per utterance.
   *
   * Deliberately distinct from the terminal ending: this invites a fallback,
   * whereas MacrosSpeechDone declares the utterance over.
   */
  private fun emitPremiumFailureOnce(speechId: String?) {
    if (premiumFailureEmitted) return
    premiumFailureEmitted = true
    emit("MacrosPremiumSpeechError", Arguments.createMap().apply {
      putString("speechId", speechId)
    })
  }

  /** Exactly one ending per utterance, however it ended. */
  private fun emitFinishOnce(speechId: String?) {
    if (finishEmitted) return
    finishEmitted = true
    emit("MacrosSpeechDone", Arguments.createMap().apply {
      putString("speechId", speechId)
    })
  }

  @ReactMethod fun addListener(eventName: String) { /* RCTEventEmitter contract */ }
  @ReactMethod fun removeListeners(count: Int) { /* RCTEventEmitter contract */ }

  override fun onCatalystInstanceDestroy() {
    recognizer?.destroy()
    tts?.shutdown()
    releasePlayer()
    pendingTtsText = null
    pendingTtsId = null
  }
}
