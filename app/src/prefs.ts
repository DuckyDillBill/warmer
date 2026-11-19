// Small settings kept in a file on the phone. For now: whether demo mode is on.
import { File, Paths } from 'expo-file-system';
import { DEMO_DEFAULT } from './config';

const demoFile = () => new File(Paths.document, 'demo-mode.txt');

export function loadDemoMode(): boolean {
  try {
    const f = demoFile();
    return f.exists ? f.textSync().trim() === 'on' : DEMO_DEFAULT;
  } catch {
    return DEMO_DEFAULT;
  }
}

export function saveDemoMode(on: boolean) {
  try {
    const f = demoFile();
    if (!f.exists) f.create();
    f.writeSync(on ? 'on' : 'off');
  } catch (e) {
    console.warn('could not save demo mode', e);
  }
}
