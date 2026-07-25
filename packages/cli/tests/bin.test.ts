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

  /** Slice one "<name> options:" block out of the help text. Blocks are
   * separated by a blank line, and the leading newline anchors the heading so
   * "video-to-music" cannot match inside "video-to-video-music". */
  function optionBlock(help: string, command: string): string {
    const start = help.indexOf(`\n${command} options`);
    expect(start).toBeGreaterThan(-1);
    const end = help.indexOf("\n\n", start + 1);
    return help.slice(start, end === -1 ? undefined : end);
  }

  // --isolate-vocals and --preserve-speech are one feature under two names --
  // the backend ORs them onto a single flag (video_to_music router) -- and this
  // CLI writes only audio[0], exposing no --stem for the vocals/mux entries the
  // task carries. The help used to describe them as two independent options, one
  // of which promised "a vocals-only stem" the CLI cannot hand back. Pin the
  // wording so that cannot come back, and keep it matching the Python CLI's.
  it("presents --isolate-vocals as a legacy alias, promising no stem", () => {
    const out = execFileSync("node", [BIN, "--help"], { encoding: "utf8" });

    const music = optionBlock(out, "video-to-music");
    expect(music).toContain("--preserve-speech");
    expect(music).toContain("--isolate-vocals");
    expect(music).toContain("Legacy alias for --preserve-speech");
    expect(music).not.toContain("stem");

    const videoMusic = optionBlock(out, "video-to-video-music");
    expect(videoMusic).toContain("Legacy alias for --preserve-speech");
    expect(videoMusic).not.toContain("stem");
  });
});
