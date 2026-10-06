# Test the Android tablet primarily by voice

Use the installed standalone preview. It contains its app bundle, so it does not need Metro. Android Studio's Run button installs a development build instead; that build requires Metro.

## Microphone setup

On the emulator, open Extended Controls → Microphone and enable **Virtual microphone uses host audio input**. Allow microphone access if macOS asks. See [Android's emulator controls](https://developer.android.com/studio/run/emulator-extended-controls?hl=en). Some controls require the emulator's separate window rather than the embedded panel.

On a physical ARM64 Android tablet, install the voice-preview APK and allow the app's microphone permission. An enabled Android speech recognition service is required. Recognition may use the service's network connection; MACROS does not save microphone recordings or transcripts in its food log.

## First food log

This is push-to-talk: tap the microphone before each command. “Hey Macros” is optional and only understood while listening. It is not an always-listening wake word.

1. Say **“Search for tofu.”** Expect three synthetic tofu options.
2. Say **“Option two.”** Expect the selected food on the weighing screen. “Option B” also works.
3. Say **“94.5 grams.”** Expect the review screen showing this portion. A unit is required. This is recorded as manual weight, not a scale reading.
4. Check the food and portion. Say **“Confirm.”** Expect Logged and a return to Home.
5. Tap Dashboard. Expect a new food row and updated calories/macros.
6. Close and reopen the app. Expect the food row to remain in today's dashboard.

If there are earlier demo logs, totals accumulate. The new row must be added only once. The synthetic tofu fixture contains 144 kcal per 100 g; 94.5 g projects to approximately 136 kcal. These values are synthetic test data.

## Other commands

- **“What should I eat?”** requests a suggestion from Home. Choose an offered option by number.
- **“Change weight”** returns from review to weighing.
- **“Use scale weight”** captures a stable reading when the configured scale adapter has one.
- **“Cancel”** leaves the current food flow.

Commands are limited by the visible screen: a weight is accepted only when weighing; confirmation is accepted only during review. Saying a number alone does not supply a weight. Food selection and weight entry do not automatically log a portion.

## Troubleshooting

- **No speech heard:** enable host microphone input, check macOS permission, then tap the microphone and speak again.
- **Network error:** check the emulator/tablet connection and its speech service.
- **Voice unavailable:** enable an Android speech service and microphone permission; touch input remains usable.
- **Unable to load script:** reinstall the standalone voice-preview APK. That screen indicates a development build was launched.

Automated tests cover input parsing, decimal weight preservation, selection of visible catalog options, screen-specific routing, stable-scale guards, and separate confirmation. Live microphone recognition must be verified with the person speaking to the emulator or physical tablet.
