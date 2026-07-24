import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const BIN = resolve(__dirname, "../dist/cli.js");

/** Every other test imports the run* functions directly, so none of them ever
 * executes the entrypoint guard. That gap shipped a 0.2.0 whose every command
 * silently exited 0: npm installs a bin as a symlink, and the guard compared
 * argv[1] (the link) against import.meta.url (already resolved). These tests
 * run the built file the way a user actually gets it. */
describe("bin entrypoint", () => {
  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: resolve(__dirname, ".."), stdio: "ignore" });
  });

  it("runs when invoked directly", () => {
    const out = execFileSync("node", [BIN, "--version"], { encoding: "utf8" });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("runs when invoked through a symlink, as npm installs it", () => {
    const dir = mkdtempSync(join(tmpdir(), "sonilo-bin-"));
    try {
      const link = join(dir, "sonilo");
      symlinkSync(BIN, link);
      const out = execFileSync("node", [link, "--version"], { encoding: "utf8" });
      expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints help rather than exiting silently", () => {
    const out = execFileSync("node", [BIN, "--help"], { encoding: "utf8" });
    expect(out).toContain("sonilo");
    expect(out.length).toBeGreaterThan(100);
  });
});
