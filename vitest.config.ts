import { defineConfig } from "vitest/config";

export default defineConfig({
  // hookTimeout: the ffmpeg-backed suites build ~30 media fixtures in beforeAll.
  // That fits in vitest's 10 s default locally but not on a loaded CI runner,
  // where several workers compete for the CPU — the hook is legitimately slow,
  // not stuck.
  test: { include: ["tests/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 120_000 },
});
