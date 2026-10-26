/** 読み上げ: Android's TextToSpeech in the APK (the WebView has no speech synthesis), the Web Speech API elsewhere. */
import { native } from '../platform';
import { looksEnglish } from './cards';

export function canSpeak(): boolean {
  return !!native?.speak || (typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined');
}

/** Read `text` aloud ('en' or 'ja'; guessed from the text when omitted). */
export function speak(text: string, rate = 1, lang?: 'en' | 'ja'): boolean {
  const l = lang ?? (looksEnglish(text) ? 'en' : 'ja');
  const tag = l === 'en' ? 'en-US' : 'ja-JP';
  if (native?.speak) {
    native.speak(text, tag, rate);
    return true;
  }
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return false;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = tag;
  u.rate = rate;
  speechSynthesis.speak(u);
  return true;
}

export function stopSpeaking() {
  if (native?.stopSpeaking) native.stopSpeaking();
  else if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}

/** Sentences, for reading a passage one at a time. */
export function sentences(text: string): string[] {
  return (text.replace(/\s+/g, ' ').match(/[^.!?。！？]+[.!?。！？]*["”’)）]?/g) ?? []).map((s) => s.trim()).filter(Boolean);
}
