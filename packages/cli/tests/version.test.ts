import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { VERSION } from "../src/version.js";

describe("cli version", () => {
  // `sonilo --version` used to print the SDK's VERSION, so it reported what the
  // CLI wraps rather than the CLI itself. It now has its own constant, which
  // has to track packages/cli/package.json.
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});
