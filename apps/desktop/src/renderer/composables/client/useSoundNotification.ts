// apps/kimi-web/src/composables/client/useSoundNotification.ts
// Browser attention sound: a persisted on/off preference plus a short chime
// synthesized with the WebAudio API (no audio asset, no permission prompt).
// One chime covers every "the agent needs you" moment — a finished turn, a
// question waiting for an answer, a tool needing approval. Pure UI action
// module — it never reads rawState or calls the API.
//
// Why the eager "unlock": the sound is most useful when the tab is in the
// background (so you hear it while doing something else). But an AudioContext
// created/resumed outside a user gesture is left suspended by the browser's
// autoplay policy, and a suspended context in a background tab stays silent.
// So we create + resume the context on the first user gesture (and again when
// the toggle is switched on, which is itself a gesture). Once running, the
// context keeps producing sound even when the tab is later backgrounded.
//
// Diagnostics: with tracing on (?debug=1) the key steps are recorded into the
// troubleshooting log (Settings → Advanced → Export log), so a user can report
// exactly why a sound did or didn't play.

import { ref } from 'vue';
import { safeGetString, safeSetString, STORAGE_KEYS } from '../../lib/storage';
import { traceClientEvent } from '../../debug/trace';

function loadSound(): boolean {
  // Off by default — a completion sound is easy to opt into via Settings, and
  // an unexpected chime is more surprising than a missing one.
  return safeGetString(STORAGE_KEYS.soundOnComplete) === '1';
}

const soundOnComplete = ref(loadSound());

type AudioContextCtor = new () => AudioContext;

function getAudioContextCtor(): AudioContextCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as Window & { webkitAudioContext?: AudioContextCtor };
  return window.AudioContext ?? w.webkitAudioContext;
}

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  const Ctor = getAudioContextCtor();
  if (!Ctor) return null;
  if (audioCtx === null) {
    try {
      audioCtx = new Ctor();
    } catch {
      return null;
    }
  }
  return audioCtx;
}

/** Create/resume the AudioContext. Must be called from (or after) a user
    gesture for the browser's autoplay policy to allow it. No-op when the
    preference is off or audio is unavailable. */
function ensureAudioUnlocked(): void {
  if (!soundOnComplete.value) return;
  const ctx = getAudioContext();
  if (ctx === null) return;
  if (ctx.state === 'suspended') {
    void ctx.resume().then(
      () => {
        traceClientEvent('sound: audio context resumed', { state: ctx.state });
      },
      (error) => {
        traceClientEvent('sound: audio context resume rejected', { error: String(error) });
      },
    );
  }
}

let unlockInstalled = false;

/** Register once: on the first pointer/key gesture, unlock audio so a later
    completion (even in a background tab) can play. */
function installGestureUnlock(): void {
  if (unlockInstalled || typeof window === 'undefined') return;
  unlockInstalled = true;
  const handler = (): void => {
    ensureAudioUnlocked();
  };
  // capture so we still run if a component calls stopPropagation.
  window.addEventListener('pointerdown', handler, { capture: true });
  window.addEventListener('keydown', handler, { capture: true });
}

installGestureUnlock();

/** Enable/disable the completion sound. Persisted across reloads. Enabling also
    unlocks audio immediately, because the toggle click is a user gesture. */
function setSoundOnComplete(on: boolean): void {
  soundOnComplete.value = on;
  safeSetString(STORAGE_KEYS.soundOnComplete, on ? '1' : '0');
  if (on) ensureAudioUnlocked();
}

function tone(ctx: AudioContext, freq: number, start: number, duration: number, peak: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(ctx.destination);
  const t0 = ctx.currentTime + start;
  // Exponential ramps can't target 0, so use a tiny floor to fade in/out
  // without the click you get from an abrupt start/stop.
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function playChime(): void {
  const ctx = getAudioContext();
  if (ctx === null) {
    traceClientEvent('sound: skipped, AudioContext unavailable');
    return;
  }
  // Never queue tones on a suspended context: its clock is frozen, so a chime
  // scheduled now would play stale when the context later resumes (e.g. on the
  // next click) rather than at completion time. If it isn't running yet, try to
  // unlock it for next time and skip this one.
  if (ctx.state !== 'running') {
    traceClientEvent('sound: skipped, context not running', { state: ctx.state });
    if (ctx.state === 'suspended') {
      void ctx.resume().then(
        () => {
          traceClientEvent('sound: context resumed for next time', { state: ctx.state });
        },
        (error) => {
          traceClientEvent('sound: resume rejected', { error: String(error) });
        },
      );
    }
    return;
  }
  try {
    // A short two-note "ding": a soft lower note followed by a brighter one.
    tone(ctx, 880, 0, 0.16, 0.18);
    tone(ctx, 1320, 0.1, 0.22, 0.16);
    traceClientEvent('sound: chime scheduled', { state: ctx.state });
  } catch (error) {
    traceClientEvent('sound: failed to play', { error: String(error) });
  }
}

/** Play the completion sound for a finished session, whenever the preference
    is on. We intentionally do NOT suppress it while the tab is visible: a
    completion sound is only useful if it also reaches a backgrounded tab, and
    users who don't want it can turn the toggle off. */
function maybePlayCompletionSound(): void {
  if (!soundOnComplete.value) return;
  playChime();
}

/** Play the attention sound when a session asks a question, whenever the
    preference is on. Same chime as completion: it means "the agent needs you". */
function maybePlayQuestionSound(): void {
  if (!soundOnComplete.value) return;
  playChime();
}

/** Play the attention sound when a tool needs approval, whenever the
    preference is on. Same chime as completion: it means "the agent needs you". */
function maybePlayApprovalSound(): void {
  if (!soundOnComplete.value) return;
  playChime();
}

export function useSoundNotification() {
  return {
    soundOnComplete,
    setSoundOnComplete,
    maybePlayCompletionSound,
    maybePlayQuestionSound,
    maybePlayApprovalSound,
  };
}
