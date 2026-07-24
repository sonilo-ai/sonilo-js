import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CONFIG = JSON.parse(
  readFileSync(resolve(__dirname, "../../../context7.json"), "utf8"),
) as Record<string, unknown>;

/** Limits from https://context7.com/schema/context7.json. Context7's parser
 * tolerates oversized values — the repo indexes fine — but the ownership claim
 * validates strictly and rejects the whole file. That asymmetry hid three
 * over-long rules here until claiming the sibling repo failed on the same bug. */
const MAX_RULE_LEN = 255;
const MAX_RULES = 50;

const ALLOWED_KEYS = new Set([
  "$schema", "projectTitle", "description", "branch", "folders",
  "excludeFolders", "excludeFiles", "rules", "disallow", "redirect",
  "previousVersions", "url", "public_key",
]);

describe("context7.json", () => {
  it("uses only keys the schema allows", () => {
    expect(Object.keys(CONFIG).filter((k) => !ALLOWED_KEYS.has(k))).toEqual([]);
  });

  it("keeps every rule within the 255-character limit", () => {
    const rules = CONFIG.rules as string[];
    expect(rules.length).toBeLessThanOrEqual(MAX_RULES);
    expect(rules.filter((r) => r.length > MAX_RULE_LEN)).toEqual([]);
  });

  it("stays within the description and title limits", () => {
    expect((CONFIG.description as string).length).toBeLessThanOrEqual(200);
    expect((CONFIG.projectTitle as string).length).toBeLessThanOrEqual(100);
  });

  it("keeps excludeFiles free of path separators, as the schema requires", () => {
    for (const f of (CONFIG.excludeFiles as string[]) ?? []) {
      expect(f).not.toMatch(/[/\\]/);
    }
  });
});
