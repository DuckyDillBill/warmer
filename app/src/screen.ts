// Saves battery while guiding: the screen goes dark (a blind user doesn't need it lit; on OLED iPhones a dark
// screen draws far less power). Brightness comes back when the order ends, fails, or the app leaves the foreground.
// Off in demo mode so people can watch the screen.
import * as Brightness from 'expo-brightness';
let dimmed = false;
let demo = false;
let saved: number | null = null;

export async function dimScreen() {
  if (demo || dimmed) return;
  dimmed = true;
  try {
    saved = await Brightness.getBrightnessAsync();
    if (dimmed) await Brightness.setBrightnessAsync(0);
  } catch (e) {
    console.warn('dim failed', e);
  }
}

export async function restoreScreen() {
  if (!dimmed) return;
  dimmed = false;
  try {
    if (saved !== null) await Brightness.setBrightnessAsync(saved);
  } catch (e) {
    console.warn('restore brightness failed', e);
  }
}

/** Demo mode keeps the screen bright (and brightens it right away if it was dark). */
export function setDemoScreen(on: boolean) {
  demo = on;
  if (on) restoreScreen();
}
