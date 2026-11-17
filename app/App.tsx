import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { WebView as RNWebView } from 'react-native-webview';

// react-native-webview's class typings don't line up with React 19 types yet; behavior is fine.
const WebView = RNWebView as any;
import { useKeepAwake } from 'expo-keep-awake';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import { File } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { Eyes } from './src/bridge';
import { CONVEX_URL, EYES_URL } from './src/config';
import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';
import { initAudio, say } from './src/feedback';
import { Flow, type FlowState } from './src/flow';
import { dimScreen, restoreScreen } from './src/screen';
import { MOCK_CAMERA, MockBackend, MockEyes } from './src/mock';

const C = { bg: '#14110f', card: '#221c18', text: '#f6efe7', muted: '#b5a596', warm: '#ff9a3c', red: '#e5533d' };

export default function App() {
  useKeepAwake();
  const web = useRef<RNWebView>(null);
  // MOCK_CAMERA (simulator / Revyl): fake camera + scripted backend. Otherwise the real camera WebView + Convex.
  const mockBackend = useMemo(() => (MOCK_CAMERA ? new MockBackend() : null), []);
  const eyes = useMemo(() => (mockBackend ? (new MockEyes(mockBackend) as unknown as Eyes) : new Eyes(web)), [mockBackend]);
  const flow = useMemo(() => new Flow(eyes, mockBackend ?? undefined), [eyes, mockBackend]);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  const [state, setState] = useState<FlowState>('idle');
  const [status, setStatus] = useState('Starting camera…');
  const [needPin, setNeedPin] = useState(false);
  const [recording, setRecording] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const [pin, setPin] = useState('');
  const debug = true; // always show the target box and fingertip dot on the camera view
  const [camReady, setCamReady] = useState(false);

  // Battery: dark screen while an order is in progress, normal brightness otherwise (and whenever the app leaves).
  const active = state === 'planning' || state === 'guiding' || state === 'asking' || state === 'pin';
  useEffect(() => {
    if (active && AppState.currentState === 'active') dimScreen();
    else restoreScreen();
  }, [active]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') restoreScreen();
    });
    return () => {
      sub.remove();
      restoreScreen();
    };
  }, []);

  useEffect(() => {
    initAudio();
    eyes.events = {
      onReady: () => {
        setCamReady(true);
        eyes.setDebug(debug);
      },
      onFingertip: (p) => flow.onFingertip(p),
      onScreenChanged: () => flow.onScreenChanged(),
      onTargetMoved: (box) => flow.onTargetMoved(box),
      onError: (m) => setStatus(`Camera problem: ${m}`),
    };
    flow.subscribe((s) => {
      setState(s.state);
      setStatus(s.status);
      setNeedPin(s.needPin);
    });
    say('Warmer is ready. Hold the big button and say what you want.');
  }, []);

  async function startRecording() {
    if (recording) return;
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      say('Warmer needs microphone access. You can also type instead.');
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    setRecording(true);
  }

  async function stopRecording() {
    if (!recording) return;
    setRecording(false);
    await recorder.stop();
    // Switch back to playback mode so speech comes out of the loud speaker.
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const uri = recorder.uri;
    if (!uri) return;
    const b64 = await new File(uri).base64();
    flow.startFromAudio(b64, 'audio/mp4');
  }

  // Demo helper: stop guiding and send the kiosk on the iPad back to its start screen.
  function resetDemo() {
    flow.stop();
    if (CONVEX_URL) new ConvexHttpClient(CONVEX_URL).mutation(anyApi.demo.resetKiosk as any, {}).catch(() => {});
    say('Reset. Hold the big button and say what you want.');
  }

  const busy = state === 'planning';
  const big = recording ? 'Listening… let go when done' : state === 'idle' || state === 'done' || state === 'error' ? 'Hold to talk' : state === 'asking' ? 'Hold to answer' : 'Hold to change order';

  return (
    <View style={s.root}>
      <StatusBar style="light" />
      <View style={s.cam} accessible={false} importantForAccessibility="no-hide-descendants">
        {MOCK_CAMERA ? (
          <MockCamera eyes={eyes as unknown as MockEyes} debug={debug} />
        ) : (
        <WebView
          ref={web}
          source={{ uri: EYES_URL }}
          onMessage={eyes.handle}
          javaScriptEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          mediaCapturePermissionGrantType="grant"
          originWhitelist={['*']}
          style={{ flex: 1, backgroundColor: '#000' }}
        />
        )}
        {!camReady && <Text style={s.camHint}>Starting camera…</Text>}
      </View>

      <View style={s.card} accessible accessibilityRole="text" accessibilityLiveRegion="polite">
        <Text style={s.title}>Warmer</Text>
        <Text style={s.status} numberOfLines={3}>{status}</Text>
      </View>

      <Pressable
        onPressIn={startRecording}
        onPressOut={stopRecording}
        accessibilityRole="button"
        accessibilityLabel={recording ? 'Listening. Let go when you are done.' : 'Hold to talk. Say what you want.'}
        style={({ pressed }) => [s.big, (pressed || recording) && { backgroundColor: C.red }]}
      >
        <Text style={s.bigText}>{busy ? 'Reading the screen…' : big}</Text>
      </Pressable>

      <View style={s.row}>
        <Btn label="Type" onPress={() => setTyping(true)} hint="Type what you want instead of speaking" />
        <Btn label="Repeat" onPress={() => flow.repeat()} hint="Repeat the last instruction" />
        <Btn label="Retry" onPress={() => flow.retry()} hint="Read the screen again" />
        <Btn label="Reset" onPress={resetDemo} hint="Restart the demo: clears the goal and sends the kiosk back to its start screen" />
      </View>

      <Modal visible={typing} transparent animationType="fade" onRequestClose={() => setTyping(false)}>
        <View style={s.modalWrap}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>What do you want?</Text>
            <TextInput
              autoFocus
              value={typed}
              onChangeText={setTyped}
              placeholder="A cheeseburger and fries"
              placeholderTextColor={C.muted}
              style={s.input}
              returnKeyType="go"
              accessibilityLabel="What do you want?"
              onSubmitEditing={() => {
                setTyping(false);
                flow.start(typed);
              }}
            />
            <Btn label="Start" onPress={() => { setTyping(false); flow.start(typed); }} hint="Start guiding" />
          </View>
        </View>
      </Modal>

      <Modal visible={needPin} transparent animationType="fade">
        <View style={s.modalWrap}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>Type your PIN</Text>
            <Text style={s.modalSub}>It stays on this phone. Warmer never says it out loud or sends it anywhere.</Text>
            <TextInput
              autoFocus
              value={pin}
              onChangeText={setPin}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={8}
              style={s.input}
              accessibilityLabel="PIN"
              onSubmitEditing={() => { flow.providePin(pin); setPin(''); }}
            />
            <Btn label="Guide me" onPress={() => { flow.providePin(pin); setPin(''); }} hint="Start guiding to each digit" />
          </View>
        </View>
      </Modal>
    </View>
  );
}

// Stand-in camera view for MOCK_CAMERA mode: shows the fake fingertip and the target box.
function MockCamera({ eyes, debug }: { eyes: MockEyes; debug: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 50);
    return () => clearInterval(t);
  }, []);
  const b = eyes.target;
  const f = eyes.finger;
  return (
    <View style={{ flex: 1, backgroundColor: '#2a2420' }} accessible accessibilityLabel="Mock camera">
      <Text style={s.camHint}>Mock camera (Bun & Done kiosk)</Text>
      {debug && b && (
        <View
          accessible
          accessibilityLabel="Target box"
          style={{
            position: 'absolute',
            left: `${b[0] * 100}%`,
            top: `${b[1] * 100}%`,
            width: `${(b[2] - b[0]) * 100}%`,
            height: `${(b[3] - b[1]) * 100}%`,
            borderWidth: 3,
            borderColor: C.warm,
            borderRadius: 8,
          }}
        />
      )}
      {debug && f && (
        <View
          accessible
          accessibilityLabel="Fingertip"
          style={{
            position: 'absolute',
            left: `${f.x * 100}%`,
            top: `${f.y * 100}%`,
            width: 18,
            height: 18,
            marginLeft: -9,
            marginTop: -9,
            borderRadius: 9,
            backgroundColor: C.red,
          }}
        />
      )}
    </View>
  );
}

function Btn({ label, onPress, hint }: { label: string; onPress: () => void; hint: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint}
      style={({ pressed }) => [s.btn, pressed && { opacity: 0.7 }]}>
      <Text style={s.btnText}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingTop: 54, paddingBottom: 30, paddingHorizontal: 14, gap: 12 },
  cam: { flex: 1.1, borderRadius: 20, overflow: 'hidden', backgroundColor: '#000' },
  camHint: { position: 'absolute', alignSelf: 'center', top: '45%', color: C.muted, fontSize: 16 },
  card: { backgroundColor: C.card, borderRadius: 18, padding: 16 },
  title: { color: C.warm, fontSize: 15, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
  status: { color: C.text, fontSize: 22, fontWeight: '700', marginTop: 4 },
  big: { flex: 0.8, backgroundColor: C.warm, borderRadius: 26, alignItems: 'center', justifyContent: 'center', padding: 20 },
  bigText: { color: C.bg, fontSize: 30, fontWeight: '900', textAlign: 'center' },
  row: { flexDirection: 'row', gap: 8 },
  btn: { flex: 1, backgroundColor: C.card, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  btnText: { color: C.text, fontSize: 16, fontWeight: '700' },
  modalWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,.7)', justifyContent: 'center', padding: 20 },
  modal: { backgroundColor: C.card, borderRadius: 22, padding: 20, gap: 14 },
  modalTitle: { color: C.text, fontSize: 26, fontWeight: '800' },
  modalSub: { color: C.muted, fontSize: 16 },
  input: { backgroundColor: C.bg, color: C.text, fontSize: 24, padding: 16, borderRadius: 14 },
});
