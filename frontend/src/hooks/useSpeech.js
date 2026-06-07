/**
 * useSpeech.js — voice coach for MoveMate webcam workout
 *
 * KEY FIX: Chrome blocks speechSynthesis.speak() unless called from
 * a user-gesture context (click/tap). The RAF render loop is NOT a user gesture.
 *
 * Solution:
 *   1. Call unlockSpeech() on the "Start Workout" button click FIRST.
 *      This speaks a silent utterance from inside the click handler,
 *      which registers the AudioContext as user-activated for this page.
 *   2. All subsequent speak() calls (including from RAF) work fine.
 *
 * Types:
 *   "rep"   — rep numbers: queued, never cancels other speech
 *   "coach" — coaching cues: cancels current, dedup 4s
 *   "info"  — idle-only, dedup 8s
 */

let _unlocked         = false;
let _voiceList        = [];
let _selectedVoice    = null;
let _keepAliveTimer   = null;
const _lastSaid       = {};
const COACH_DEDUP     = 4000;
const INFO_DEDUP      = 8000;

// ─── Voice loading ────────────────────────────────────────────────────────────

function loadVoices() {
  _voiceList     = window.speechSynthesis?.getVoices() ?? [];
  _selectedVoice = null;
}

function getVoice() {
  if (_selectedVoice) return _selectedVoice;
  if (!_voiceList.length) loadVoices();
  _selectedVoice =
    _voiceList.find((v) => v.lang === "en-US" && /google/i.test(v.name))  ||
    _voiceList.find((v) => v.lang === "en-US")                             ||
    _voiceList.find((v) => v.lang.startsWith("en") && !/espeak/i.test(v.name)) ||
    _voiceList[0] || null;
  return _selectedVoice;
}

if (typeof window !== "undefined" && window.speechSynthesis) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = () => { loadVoices(); };
}

// ─── Chrome keepalive ─────────────────────────────────────────────────────────

function startKeepAlive() {
  if (_keepAliveTimer) return;
  _keepAliveTimer = setInterval(() => {
    if (window.speechSynthesis?.paused) window.speechSynthesis.resume();
  }, 5000);
}

function stopKeepAlive() {
  clearInterval(_keepAliveTimer);
  _keepAliveTimer = null;
}

// ─── Utterance builder ────────────────────────────────────────────────────────

function makeUtt(text, rate = 1.1) {
  const utt   = new SpeechSynthesisUtterance(text);
  utt.voice   = getVoice();
  utt.lang    = "en-US";
  utt.rate    = rate;
  utt.pitch   = 1.0;
  utt.volume  = 1.0;
  utt.onstart = startKeepAlive;
  utt.onend   = () => { if (!window.speechSynthesis.pending) stopKeepAlive(); };
  utt.onerror = (e) => {
    if (e.error !== "interrupted" && e.error !== "canceled") {
      console.warn("[speech] onerror:", e.error, "text:", text);
    }
  };
  return utt;
}

// ─── Unlock (MUST be called from a click/tap handler) ────────────────────────

/**
 * Call this synchronously inside a user click/tap event handler BEFORE
 * starting the RAF loop. It speaks a silent utterance to register
 * the page as audio-context-activated in Chrome.
 */
export function unlockSpeech() {
  if (_unlocked) return;
  if (typeof window === "undefined" || !window.speechSynthesis) return;

  const synth = window.speechSynthesis;
  synth.cancel();

  // Speak a zero-volume, near-silent utterance — this is the key unlock
  const utt     = new SpeechSynthesisUtterance(" ");
  utt.volume    = 0;
  utt.rate      = 10;   // finish instantly
  utt.onend     = () => { _unlocked = true; };
  utt.onerror   = () => { _unlocked = true; }; // still mark unlocked even on error
  synth.speak(utt);
  // Also set immediately — Chrome marks the context activated on .speak() call itself
  _unlocked = true;
}

// ─── Public speak API ─────────────────────────────────────────────────────────

export function speak(text, type = "info") {
  if (typeof window === "undefined" || !window.speechSynthesis || !text) return;
  if (!_unlocked) return; // silently skip until unlocked by user gesture

  const synth = window.speechSynthesis;
  const now   = Date.now();

  if (type === "rep") {
    // Never cancel — just queue. Rep numbers are short so they play almost instantly.
    synth.speak(makeUtt(text, 1.3));
    return;
  }

  if (type === "coach") {
    if (_lastSaid[text] && now - _lastSaid[text] < COACH_DEDUP) return;
    _lastSaid[text] = now;
    synth.cancel();
    synth.speak(makeUtt(text, 1.1));
    return;
  }

  // "info" — only when idle
  if (synth.speaking || synth.pending) return;
  if (_lastSaid[text] && now - _lastSaid[text] < INFO_DEDUP) return;
  _lastSaid[text] = now;
  synth.speak(makeUtt(text, 1.0));
}

/** Call on component unmount */
export function stopSpeech() {
  stopKeepAlive();
  _unlocked = false;
  try { window.speechSynthesis?.cancel(); } catch (_) {}
  Object.keys(_lastSaid).forEach((k) => delete _lastSaid[k]);
}
