import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** One account's credential, as written by `sonilo login`. */
export interface StoredCredential {
  api_key: string;
  key_id: string;
  account_id: string;
  account_name: string | null;
  expires_at: string;
  created_at: string;
  created_by: string;
}

interface CredentialFile {
  version: number;
  credentials: Record<string, StoredCredential>;
}

const FORMAT_VERSION = 1;

/** `$XDG_CONFIG_HOME/sonilo/credentials.json`, else `~/.config/...`. The env is
 *  a parameter so tests never depend on the developer's home directory. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), ".config");
  return join(base, "sonilo", "credentials.json");
}

function load(filePath: string): CredentialFile {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { version: FORMAT_VERSION, credentials: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt file reads as "no credential" — `login` will overwrite it.
    return { version: FORMAT_VERSION, credentials: {} };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { version: FORMAT_VERSION, credentials: {} };
  }
  const file = parsed as Partial<CredentialFile>;
  if (typeof file.version === "number" && file.version > FORMAT_VERSION) {
    throw new Error(
      `${filePath} was written by a newer sonilo CLI (format ${file.version}). Upgrade the CLI or delete the file.`,
    );
  }
  return {
    version: FORMAT_VERSION,
    credentials: (file.credentials ?? {}) as Record<string, StoredCredential>,
  };
}

function save(filePath: string, file: CredentialFile): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Write beside the target and rename: an interrupted write can never leave a
  // half-written credential where a whole one used to be.
  const tmp = `${filePath}.${process.pid}.tmp`;
  // "wx" refuses to follow or overwrite a pre-planted path at `tmp` — the
  // write throws instead of silently writing into whatever an attacker (or a
  // stale leftover) put there.
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort — the rename failure is the one that matters */
    }
    throw err;
  }
  chmodSync(filePath, 0o600);
}

export function readCredential(
  apiBase: string,
  filePath: string = credentialsPath(),
): StoredCredential | null {
  const entry = load(filePath).credentials[apiBase];
  return entry && typeof entry.api_key === "string" ? entry : null;
}

export function writeCredential(
  apiBase: string,
  cred: StoredCredential,
  filePath: string = credentialsPath(),
): void {
  const file = load(filePath);
  file.credentials[apiBase] = cred;
  save(filePath, file);
}

export function removeCredential(
  apiBase: string,
  filePath: string = credentialsPath(),
): void {
  const file = load(filePath);
  if (!(apiBase in file.credentials)) return;
  delete file.credentials[apiBase];
  if (Object.keys(file.credentials).length === 0) {
    try {
      unlinkSync(filePath);
    } catch {
      /* already gone */
    }
    return;
  }
  save(filePath, file);
}
