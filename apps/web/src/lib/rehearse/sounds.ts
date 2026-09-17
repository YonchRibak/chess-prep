/**
 * Two tiny WebAudio blips for the rehearsal session — off by default, the
 * preference persisted in the `meta` KV store. No assets: a short sine
 * envelope is enough for "right" / "wrong" and costs nothing offline.
 */
import { getMeta, setMeta } from '../idb/schema.ts';

const KEY = 'rehearse.sound';
let ctx: AudioContext | null = null;

export async function loadSoundPref(): Promise<boolean> {
  try {
    return (await getMeta(KEY)) === '1';
  } catch {
    return false;
  }
}

export async function saveSoundPref(on: boolean): Promise<void> {
  try {
    await setMeta(KEY, on ? '1' : '0');
  } catch {
    /* preference only */
  }
}

function blip(freq: number, ms: number, gain = 0.08): void {
  try {
    ctx ??= new AudioContext();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.value = gain;
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
    osc.connect(g).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + ms / 1000);
  } catch {
    /* no audio — fine */
  }
}

export const sounds = {
  correct: () => blip(880, 120),
  wrong: () => blip(220, 220, 0.1),
};
