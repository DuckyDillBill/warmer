# Warmer

Say what you want. Warmer guides your finger to it.

A blind person points their iPhone at any touchscreen (kiosk, card reader, appliance), says
what they want, and Warmer reads the screen and guides their fingertip to each button with
haptics that pulse faster as they get closer, then a ding. Full spec: [CLAUDE.md](CLAUDE.md).

- Kiosk demo (iPad): https://warmer-lake.vercel.app/kiosk
- Camera test page: https://warmer-lake.vercel.app/eyes?debug=1

## Run it on your iPhone (Windows/Linux is fine, no Mac needed)

```bash
git pull
cd app
npm install

# 1. Backend (first time: logs in and creates the Convex project, writes .env.local)
npx convex dev            # leave this running in its own terminal

# 2. Gemini key (once). Get it at aistudio.google.com → API keys
npx convex env set GEMINI_API_KEY <your-key>

# 3. Start the app, then scan the QR code with your iPhone camera (opens in Expo Go)
npx expo start --tunnel
```

## Builds (cloud, needs the Apple developer account login)
```bash
npm install -g eas-cli && eas login
eas device:create                               # register each iPhone (open link on the phone)
eas build -p ios --profile development          # real app with our native modules
eas build -p ios --profile simulator            # for Revyl
eas build -p ios --profile production && eas submit -p ios   # TestFlight
```

## Layout
- `web/` – Vite site on Vercel: `kiosk.html` (fake kiosk), `eyes.html` (camera + MediaPipe hand tracking, runs inside the app's WebView)
- `app/` – Expo app: `App.tsx` UI, `src/flow.ts` key loop, `src/guidance.ts` feel, `src/feedback.ts` haptics/sound/speech, `src/bridge.ts` WebView bridge
- `app/convex/` – backend: `ai.ts` (mapScreen, nextStep, transcribeGoal via Gemini), `screens.ts` (shared screen memory), `orders.ts` (kiosk orders for the live board)
