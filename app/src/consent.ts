// Apple guideline 5.1.2(i): tell people before their data goes to a third-party AI, and get explicit permission.
// Warmer sends camera photos of the screen and the user's voice to Google's Gemini. We ask once, on first launch,
// and remember the answer in a small file on the phone.
import { File, Paths } from 'expo-file-system';

const consentFile = () => new File(Paths.document, 'ai-consent-v1.txt');

export const CONSENT_TEXT =
  "Warmer sends photos of the screen in front of you, and your voice when you hold the button, to Google's Gemini AI. " +
  'That is how it reads the screen and understands what you want. Nothing is sold or used for ads, and your PIN never leaves your phone.';

export function hasConsent(): boolean {
  try {
    return consentFile().exists;
  } catch {
    return false;
  }
}

export function saveConsent() {
  try {
    const f = consentFile();
    if (!f.exists) f.create();
    f.writeSync(`agreed ${new Date().toISOString()}`);
  } catch (e) {
    console.warn('could not save consent', e);
  }
}
