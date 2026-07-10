// 1:1 port of sonilo-web's LoudnessMath (Backend.Core/Audio/LoudnessMath.cs and
// frontend/src/lib/audio/loudnessMath.ts). Keep constants and formulas identical
// so this kit's renders match the proven sonilo-web pipeline.

export const FALLBACK_MUSIC_LUFS = -16.0;
export const OUTPUT_CEILING_DBFS = -1.0;
export const SLIDER_CENTER = 0.5;
export const SLIDER_SPAN_DB = 24.0;
/** Music gap (no-speech) level sits this many LU below the voice anchor. */
export const GAP_BELOW_VOICE_LU = 4.0;
export const DELIVERY_TARGET_LUFS = -14.0;
export const MAX_DELIVERY_BOOST_DB = 12.0;

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** Slider offset in dB: 0.5 → 0, 1.0 → +12, 0 → −12. */
export function offsetDb(slider01: number): number {
  return (slider01 - SLIDER_CENTER) * SLIDER_SPAN_DB;
}

/** Music gain at the bed level shifted by the slider. Slider 0 = mute. */
export function gapGain(bedLufs: number, musicLufs: number, slider01: number): number {
  return slider01 <= 0 ? 0 : dbToLinear(bedLufs + offsetDb(slider01) - musicLufs);
}

/** Original-track gain: ABSOLUTE, clamped [0,1] — 1.0 = as recorded, never boosts. */
export function originalFinalGain(originalSlider: number): number {
  return Math.max(0, Math.min(1, originalSlider));
}
