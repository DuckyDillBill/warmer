// WebView <-> app bridge for web/eyes.html. Contract: CLAUDE.md §5.
import type { RefObject } from 'react';
import type WebView from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import type { Box, Point } from './guidance';

export type EyesEvents = {
  onReady?: () => void;
  onFingertip?: (p: Point | null) => void;
  onScreenChanged?: (hash: string) => void;
  onTargetMoved?: (box: Box) => void; // the camera page tracked the button as the phone moved
  onError?: (message: string) => void;
};

type Frame = { jpeg: string; hash: string };

export class Eyes {
  ready = false;
  private pending = new Map<string, (f: Frame) => void>();
  private n = 0;

  constructor(private web: RefObject<WebView | null>, public events: EyesEvents = {}) {}

  private send(msg: object) {
    const js = `window.warmerReceive && window.warmerReceive(${JSON.stringify(msg)}); true;`;
    this.web.current?.injectJavaScript(js);
  }

  handle = (e: WebViewMessageEvent) => {
    let msg: any;
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.events.onReady?.();
        break;
      case 'fingertip':
        this.events.onFingertip?.({ x: msg.x, y: msg.y });
        break;
      case 'nohand':
        this.events.onFingertip?.(null);
        break;
      case 'targetMoved':
        this.events.onTargetMoved?.(msg.box as Box);
        break;
      case 'screenChanged':
        this.events.onScreenChanged?.(msg.hash);
        break;
      case 'frame': {
        const cb = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        cb?.({ jpeg: msg.jpeg, hash: msg.hash });
        break;
      }
      case 'error':
        this.events.onError?.(msg.message);
        break;
    }
  };

  /** `crop`: optional normalized region of the camera frame to send instead of the whole frame. */
  captureFrame(timeoutMs = 4000, crop?: Box): Promise<Frame> {
    const id = `f${++this.n}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('camera frame timeout'));
      }, timeoutMs);
      this.pending.set(id, (f) => {
        clearTimeout(t);
        resolve(f);
      });
      this.send({ type: 'captureFrame', id, ...(crop ? { crop } : {}) });
    });
  }

  /** label is shown on the projector's /watch page. private hides everything there (used for PIN entry). */
  setTarget(box: Box | null, label = '', isPrivate = false) {
    this.send({ type: 'setTarget', box, label, private: isPrivate });
  }
  setDebug(on: boolean) {
    this.send({ type: 'debug', on });
  }
  setSensitivity(value: 'normal' | 'high') {
    this.send({ type: 'sensitivity', value });
  }
}
