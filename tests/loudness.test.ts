import { describe, expect, it } from "vitest";
import {
  FALLBACK_MUSIC_LUFS,
  GAP_BELOW_VOICE_LU,
  OUTPUT_CEILING_DBFS,
  dbToLinear,
  gapGain,
  offsetDb,
  originalFinalGain,
} from "../src/loudness.js";

describe("loudness math (port of sonilo-web LoudnessMath — numbers must match)", () => {
  it("dbToLinear", () => {
    expect(dbToLinear(0)).toBe(1);
    expect(dbToLinear(-6)).toBeCloseTo(0.5011872336, 9);
    expect(dbToLinear(12)).toBeCloseTo(3.9810717055, 9);
  });

  it("offsetDb maps slider 0/0.5/1 to -12/0/+12", () => {
    expect(offsetDb(0)).toBe(-12);
    expect(offsetDb(0.5)).toBe(0);
    expect(offsetDb(1)).toBe(12);
  });

  it("gapGain at slider center is bed-minus-music in linear", () => {
    // bed -20, music -16 → -4 dB → 0.63095...
    expect(gapGain(-20, -16, 0.5)).toBeCloseTo(0.6309573445, 9);
  });

  it("gapGain slider extremes shift ±12 dB", () => {
    expect(gapGain(-20, -16, 1)).toBeCloseTo(dbToLinear(-4 + 12), 9);
    expect(gapGain(-20, -16, 0)).toBe(0); // 0 = mute, not -12 dB
  });

  it("originalFinalGain is absolute and attenuate-only", () => {
    expect(originalFinalGain(1)).toBe(1);
    expect(originalFinalGain(0.25)).toBe(0.25);
    expect(originalFinalGain(1.5)).toBe(1); // clamped — never boosts
    expect(originalFinalGain(-0.5)).toBe(0);
  });

  it("constants match sonilo-web", () => {
    expect(FALLBACK_MUSIC_LUFS).toBe(-16);
    expect(GAP_BELOW_VOICE_LU).toBe(4);
    expect(OUTPUT_CEILING_DBFS).toBe(-1);
  });
});
