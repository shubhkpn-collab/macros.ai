# MACROS kitchen voice: local Android preview

This preview adds an OpenAI Realtime audio conversation that reads MACROS' current energy, macros, portion review and validated suggestions. It is prompted to stay on kitchen nutrition. Topic prompting is not a guaranteed topic firewall. Its tools search and select catalog foods, review a spoken manual portion, capture a connected stable scale, request validated guidance and confirm a food log through the existing controller. A log requires a fresh independent final audio transcription of “confirm” or “log it” while the same portion review is visible. Cancelled model responses and duplicate tool calls cannot log food. Spoken answers can still be wrong; verify numbers against the screen. Current nutrition and activity are synthetic development data, not your personal measurements.

## Account setup (one time)

1. Open https://platform.openai.com and create/select a project named **MACROS.AI**.
2. In the platform billing settings, configure API billing if your project requires it. API usage is billed separately from your ChatGPT subscription. Set an appropriate project budget/alerts; alerts are not a guaranteed hard spending cap.
3. Create a project API key at https://platform.openai.com/api-keys. Ensure the project/key can create Realtime sessions. Keep the key private.
4. In the repository's **.env.realtime.local**, paste the key after `OPENAI_API_KEY=`. Do not put quotes around it or paste it into chat. This local file is ignored by Git and has owner-only permissions. Never put this key in Android settings, source code, screenshots, or GitHub secrets for APK builds.

If setting up on another Mac, create this file yourself:

```dotenv
OPENAI_API_KEY=
OPENAI_REALTIME_MODEL=gpt-realtime-2.1
```

## Start on this Mac

From the repository root, with Node 22+ and dependencies installed:

```sh
npm run voice:backend
```

Keep that terminal running. It binds to `127.0.0.1:8791`, not your network. Restart it after editing the API key. The server reports whether a key exists without printing it; that does not verify project access or billing.

Install the `kitchenPreview` APK on an authorized USB-connected phone. Set `ANDROID_HOME` to your SDK location, then in another terminal:

```sh
npm run voice:phone
```

This forwards the phone's localhost port over USB and launches the app with a random, temporary MACROS preview token. That token is not your OpenAI key. Restarting the backend rotates the token, so run `voice:phone` again. The phone still needs internet access for WebRTC audio to OpenAI. A normal release ignores this preview token and blocks localhost HTTP.

Tap **Talk to Macros**, the home orb, or the large microphone and allow microphone access. You can interrupt the assistant by speaking. Tap the persistent **End conversation** control to stop audio. Backgrounding the app also stops the microphone. Each preview conversation ends after twenty minutes; reconnect if needed. This duration limit reduces accidental long sessions but is not an account spending limit.

Try:

- “What should I eat next based on my protein today?”
- “Explain my current energy balance and my end-of-day budget.”
- “Assume I burn 2500 calories today and want a 300-calorie deficit. What intake would that imply?” (2200 kcal is a planning assumption, not a measured burn or a configured profile.)
- Say “I am having cooked chicken,” choose an offered option, say “186 grams,” hear the portion review, then say “confirm.” Ask “What changed?” without tapping again.
- Ask something unrelated; check that the assistant redirects to kitchen nutrition.
- End the call and verify that the Android microphone indicator disappears.

A key and a real-device conversation are required to validate audio, interruptions, tool calls and account access. Automated mocks cannot establish these results.

## Build

```sh
npm --prefix apps/tablet ci
node tools/hydrate-android-shell.mjs
apps/tablet/android/gradlew -p apps/tablet/android assembleKitchenPreview -PreactNativeArchitectures=arm64-v8a
```

The generated APK is `apps/tablet/android/app/build/outputs/apk/kitchenPreview/app-kitchenPreview.apk`. Debug signing is for local previews; it is not a production release.

## Production boundary

`kitchenVoiceRoute` is an authenticated runtime-api route seam. A production server must register it with its real authentication, enforce request limits, and inject the server-only provider. The localhost tool is a single-device development server, not production authentication or hosting. The app's current voice client deliberately only connects to this USB preview; a production HTTPS/account adapter remains to be built.

Official protocol: https://developers.openai.com/api/docs/guides/voice-webrtc?voice-api=realtime
