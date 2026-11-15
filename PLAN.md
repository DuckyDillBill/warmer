# Warmer: build plan

**One line:** Point your iPhone at any touchscreen. Warmer reads it, tracks your finger, and guides you to the right button by sound. "Warmer... warmer... tap."

**Demo goal:** a blindfolded judge orders a meal from a kiosk screen in under 60 seconds, and the order lands on the big screen live.

---

## How it works (the pipeline)

```
iPhone camera (30 fps)
  ├─ 1. Find the screen      Vision rectangle detection -> 4 corners -> homography
  ├─ 2. Find the fingertip   Vision hand pose -> index fingertip -> map into screen coords
  ├─ 3. Read the screen      On-device OCR (text + boxes) + vision LLM (what each button means)
  ├─ 4. Pick the target      User says "large fries" -> match to a button
  ├─ 5. Guide the finger     fingertip -> target vector -> tone pitch + voice + haptics, every frame
  └─ 6. Detect the tap       screen changes -> re-read -> next step
```

Key idea: the **LLM reads the screen once per screen state**. All real-time work (finger tracking, guidance) runs **on-device** so it feels instant. That's the part Gemini/ChatGPT can't do, and it's our answer when judges ask.

---

## Where each sponsor tool fits

| Tool | What we use it for |
|---|---|
| **Convex** | Backend. (1) Actions that call the vision LLM, so API keys never ship in the app. (2) "Memory": parsed screen layouts saved by screen fingerprint, so a screen seen once is instant next time. (3) The demo kiosk writes orders to Convex, and a live dashboard shows them on the big screen in real time. |
| **Capy** | How we build. Run parallel coding agents on separate tasks (vision core, Convex functions, kiosk web app, iOS UI) so three people ship like six. |
| **Revyl** | Testing. Run the iOS app on Revyl's cloud iOS devices to verify core flows (launch, permissions, voice target entry, screen-memory lookup) on every push, and use its run traces to debug fast. Pitch angle: Revyl is "agents that navigate app screens"; we built the same thing for blind humans on physical screens. |

---

## Components

### A. iOS app (SwiftUI)
- `CameraService`: AVFoundation capture, frames to a processing queue.
- `ScreenDetector`: `VNDetectRectanglesRequest`, smooth corners across frames, **lock the quad** once stable so the hand covering the screen doesn't break it.
- `FingerTracker`: `VNDetectHumanHandPoseRequest`, take index tip (`.indexTip`), project through the homography into normalized screen coords (0 to 1).
- `ScreenReader`: `VNRecognizeTextRequest` on the rectified screen image for exact text boxes; send rectified image + OCR to Convex for the LLM to label buttons.
- `Guide`: the core loop.
  - Distance to target -> **continuous tone pitch** (higher = warmer). This is the main channel; it's fast and not annoying.
  - Direction -> short spoken cues only when direction changes ("left", "up"), throttled to ~1 per second.
  - Haptics pulse faster as you get close; strong buzz + "tap" when inside the target box.
- `VoiceInput`: `SFSpeechRecognizer` for "what do you want?", plus reading options aloud with `AVSpeechSynthesizer`.
- Fully usable with VoiceOver; big single button UI.

### B. Convex backend
- `screens` table: `{ fingerprint, elements: [{label, role, box}], updatedAt }`
- `orders` table (demo kiosk): `{ items, total, createdAt, source }`
- `parseScreen` action: image + OCR -> vision LLM -> structured buttons (label, box, what it does). Cache by fingerprint (hash of sorted OCR text).
- `matchTarget` action: user's spoken request -> best element (LLM, falls back to fuzzy string match).
- LLM key stored as a Convex environment variable.

### C. Demo kiosk (React web app, runs on an iPad or laptop)
- Generic burger-joint ordering flow: menu -> item -> size -> add to order -> checkout. Big touch targets like a real kiosk. **Original branding** (no real restaurant logos).
- Writes the order to Convex on checkout.
- `/live` page on the projector: orders appear the instant they're placed. That's the payoff moment.

---

## Team split (2 people)

| Person | Owns | Done when |
|---|---|---|
| **Ash: iOS app** (has the Apple Developer account, so all device builds run through him) | Camera, ScreenDetector, FingerTracker, homography, Guide loop (tone/voice/haptics), voice input, VoiceOver, TestFlight/device installs, Revyl test runs | Blindfolded flow works on a real iPhone against the kiosk |
| **Partner: Brain + backend + demo** | Convex schema + actions, LLM prompt, screen memory, demo kiosk web app, `/live` dashboard, demo script + backup video | Photo of kiosk in -> correct button list out in <3 s; orders show on `/live` instantly |

Ash runs 2 to 3 Capy agents in parallel on separate iOS pieces (camera + screen detection, finger tracking, guide audio/haptics) so the heavy side doesn't bottleneck. Partner uses Capy for the Convex functions and kiosk app.

**First 10 minutes:** Ash adds the partner to the Apple Developer team in App Store Connect (Users and Access) so both can install builds on their own phones. Agree on the shared contract: screen coordinates normalized 0 to 1, origin at the screen's top-left, and the `parseScreen` response shape.

---

## Timeline (adjust to demo time)

| Block | Goal |
|---|---|
| Hour 0 to 1 | **Ash:** Xcode project, camera feed on device. **Partner:** Convex project, kiosk web app scaffolded. Both: agree on the coordinate format and `parseScreen` shape. |
| Hours 1 to 3 | **Ash:** screen detected + fingertip dot on rectified view. **Partner:** `parseScreen` returns correct buttons for the kiosk; kiosk ordering flow done. |
| Hours 3 to 5 | Hook it together: speak target -> guide finger -> tap -> re-read next screen. Tone + haptics tuned. |
| Hours 5 to 6 | Screen memory (instant second visit). `/live` order dashboard. Revyl test run. |
| Last 1 to 2 hours | **Feature freeze.** Polish, record backup demo video, rehearse blindfold demo 3+ times. |

---

## Risks and fixes
- **Glare / screen not detected:** dim kiosk background, angle the phone, let user tap "lock screen" once corners look right. Fallback: hardcode corners for the demo device.
- **Hand blocks the screen:** lock the quad before guidance starts; only re-detect when hand is out of frame.
- **LLM latency:** parse once per screen, cache in Convex, pre-warm the demo kiosk's screens.
- **Too much talking:** tone does the work; voice only for direction changes and "tap".
- **Live demo fails:** backup screen recording ready; pre-cached screens.

## Cut list (if behind, cut in this order)
1. Revyl beyond one smoke test
2. Screen memory
3. Spoken target (use on-screen list + VoiceOver instead)
4. Multi-screen flows (demo one screen: "tap Large Fries")

## Pitch skeleton (60 s)
1. "Who here has been defeated by a microwave? Now close your eyes."
2. Buttons are disappearing. Kiosks, appliances, self-checkout: flat and silent. Blind people get locked out.
3. Warmer: point your phone, it reads the screen, tracks your finger, and guides you there by sound.
4. Live: blindfold a judge, order a meal, order pops up on `/live`.
5. "Screens aren't going away. Nobody should need someone else's eyes to order lunch."
