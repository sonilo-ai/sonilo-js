import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  credentialsPath,
  readCredential,
  removeCredential,
  writeCredential,
  type StoredCredential,
} from "../src/credentials.js";

const BASE = "https://api.sonilo.com";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "sonilo-cred-")), "credentials.json");
}

function sample(overrides: Partial<StoredCredential> = {}): StoredCredential {
  return {
    api_key: "sk-abc",
    key_id: "key-1",
    account_id: "acct-1",
    account_name: "Acme",
    expires_at: "2026-11-09T04:12:00Z",
    created_at: "2026-08-11T04:12:00Z",
    created_by: "sonilo-cli/0.12.0",
    ...overrides,
  };
}

describe("credentialsPath", () => {
  it("honours XDG_CONFIG_HOME", () => {
    expect(credentialsPath({ XDG_CONFIG_HOME: "/x/cfg" } as NodeJS.ProcessEnv)).toBe(
      "/x/cfg/sonilo/credentials.json",
    );
  });

  it("falls back to ~/.config", () => {
    expect(credentialsPath({ HOME: "/home/me" } as NodeJS.ProcessEnv)).toBe(
      "/home/me/.config/sonilo/credentials.json",
    );
  });
});

describe("credential store", () => {
  it("returns null when the file does not exist", () => {
    expect(readCredential(BASE, tmpFile())).toBeNull();
  });

  it("round-trips a credential", () => {
    const path = tmpFile();
    writeCredential(BASE, sample(), path);
    expect(readCredential(BASE, path)?.api_key).toBe("sk-abc");
  });

  it("keys credentials by API base so staging cannot shadow prod", () => {
    const path = tmpFile();
    writeCredential(BASE, sample({ api_key: "sk-prod" }), path);
    writeCredential("https://api.staging.sonilo.com", sample({ api_key: "sk-stg" }), path);

    expect(readCredential(BASE, path)?.api_key).toBe("sk-prod");
    expect(readCredential("https://api.staging.sonilo.com", path)?.api_key).toBe("sk-stg");
  });

  it("writes the file 0600", () => {
    const path = tmpFile();
    writeCredential(BASE, sample(), path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("removes one entry without disturbing the others", () => {
    const path = tmpFile();
    writeCredential(BASE, sample(), path);
    writeCredential("https://other", sample({ api_key: "sk-other" }), path);

    removeCredential(BASE, path);

    expect(readCredential(BASE, path)).toBeNull();
    expect(readCredential("https://other", path)?.api_key).toBe("sk-other");
  });

  it("refuses a file from a newer format instead of guessing", () => {
    const path = tmpFile();
    writeFileSync(path, JSON.stringify({ version: 99, credentials: {} }));
    expect(() => readCredential(BASE, path)).toThrow(/newer/i);
  });

  it("treats unreadable JSON as no credential rather than crashing", () => {
    const path = tmpFile();
    writeFileSync(path, "{ not json");
    expect(readCredential(BASE, path)).toBeNull();
  });

  it("refuses to overwrite a pre-planted file at the tmp write path", () => {
    const path = tmpFile();
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, "planted");

    expect(() => writeCredential(BASE, sample(), path)).toThrow();
    // "wx" means the planted file was refused outright, not followed or
    // silently overwritten.
    expect(readFileSync(tmp, "utf8")).toBe("planted");
  });

  it("cleans up the tmp file, best-effort, when the rename step fails", () => {
    const path = tmpFile();
    // A directory sitting where the target file must go makes rename(2)
    // fail (EISDIR), without needing to mock node:fs.
    mkdirSync(path);
    const tmp = `${path}.${process.pid}.tmp`;

    expect(() => writeCredential(BASE, sample(), path)).toThrow();
    expect(existsSync(tmp)).toBe(false);
  });

  it("leaves unknown fields alone when rewriting", () => {
    const path = tmpFile();
    writeFileSync(
      path,
      JSON.stringify({ version: 1, credentials: { [BASE]: { ...sample(), future: 1 } } }),
    );
    writeCredential("https://other", sample(), path);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.credentials[BASE].future).toBe(1);
  });
});
