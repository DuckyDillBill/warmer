# Revyl tests (iOS simulator)

Warmer's iOS app is tested with [Revyl](https://revyl.com) natural-language tests on the
`simulator` EAS build (`eas build -p ios --profile simulator`, which sets `EXPO_PUBLIC_MOCK_CAMERA=1`
because the simulator has no camera).

## Test: "Warmer" (iPhone 17 Pro Max, iOS 27.0) — passing

1. **Validation:** The text "Hold to talk" is visible
2. **Instruction:** Tap the "Debug" button
3. **Validation:** A button says "Debug on"
4. **Instruction:** Tap the "Type" button, type "cheeseburger", then tap "Start"

Note: the latest app build always shows the tracking overlay and has no Debug button. For a new
simulator build, replace steps 2–3 with `Tap the "Repeat" button` / `The text "Hold to talk" is visible`.
