# Warmer — project spec

> Say what you want. Warmer guides your finger to it.

Hackathon build (YC Consumer Mobile Hackathon, Nov 15 2026). Two people: **Dylan** and **Ash**.
Demo due 6:30 PM. Feature freeze 5:00 PM. Keep everything simple, working and demoable. No auth, no accounts.

## 1. What it is
Warmer lets a blind person use any touchscreen that doesn't talk: restaurant kiosks,
card readers, self-checkout, touch-panel appliances.

**The key loop**
1. User holds the big button and says what they want: "a cheeseburger and fries".
2. Phone is on a stand / chest lanyard, rear camera facing the touchscreen.
3. AI reads the screen and decides which button gets them closer to the goal.
4. User moves a finger over the screen. The phone **vibrates faster the closer the finger gets**
   (warmer… warmer…). When the fingertip is on the button: a **ding** and "Tap".
5. User taps. The screen changes. Warmer instantly says what they tapped ("Cheeseburger"),
   then reads the new screen and guides to the next button.
6. Repeat until done: "Order placed. Order number 42."

**Later (not today):** "Dropped it" mode — find an object on the floor and guide the hand to it.
The architecture below makes this a new *target finder*, nothing else.

## 2. Architecture

```
┌──────────────── iPhone: Expo app (app/) ────────────────┐
│ Hold-to-talk mic · Haptics · Speech out · State machine │
│  ┌──────── WebView: web/eyes.html (Vercel) ─────────┐   │
│  │ rear camera + MediaPipe hand tracking            │   │
│  │ → fingertip (x,y) ~30/s, screenChanged, frames   │   │
│  └──────────────────────────────────────────────────┘   │
└───────────────────────┬─────────────────────────────────┘
                        │ Convex actions (app/convex/)
                        ▼
      Convex: mapScreen · nextStep · transcribeGoal  →  Gemini (key in Convex env)
      tables: screens (cache) · sessions
```

- **Why a WebView for the camera:** hand tracking in JS (MediaPipe) updates live with no
  native rebuilds. Native rebuilds take ~15 min in the cloud (no Mac on the team).
- **Why native app at all:** iPhone websites cannot vibrate. Haptics, mic and speech are native.
- **No Mac:** iOS builds happen in the cloud with EAS Build. We have a paid Apple developer account.

## 3. Repo layout and ownership
```
web/               Vite + TypeScript, deployed on Vercel (Vercel root directory = web)
  eyes.html        camera + MediaPipe page, runs inside the app's WebView      → Dylan
  kiosk.html       fake restaurant kiosk for the iPad                           → Ash
  src/eyes/        hand tracking, screen-change detection, frame capture        → Dylan
  src/kiosk/       kiosk screens                                                → Ash
app/               Expo (React Native, TypeScript)
  src/bridge.ts    WebView <-> app messages                                     → Dylan
  src/guidance.ts  fingertip + target -> feedback level (pure function)         → Dylan
  src/feedback.ts  haptics pulses, ding sound, speech                           → Dylan
  src/flow.ts      state machine for the key loop                               → Ash
  src/screens/     UI (one main screen)                                         → Ash
  convex/          backend: schema, mapScreen, nextStep, transcribeGoal         → Ash
```
Each person (and each Capy/Claude agent) edits only files they own. Shared contracts
below change only if both people agree.

## 4. Coordinates (the #1 source of bugs)
**All coordinates everywhere are normalized 0–1 of the camera frame, top-left origin,
x to the right, y down.** Rear camera, not mirrored.
- MediaPipe already gives top-left normalized landmarks. Index fingertip = landmark 8.
- Gemini returns `box_2d` as `[ymin, xmin, ymax, xmax]` in 0–1000. Convert in Convex to
  `[x0, y0, x1, y1]` in 0–1 before returning. The app never sees Gemini's format.
- Boxes are `[x0, y0, x1, y1]`.
- The phone is on a stand, so camera coordinates stay valid until the screen changes.
- Always keep the debug overlay (fingertip dot + target box drawn on the camera view)
  available behind a toggle.

## 5. Contracts

### WebView bridge (`window.ReactNativeWebView.postMessage` / `injectJavaScript`)
web → app:
```ts
{ type: 'ready' }
{ type: 'fingertip', x: number, y: number, t: number }   // ~30/s while a hand is visible
{ type: 'nohand', t: number }
{ type: 'screenChanged', hash: string }                   // big change that stays stable ~600ms
{ type: 'frame', id: string, jpeg: string, hash: string } // answer to captureFrame
{ type: 'error', message: string }
```
app → web:
```ts
{ type: 'captureFrame', id: string }        // jpeg base64, max 1024px wide, quality ~0.8
{ type: 'setTarget', box: [number,number,number,number] | null }  // for the overlay
{ type: 'debug', on: boolean }
```
- `hash` = a small perceptual hash (dHash) of the frame **excluding the area around the hand**,
  so a moving finger never counts as a screen change and the cache can match screens.

### Convex actions (app/convex/)
```ts
mapScreen({ jpeg, hash }) -> { screenId, summary: string, buttons: Button[] }
// Button = { label: string, box: [x0,y0,x1,y1], kind: 'button'|'digit'|'text' }
// Cache: if a stored screen's hash is within a small Hamming distance, return it
// instantly without calling Gemini.

nextStep({ goal, history: string[], screenId }) -> {
  target: { label: string, box: [x0,y0,x1,y1] } | null,
  say: string,            // spoken before guiding, e.g. "Burgers. Find it."
  warning: string | null, // upsell/donation/dark pattern, e.g. "This asks for a donation. Skip is bottom right."
  pin: boolean,           // true when the screen is a PIN pad
  done: boolean,
  doneSay: string | null  // e.g. "Order placed. Order number 42."
}
// Text-only call over the cached button list: fast. Picks the button that moves toward the goal.

transcribeGoal({ audio /* base64 m4a */ }) -> { goal: string }
// Fallback only if on-device speech recognition is unavailable.
```
- Gemini key lives in Convex environment variables as `GEMINI_API_KEY`. Never in the app or web code.
- Use a fast Gemini Flash-class vision model. Put the model name in one constant.
- Tables: `screens { hash, summary, buttons, createdAt }`, `sessions { goal, history, status, createdAt }`.

## 6. Feel: the guidance (this is the product, tune it carefully)
Designed for blind users. **Quiet by design:** in testing, overlapping sounds made it unusable eyes-closed.
- **Speech never gets cut off.** `say()` is a queue: every sentence finishes, in order. Hints are
  low priority and are skipped if anything else is being said.
- **Searching = haptic rings** (`feedback.ts` RINGS): concentric distance rings around the button.
  Outer ring = light and slow; each smaller ring is stronger and faster, until it's almost violent
  right at the button. No beeps: on iOS a sound effect ending can cut off speech, so haptics only.
- **Words:** every ~2 s (when nothing else is being said) a general direction: "up left", "a little down";
  "almost" when right at the button.
- **On the button** (center 60% for 150 ms): ding + big buzz + **"Press and hold"**, then **silence until the next screen**.
- **Every instruction says where the button is:** "Next: Fries, bottom left." The first direction word follows right after.
- **After a tap:** "Fries. Loading." While reading the screen: a soft pulse every second
  (haptics only); after ~6 s, "Still loading." Then the next instruction starts with "Next: …".
- **No hand in view:** after 1.5 s, "I can't see your hand. Reach toward the screen." every ~4 s (never over other speech).
- **Tap detection:** fingertip held steady (within 3% of the frame) on the button for 1 s, or the screen
  picture clearly changes. Passing over or wiggling away never counts. Reminder after 8 s.
- **Finger:** MediaPipe finds the palm first; when the palm leaves the frame, `eyes/fingertip.ts`
  keeps following the fingertip by its appearance for up to 1.5 s. Ultra-wide camera when available.
- **Box accuracy:** Gemini gives box + exact center point; the camera page snaps the box to the button's
  real edges (`eyes/refine.ts`) and keeps it on the button as the phone moves (`eyes/tracker.ts`).

**PIN pad:** the user types the PIN into a secure field **on the phone**. It stays in memory only,
is never spoken, never logged, never sent to the server, and is cleared when the order ends.
Warmer guides digit by digit with haptics and dings only.

## 7. App (Expo)
- Packages: `expo-dev-client`, `react-native-webview`, `expo-haptics`, `expo-speech`,
  `expo-speech-recognition` (dev build), `expo-audio` (fallback recording), `expo-keep-awake`, `convex`.
- Put every native package in from the start: adding one later means another 15-minute cloud build.
- `app.json` iOS infoPlist: `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`,
  `NSSpeechRecognitionUsageDescription`. App name "Warmer", bundle id `com.ashkon.warmer`.
- WebView props for camera on iOS: `allowsInlineMediaPlayback`,
  `mediaPlaybackRequiresUserAction={false}`, `mediaCapturePermissionGrantType="grant"`.
- UI: one main screen. A giant "Hold to talk" button filling most of the screen, the live
  camera (WebView) behind or above it, a small debug toggle. Everything works with VoiceOver:
  real `accessibilityLabel`s, big targets, no tiny icons. Keep the screen awake while guiding.
- Flow states: `idle → listening → planning → guiding → confirming → … → done`.
  On any failure: say "Sorry, let's try that again" and retry once.

### eas.json profiles
- `development`: developmentClient, distribution internal (our registered iPhones)
- `simulator`: ios.simulator true (for Revyl)
- `production`: for TestFlight after freeze

## 8. Fake kiosk (web/kiosk.html, iPad in portrait)
Invented brand (e.g. "Bun & Done"), realistic fast-food style, big picture buttons, no
real brand names. Screens, every tap visibly changes the screen:
Start → Categories (Burgers, Sides, Drinks) → items → item detail with "Add to order" →
"Make it a meal?" upsell → "Round up for charity?" → Cart with total → PIN pad (4 digits) →
"Order #42 — Thank you!". Add a hidden reset (e.g. long-press logo) to restart the demo.
No speech or screen reader on the kiosk: it must be a screen that doesn't talk.

## 9. Sponsors (all three required to win)
- **Capy:** we run coding agents as Capy threads on this repo in parallel (kiosk, Convex
  backend, EAS/Revyl setup) and review their PRs.
- **Convex:** the whole backend: AI actions, the shared screen cache ("once one person maps a
  kiosk screen, it's instant for everyone"), sessions.
- **Revyl:** natural-language tests on the iOS simulator build. Camera doesn't work in the
  simulator, so test: app opens → hold-to-talk visible → typed/mocked goal starts a session →
  error message path → debug toggle. Add a `MOCK_CAMERA` flag that feeds a recorded kiosk
  image and fake fingertip so Revyl can exercise the guidance loop.

## 10. Milestones
| Time | Done means |
|---|---|
| 11:15 | Expo app runs in Expo Go; WebView shows web/eyes.html from Vercel with live camera; a test button vibrates |
| 11:30 | Fingertip dot tracks smoothly on the iPhone; mapScreen returns correct boxes on a kiosk photo |
| 11:30 | First `eas build -p ios --profile development` started |
| 12:30 | Integration: fingertip + target box + haptics together |
| 1:00  | **Eyes closed, haptics guide you to one button.** Core demo works |
| 1:00  | Simulator build uploaded to Revyl with one passing test |
| 3:00  | Full order: voice goal → steps → upsell warning → PIN → "Order #42" |
| 3:00–5:00 | Tune the feel, Revyl tests passing, extras only if everything works |
| 5:00  | Freeze. 20 eyes-closed runs, 5 different people. Record a backup demo video |
| 5:15  | Production build → TestFlight |
| 5:45–6:30 | Rehearse pitch, set up iPad + phone stand + /live on the projector |

## 11. Rules for agents
- Plan first, then build. Small commits, push often, pull before starting work.
- Only edit files you own (section 3). Don't change contracts (section 5) alone.
- Never commit secrets. `.env*` is gitignored. Keys go in Convex/Vercel env vars.
- Prefer boring, working code over clever code. Hackathon.
- When something can't be tested here (camera, haptics), say exactly how to test it on the phone.
