import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  APIError,
  SoniloClient,
  SoniloError,
  download,
  type DubbingParams,
  type DubbingResult,
  type MusicMediaEntry,
  type MusicTaskResult,
  type Segment,
  type SfxMedia,
  type SfxResult,
  type SfxSegment,
  type SfxTask,
  type SoundResult,
  type TrialQuota,
  type VideoResult,
  type VideoToVideoSoundParams,
  type WaitOptions,
} from "sonilo";
import { VERSION } from "./version.js";
import { defaultLoginDeps, runLogin, runLogout, runWhoami } from "./login.js";

const HELP = `sonilo — command-line interface for the Sonilo API

Usage:
  sonilo <command> [options]

Commands:
  login                         Sign in and store an API key for future commands
  logout                        Revoke the stored key and forget it locally
  whoami                        Show which account and key are currently active
  account                       Show plan limits and available services
  usage [--days <n>]            Show usage summary (default: last 30 days)
  text-to-music                 Generate music from a text prompt
  video-to-music                Generate music matched to a video
  text-to-sfx                   Generate a sound effect from a text prompt
  video-to-sfx                  Generate a sound effect matched to a video
  video-to-sound                Generate a combined music + SFX track for a video
  video-to-video-sound          Same as video-to-sound, muxed back into the video
  video-to-video-music          Score a video and get the video back with music
  video-to-video-sfx            Add sound effects and get the video back
  dubbing                       Dub a video into other languages
  tasks get <task-id>           Fetch the current state of an async task
  tasks wait <task-id>          Poll an async task until it finishes
                                (--poll-interval <ms>, --timeout <ms>)

login options:
  --force               Re-authenticate even if a credential is already
                        stored for this API base.
  --no-browser          Print the sign-in URL instead of opening it in a
                        browser.
  --api-base <url>      Sign in against a non-default API deployment.
                        Default: SONILO_API_URL, or https://api.sonilo.com

logout options:
  --local-only          Remove the local credential only; do not revoke the
                        key server-side.
  --api-base <url>      Sign out of a non-default API deployment.
                        Default: SONILO_API_URL, or https://api.sonilo.com

text-to-music options:
  --prompt <text>       Required. What the music should sound like.
  --duration <seconds>  Required. Track length.
  --output <path>       Where to save the audio (default: ./output.<ext>)
  --format <m4a|wav|mp3>  Output container. Anything but m4a forces
                        --async. mp3 is 320 kbps. Default: m4a
  --async               Submit and poll instead of streaming the response
  --segments <json>     Per-segment prompts: [{start, prompt, label?}, ...]
                        (see "Segments" below)
  --variants <n>        How many distinct variants to generate (1-10,
                        default 1). Forces --async above 1. Cost scales
                        linearly; above 1 is never covered by the free
                        trial. Above 1, one file is written per variant:
                        --output track.wav --variants 3 writes track.0.wav,
                        track.1.wav, track.2.wav.

video-to-music options:
  --video <path>              Required (or --video-url). Local file to score.
  --video-url <url>           Required (or --video). Remote video to score.
  --prompt <text>              Optional creative direction for the music.
  --output <path>              Where to save the audio (default: ./output.<ext>)
  --format <m4a|wav|mp3>       Output container. Anything but m4a forces
                               --async. mp3 is 320 kbps.
  --preserve-speech             Keep source speech in the mix. Forces --async.
  --isolate-vocals              Legacy alias for --preserve-speech. Forces --async.
  --async                       Submit and poll instead of streaming
  --segments <json>             Per-segment prompts: [{start, prompt, label?}, ...]
                                (see "Segments" below)
  --variants <n>                How many distinct variants to generate (1-10,
                                default 1). Forces --async above 1. Cost
                                scales linearly; above 1 is never covered by
                                the free trial. Above 1, one file is written
                                per variant, indexed before the extension
                                (see --variants under text-to-music above).
  --prompt-influence <0-1>      How strongly the music follows the prompt
                                (default 0.5). Lower values let the video
                                lead; higher values follow the prompt more
                                literally. Free of charge. Works with or
                                without --async.

text-to-sfx options:
  --prompt <text>        Required. What the sound effect should be.
  --duration <seconds>   Required. Effect length.
  --output <path>        Where to save the audio (default: ./output.<ext>)
  --format <wav|mp3|aac|flac>   Output format. Default: wav

video-to-sfx options:
  --video <path>         Required (or --video-url). Local file to score.
  --video-url <url>      Required (or --video). Remote video to score.
  --prompt <text>         Optional creative direction for the effect.
  --output <path>         Where to save the audio (default: ./output.<ext>)
  --format <wav|mp3|aac|flac>   Output format. Default: wav
  --segments <json>       Per-segment prompts: [{start, end, prompt}, ...]
                          (see "Segments" below)

video-to-sound / video-to-video-sound options (both async-only):
  --video <path>         Required (or --video-url). Local file to score.
  --video-url <url>      Required (or --video). Remote video to score.
  --music-prompt <text>   Optional style hint for the music bed.
  --sfx-prompt <text>     Optional description of the sound effects.
  --keep-original-sound   Keep the source video's whole original audio in the
                          result. OFF by default, so by default the result's
                          audio is the generated music + effects ALONE.
                          video-to-video-sound only; supersedes
                          --preserve-speech.
  --preserve-speech       Keep only the source's isolated speech in the result.
  --ducking               Duck the generated bed under the voice instead of
                          mixing it in at a static level. On video-to-sound
                          this is also what pulls the source's own speech into
                          the result at all — without it the result is the
                          generated music + effects ALONE. On
                          video-to-video-sound it only picks the mix style, so
                          it has no effect unless --keep-original-sound or
                          --preserve-speech is set.
  --no-ducking            Explicit opt-out. Same as the default; kept so
                          existing scripts keep working.
  --output <path>         Where to save the result (default: ./output.<ext>)
  --segments <json>       Per-segment SFX prompts: [{start, end, prompt}, ...]
                          (see "Segments" below)
  --stem <name>           Also save one stem, in addition to the combined
                          output. Repeatable. One of: music, music_processed,
                          sfx. music_processed exists only when a voice source
                          was kept, i.e. with --keep-original-sound or
                          --preserve-speech.
                          Named <output> with ".<stem>" inserted before the
                          extension: --output mix.wav --stem music writes
                          mix.wav and mix.music.wav.
  --variants <n>          How many distinct variants to generate (1-10,
                          default 1). Cost scales linearly; above 1 is never
                          covered by the free trial. Above 1, one combined
                          output (plus any --stem files) is written per
                          variant, indexed before the extension: --output
                          mix.wav --variants 2 writes mix.0.wav, mix.1.wav
                          (and mix.0.music.wav, mix.1.music.wav with
                          --stem music).

video-to-video-music options (async-only, writes a video):
  --video <path>         Required (or --video-url). Local file to score.
  --video-url <url>      Required (or --video). Remote video to score.
  --prompt <text>         Optional creative direction for the music.
  --keep-original-sound   Keep the source video's whole original audio in the
                          result. OFF by default, so by default the returned
                          video's audio is the generated music ALONE and the
                          source's own audio is removed. Supersedes
                          --preserve-speech.
  --preserve-speech       Keep only the source's isolated speech in the result.
  --isolate-vocals        Legacy alias for --preserve-speech.
  --ducking               Duck the generated music under the voice instead of
                          mixing it in at a static level. No effect unless
                          --keep-original-sound or --preserve-speech is set.
  --no-ducking            Explicit opt-out. Same as the default; kept so
                          existing scripts keep working.
  --output <path>         Where to save the video (default: ./output.mp4)
  --variants <n>          How many distinct variants to generate (1-10,
                          default 1). Cost scales linearly; above 1 is never
                          covered by the free trial. Above 1, one video is
                          written per variant, indexed before the extension:
                          --output out.mp4 --variants 2 writes out.0.mp4,
                          out.1.mp4.
  --prompt-influence <0-1>  How strongly the music follows the prompt
                          (default 0.5). Lower values let the video lead;
                          higher values follow the prompt more literally.
                          Free of charge.

video-to-video-sfx options (async-only, writes a video):
  --video <path>         Required (or --video-url). Local file to score.
  --video-url <url>      Required (or --video). Remote video to score.
  --prompt <text>         Optional creative direction for the effects.
  --output <path>         Where to save the video (default: ./output.mp4)
  --segments <json>       Per-segment SFX prompts: [{start, end, prompt}, ...]
                          (see "Segments" below)

Segments:
  --segments takes a JSON array, and accepts three forms for the value:
    --segments '[{"start":0,"prompt":"airy pads"}]'   inline JSON
    --segments @segments.json                          read from a file
    --segments @-                                       read from stdin
  A value starting with "@" names a source to read from ("@-" means stdin);
  anything else is parsed as JSON directly. The required fields differ by
  command — music commands take {start, prompt, label?}, SFX commands take
  {start, end, prompt} — but ordering, spacing and count limits are enforced
  by the API itself, not the CLI.

dubbing options (async-only):
  --video <path>         Required (or --video-url). Local file to dub.
  --video-url <url>      Required (or --video). Must be an https URL.
  --languages <list>      Comma-separated target languages. Default: zh_cn,es,fr
                          Supported: en, zh_cn, ja, ko, pt, es, de, fr, it, ru
  --ducking               Duck the background music/effects bed under the
                          dubbed voice. Off by default: the bed is kept at a
                          constant level. Free.
  --output <path>         Filename template. One file is written per language,
                          with the code inserted before the extension:
                          --output clip.mp4 writes clip.es.mp4, clip.fr.mp4.
                          Default: ./output.mp4
  --timeout <ms>          How long to wait for the task. Default: 7200000
                          (2 hours, matching the backend's own ceiling for a
                          dubbing job). If the wait times out, the task is still
                          running — resume waiting on it with
                          "sonilo tasks wait <task-id>" using the task id
                          printed in the "Submitted task ..." line.
  Max video duration is 180 seconds. You are billed per language.

Global options:
  --api-key <key>   Overrides the SONILO_API_KEY environment variable.
  --help             Show this help and exit.
  --version          Print the CLI version and exit.

Environment:
  SONILO_API_KEY     Your API key (starts with sk-). Required unless --api-key
                     is passed.
  Credentials from "sonilo login" are stored in ~/.config/sonilo/credentials.json (override the directory with XDG_CONFIG_HOME).

Examples:
  sonilo login
  sonilo account
  sonilo text-to-music --prompt "warm lo-fi piano, rain in the background" --duration 30
  sonilo video-to-music --video clip.mp4 --prompt "tense, driving synths" --output score.wav --format wav
  sonilo text-to-sfx --prompt "glass bottle shattering on concrete" --duration 3
  sonilo dubbing --video-url https://example.com/clip.mp4 --languages es,fr --output dubbed.mp4
  sonilo tasks get 9f5f2f7e-...
`;

function fail(message: string): never {
  console.error(`sonilo: ${message}`);
  process.exit(1);
}

function requireFlag(value: string | undefined, name: string): string {
  if (value === undefined) fail(`missing required --${name}`);
  return value;
}

export function outputPath(explicit: string | undefined, ext: string): string {
  return explicit ?? `output.${ext}`;
}

/** Normalize and validate a --format value against the allowed set. Case is
 * folded so `--format WAV` behaves like `--format wav`, and unsupported values
 * fail loudly instead of silently falling through to a mislabeled file. */
export function parseFormat<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  const normalized = value.toLowerCase();
  if (!(allowed as readonly string[]).includes(normalized)) {
    fail(`invalid --format "${value}". Allowed: ${allowed.join(", ")}`);
  }
  return normalized as T;
}

/** One field of a segment shape, used both to validate a parsed segment and
 * to render the shape in an error message. */
interface SegmentField {
  key: string;
  type: "number" | "string";
}

/** The set of fields a command's `--segments` array elements must (and may)
 * have. There are exactly two shapes in the API today — music and SFX — and
 * `describe` is how the shape reads in a failure message, e.g.
 * "{start, prompt, label?}". */
interface SegmentShape {
  describe: string;
  required: readonly SegmentField[];
  optional?: readonly SegmentField[];
}

/** Music segments: `text-to-music`, `video-to-music`. */
export const MUSIC_SEGMENTS: SegmentShape = {
  describe: "{start, prompt, label?}",
  required: [
    { key: "start", type: "number" },
    { key: "prompt", type: "string" },
  ],
  optional: [{ key: "label", type: "string" }],
};

/** SFX segments: `video-to-sfx`, `video-to-video-sfx`, `video-to-sound`,
 * `video-to-video-sound`. */
export const SFX_SEGMENTS: SegmentShape = {
  describe: "{start, end, prompt}",
  required: [
    { key: "start", type: "number" },
    { key: "end", type: "number" },
    { key: "prompt", type: "string" },
  ],
};

/** Every field name either segment shape recognizes. A key outside this set
 * is a field neither shape knows about yet — most likely a future API
 * addition — and is forwarded untouched rather than rejected. A key inside
 * this set but not part of the *requested* shape is a field that belongs to
 * the *other* shape, which is almost always the predictable mistake of
 * pointing SFX-shaped segments at a music command or vice versa, so that one
 * is rejected. */
const ALL_SEGMENT_KEYS = new Set(
  [...MUSIC_SEGMENTS.required, ...(MUSIC_SEGMENTS.optional ?? [])]
    .concat(SFX_SEGMENTS.required)
    .map((field) => field.key),
);

/** Human description of a parsed `--segments` value, for the "must be a
 * non-empty array" failure. */
function describeJsonValue(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? "an empty array" : "an array";
  if (value === null) return "null";
  return `a ${typeof value}`;
}

function validateSegment(command: string, shape: SegmentShape, item: unknown, index: number): void {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    fail(`${command} segments take ${shape.describe} — element ${index} is not an object`);
  }
  const obj = item as Record<string, unknown>;
  const allowedKeys = new Set(
    [...shape.required, ...(shape.optional ?? [])].map((field) => field.key),
  );
  const keys = Object.keys(obj);
  const missingRequired = shape.required.some((field) => !(field.key in obj));
  const foreignKey = keys.some((key) => ALL_SEGMENT_KEYS.has(key) && !allowedKeys.has(key));
  if (missingRequired || foreignKey) {
    fail(
      `${command} segments take ${shape.describe} — got an object with keys ${
        keys.join(", ") || "(none)"
      }`,
    );
  }
  for (const field of [...shape.required, ...(shape.optional ?? [])]) {
    const value = obj[field.key];
    if (value === undefined) continue; // optional field, absent
    if (typeof value !== field.type) {
      fail(
        `${command} segments take ${shape.describe} — "${field.key}" must be a ${field.type} (element ${index})`,
      );
    }
  }
}

/** Read all of `stream` into a UTF-8 string, for `--segments @-`. */
async function readAllUtf8(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Read and validate a `--segments` flag value for one command.
 *
 * `raw` is the flag's literal value, in one of three forms (the curl / gh /
 * aws convention): inline JSON, `@path` to read a file, or `@-` to read
 * stdin. Returns `undefined` untouched when the flag was not passed, so
 * callers can drop it straight into a params object and have the SDK omit
 * `segments` entirely.
 *
 * Validation is shape-only: the value must parse as JSON, be a non-empty
 * array of objects, and each object must carry the given shape's required
 * fields with the right types. It deliberately does not replicate the
 * server's semantic rules (first segment at start 0, minimum spacing, the
 * label enum, count caps) — those live server-side and a client-side copy
 * would drift the moment the backend changes; malformed-but-shape-valid
 * input is left for the API's own 422.
 */
export async function readSegments(
  command: string,
  raw: string | undefined,
  shape: SegmentShape,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<unknown[] | undefined> {
  if (raw === undefined) return undefined;

  let source: string;
  let sourceDesc: string;
  if (raw.startsWith("@")) {
    const path = raw.slice(1);
    if (path === "-") {
      sourceDesc = "stdin";
      source = await readAllUtf8(stdin);
    } else {
      sourceDesc = `file "${path}"`;
      try {
        source = await readFile(path, "utf-8");
      } catch (err) {
        fail(`${command} --segments: could not read ${sourceDesc}: ${(err as Error).message}`);
      }
    }
  } else {
    sourceDesc = "the --segments value";
    source = raw;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    fail(`${command} --segments: invalid JSON in ${sourceDesc}: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    fail(`${command} --segments must be a non-empty JSON array — got ${describeJsonValue(parsed)}`);
  }

  parsed.forEach((item, index) => validateSegment(command, shape, item, index));
  return parsed;
}

/** Pull `--api-key <value>` out of the arguments from any position and return
 * the remaining tokens, so it works whether it comes before or after the
 * command. */
export function extractApiKey(argv: string[]): {
  apiKeyFlag: string | undefined;
  rest: string[];
} {
  const i = argv.indexOf("--api-key");
  if (i < 0) return { apiKeyFlag: undefined, rest: argv };
  return { apiKeyFlag: argv[i + 1], rest: argv.slice(0, i).concat(argv.slice(i + 2)) };
}

/** The individual stems `video-to-sound` / `video-to-video-sound` can save
 * alongside their combined output, matching `SoundResult` in
 * packages/sonilo/src/types.ts and the Python CLI's `--stem` exactly.
 * `music_processed` is the odd one out: it only exists on a result when a
 * voice source was kept, i.e. with `keepOriginalSound` or `preserveSpeech`.
 * On `video-to-video-sound` neither is on by default, so the default result
 * has no such stem. */
export const SOUND_STEMS = ["music", "music_processed", "sfx"] as const;
export type SoundStem = (typeof SOUND_STEMS)[number];

/** Validate `--stem` values against the allowed set, failing loudly (naming
 * the valid ones) on the first one that is not recognized — mirrors
 * `parseFormat`'s handling of an unsupported `--format`. */
export function parseStems(values: string[] | undefined): SoundStem[] {
  if (!values) return [];
  for (const value of values) {
    if (!(SOUND_STEMS as readonly string[]).includes(value)) {
      fail(`invalid --stem "${value}". Allowed: ${SOUND_STEMS.join(", ")}`);
    }
  }
  return values as SoundStem[];
}

/** Best-effort file extension from a (presigned) result URL, ignoring query
 * strings, falling back when the path carries no extension. */
export function extFromUrl(url: string, fallback: string): string {
  try {
    const path = new URL(url).pathname;
    const dot = path.lastIndexOf(".");
    if (dot >= 0 && dot < path.length - 1) return path.slice(dot + 1);
  } catch {
    // not a parseable URL — fall through to the fallback
  }
  return fallback;
}

/** Turn the resolved `--output` path into a path for one stem: the stem name
 * is inserted before the extension, and the extension itself is taken from
 * the stem's own result URL — falling back to the main output's extension
 * when the stem URL has none. `--output mix.wav` + stem "music" whose URL
 * ends in `.wav` writes `mix.music.wav`; if that URL had no extension it
 * would still write `mix.music.wav`, borrowing the main output's `.wav`.
 * Mirrors the Python CLI's `_stem_path` (sonilo_cli/__main__.py) exactly, so
 * both tools name stem files the same way. The extension search stops at the
 * last path separator, same as `languageOutputPath`, so a dot in a directory
 * name is never mistaken for a file extension. */
export function stemOutputPath(output: string, stem: string, stemUrl: string): string {
  const dot = output.lastIndexOf(".");
  const slash = Math.max(output.lastIndexOf("/"), output.lastIndexOf("\\"));
  const hasExt = dot > slash + 1;
  const base = hasExt ? output.slice(0, dot) : output;
  const mainExt = hasExt ? output.slice(dot + 1) : "";
  const ext = extFromUrl(stemUrl, mainExt);
  return ext ? `${base}.${stem}.${ext}` : `${base}.${stem}`;
}

/** Turn one `--output` value into a per-variant path when `--variants`
 * generated more than one result: `track.wav` + index 1 becomes
 * `track.1.wav`. Only called once a command already knows it has more than
 * one variant — the single-variant path (the overwhelming common case, and
 * the default) keeps writing the literal `--output` value, unsuffixed, so
 * behavior is unchanged unless `--variants` is actually used above 1.
 * Mirrors `languageOutputPath`'s insertion rule exactly (the extension
 * search stops at the last path separator so a dot in a directory name is
 * never mistaken for one), keyed on a numeric index instead of a language
 * code. */
export function variantOutputPath(template: string, index: number): string {
  const dot = template.lastIndexOf(".");
  const slash = Math.max(template.lastIndexOf("/"), template.lastIndexOf("\\"));
  if (dot > slash + 1) {
    return `${template.slice(0, dot)}.${index}${template.slice(dot)}`;
  }
  return `${template}.${index}`;
}

async function writeAudio(bytes: Uint8Array, path: string): Promise<void> {
  await writeFile(path, bytes);
  console.log(`Wrote ${path} (${bytes.byteLength.toLocaleString()} bytes)`);
}

export function buildClient(apiKeyFlag: string | undefined): SoniloClient {
  const apiKey = apiKeyFlag ?? process.env.SONILO_API_KEY;
  if (!apiKey) {
    fail(
      "no API key — pass --api-key <key> or set the SONILO_API_KEY environment variable",
    );
  }
  // Identify as the CLI, not the SDK it wraps, so CLI traffic stays
  // separable from direct SDK use in server-side analytics.
  return new SoniloClient({ apiKey, clientName: "cli-js", clientVersion: VERSION });
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** One-line human summary of the free-trial allowance, e.g.
 * "Free trial: text-to-music 1/2 left, video-to-music 0/1 left".
 *
 * Returns undefined when there is nothing to report — the `trial` field is
 * present only for self-serve accounts, and printing an empty "Free trial:"
 * label would read as a bug. */
export function formatTrialSummary(
  trial: Record<string, TrialQuota> | undefined,
): string | undefined {
  if (!trial) return undefined;
  const parts = Object.entries(trial).map(
    // Service keys are task_types (text_to_music); show them the way the
    // endpoints and the error messages spell them (text-to-music).
    ([service, quota]) =>
      `${service.split("_").join("-")} ${quota.remaining}/${quota.granted} left`,
  );
  return parts.length > 0 ? `Free trial: ${parts.join(", ")}` : undefined;
}

export async function runAccount(client: SoniloClient): Promise<void> {
  const services = await client.account.services();
  printJson(services);
  // stdout stays pure JSON so `sonilo account | jq` keeps working; the
  // human-readable summary goes to stderr.
  const summary = formatTrialSummary(services.trial);
  if (summary !== undefined) console.error(summary);
}

export async function runUsage(client: SoniloClient, days: string | undefined): Promise<void> {
  printJson(await client.account.usage(days !== undefined ? { days: Number(days) } : {}));
}

export async function runTasksGet(client: SoniloClient, taskId: string | undefined): Promise<void> {
  if (!taskId) fail("usage: sonilo tasks get <task-id>");
  printJson(await client.tasks.get(taskId));
}

export async function runTasksWait(
  client: SoniloClient,
  taskId: string | undefined,
  opts: WaitOptions = {},
): Promise<void> {
  if (!taskId) fail("usage: sonilo tasks wait <task-id>");
  console.error(`Waiting for task ${taskId}...`);
  printJson(await client.tasks.wait(taskId, opts));
}

/** Write every entry of an async music result's `audio[]`. At the default
 * `--variants` of 1 (the overwhelming common case) `tracks` has exactly one
 * entry, and this writes it at the literal `mainOutput` path — exactly what
 * both callers did before variants existed. Above 1 it writes one file per
 * variant, indexed via `variantOutputPath`, so a multi-variant run never
 * silently discards all but the first result. */
async function writeMusicTracks(tracks: MusicMediaEntry[], mainOutput: string): Promise<void> {
  if (tracks.length <= 1) {
    const track = tracks[0];
    if (!track) fail("task succeeded but returned no audio");
    await writeAudio(await download(track), mainOutput);
    return;
  }
  for (const [index, track] of tracks.entries()) {
    await writeAudio(await download(track), variantOutputPath(mainOutput, index));
  }
}

export async function runTextToMusic(client: SoniloClient, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      prompt: { type: "string" },
      duration: { type: "string" },
      output: { type: "string" },
      format: { type: "string" },
      async: { type: "boolean" },
      segments: { type: "string" },
      variants: { type: "string" },
    },
  });
  const prompt = requireFlag(values.prompt, "prompt");
  const duration = Number(requireFlag(values.duration, "duration"));
  const format = parseFormat(values.format, ["m4a", "wav", "mp3"] as const, "m4a");
  const variantsNum = values.variants !== undefined ? Number(values.variants) : undefined;
  // variantsNum > 1 requires the async task API, as does any non-m4a
  // container -- wav and mp3 are both finalize-time transcodes, and m4a is
  // the only format the stream itself carries.
  const useAsync =
    values.async === true || format !== "m4a" || (variantsNum ?? 1) > 1;
  const segments = (await readSegments("text-to-music", values.segments, MUSIC_SEGMENTS)) as
    | Segment[]
    | undefined;

  if (!useAsync) {
    const track = await client.textToMusic.generate({ prompt, duration, segments });
    await writeAudio(track.audio, outputPath(values.output, format));
    return;
  }
  const task = await client.textToMusic.submit({
    prompt,
    duration,
    mode: "async",
    outputFormat: format,
    segments,
    variantsNum,
  });
  console.error(`Submitted task ${task.task_id}, waiting...`);
  const result = await client.tasks.wait<MusicTaskResult>(task.task_id);
  await writeMusicTracks(result.audio ?? [], outputPath(values.output, format));
}

export async function runVideoToMusic(client: SoniloClient, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      video: { type: "string" },
      "video-url": { type: "string" },
      prompt: { type: "string" },
      output: { type: "string" },
      format: { type: "string" },
      "isolate-vocals": { type: "boolean" },
      "preserve-speech": { type: "boolean" },
      async: { type: "boolean" },
      segments: { type: "string" },
      variants: { type: "string" },
      "prompt-influence": { type: "string" },
    },
  });
  if ((values.video === undefined) === (values["video-url"] === undefined)) {
    fail("pass exactly one of --video or --video-url");
  }
  const format = parseFormat(values.format, ["m4a", "wav", "mp3"] as const, "m4a");
  // --isolate-vocals and --preserve-speech are ONE feature under two names, not
  // two independent options: the backend ORs them and normalizes onto a single
  // flag (preserve_speech is the current public name, isolate_vocals the legacy
  // field still sent by existing callers). Either one forces async, and either
  // one makes the task carry `vocals`/`mux` entries — but the CLI has no
  // --stem to fetch those (unlike --variants, which writes every `audio[]`
  // entry, `vocals`/`mux` stay undownloaded here), so the help must not
  // advertise a stem it cannot hand back. See the help text above.
  const isolateVocals = values["isolate-vocals"] === true;
  const preserveSpeech = values["preserve-speech"] === true;
  const variantsNum = values.variants !== undefined ? Number(values.variants) : undefined;
  // Explicit undefined check, not truthiness: --prompt-influence 0 is a
  // meaningful value (video leads entirely) and must still be sent. Works on
  // both the stream and async paths — it never forces --async.
  const promptInfluence =
    values["prompt-influence"] !== undefined ? Number(values["prompt-influence"]) : undefined;
  // variantsNum > 1 requires the async task API, same as the other async-only options.
  const useAsync =
    values.async === true ||
    format !== "m4a" ||
    isolateVocals ||
    preserveSpeech ||
    (variantsNum ?? 1) > 1;
  const segments = (await readSegments("video-to-music", values.segments, MUSIC_SEGMENTS)) as
    | Segment[]
    | undefined;

  if (!useAsync) {
    const track = await client.videoToMusic.generate({
      video: values.video,
      videoUrl: values["video-url"],
      prompt: values.prompt,
      segments,
      promptInfluence,
    });
    await writeAudio(track.audio, outputPath(values.output, format));
    return;
  }
  const task = await client.videoToMusic.submit({
    video: values.video,
    videoUrl: values["video-url"],
    prompt: values.prompt,
    mode: "async",
    outputFormat: format,
    isolateVocals,
    preserveSpeech,
    segments,
    variantsNum,
    promptInfluence,
  });
  console.error(`Submitted task ${task.task_id}, waiting...`);
  const result = await client.tasks.wait<MusicTaskResult>(task.task_id);
  await writeMusicTracks(result.audio ?? [], outputPath(values.output, format));
}

export async function runTextToSfx(client: SoniloClient, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      prompt: { type: "string" },
      duration: { type: "string" },
      output: { type: "string" },
      format: { type: "string" },
    },
  });
  const prompt = requireFlag(values.prompt, "prompt");
  const duration = Number(requireFlag(values.duration, "duration"));
  const format = parseFormat(values.format, ["wav", "mp3", "aac", "flac"] as const, "wav");
  const result = await client.textToSfx.generate({
    prompt,
    duration,
    audioFormat: format,
  });
  const media = result.audio;
  if (!media) fail("task succeeded but returned no audio");
  await writeAudio(await download(media), outputPath(values.output, format));
}

export async function runVideoToSfx(client: SoniloClient, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      video: { type: "string" },
      "video-url": { type: "string" },
      prompt: { type: "string" },
      output: { type: "string" },
      format: { type: "string" },
      segments: { type: "string" },
    },
  });
  if ((values.video === undefined) === (values["video-url"] === undefined)) {
    fail("pass exactly one of --video or --video-url");
  }
  const format = parseFormat(values.format, ["wav", "mp3", "aac", "flac"] as const, "wav");
  const segments = (await readSegments("video-to-sfx", values.segments, SFX_SEGMENTS)) as
    | SfxSegment[]
    | undefined;
  const task = await client.videoToSfx.submit({
    video: values.video,
    videoUrl: values["video-url"],
    prompt: values.prompt,
    audioFormat: format,
    segments,
  });
  console.error(`Submitted task ${task.task_id}, waiting...`);
  const result = await client.tasks.wait<SfxResult>(task.task_id);
  const media = result.audio;
  if (!media) fail("task succeeded but returned no audio");
  await writeAudio(await download(media), outputPath(values.output, format));
}

/** Resolve --ducking / --no-ducking into the value to send, or `undefined` to
 * let the server default stand.
 *
 * `ducking` used to be default-ON server-side, so the only thing worth
 * expressing was turning it off and --no-ducking was the only flag. It is now
 * default-OFF, which makes --ducking the useful direction. --no-ducking is
 * kept because removing it would turn every existing script that passes it
 * into a hard "unknown option" failure; it now sends an explicit `false`,
 * which is what the server would have done anyway.
 *
 * Passing both is a contradiction with no sensible winner, so it fails rather
 * than silently picking one. */
function resolveDucking(on?: boolean, off?: boolean): boolean | undefined {
  if (on === true && off === true) {
    fail("pass at most one of --ducking or --no-ducking");
  }
  if (on === true) return true;
  if (off === true) return false;
  return undefined;
}

/** Shared flag parsing for the two combined music + SFX endpoints.
 *
 * Each server default is only overridden when the user says so: both `ducking`
 * and `keepOriginalSound` are default-OFF, so each is sent only for its own
 * opt-in flag. See `resolveDucking` for why --no-ducking still parses.
 *
 * Returns the **video** endpoint's param type, because that is the one
 * carrying `keepOriginalSound`. `runVideoToSound` destructures that field back
 * out and rejects it, which is what keeps the audio endpoint from sending a
 * field it does not accept. `command` names the caller in `--segments` failure
 * messages ("video-to-sound" vs "video-to-video-sound"). */
async function parseSoundArgs(
  command: string,
  argv: string[],
): Promise<{
  params: VideoToVideoSoundParams;
  output: string | undefined;
  stems: SoundStem[];
}> {
  const { values } = parseArgs({
    args: argv,
    options: {
      video: { type: "string" },
      "video-url": { type: "string" },
      "music-prompt": { type: "string" },
      "sfx-prompt": { type: "string" },
      "keep-original-sound": { type: "boolean" },
      "preserve-speech": { type: "boolean" },
      ducking: { type: "boolean" },
      "no-ducking": { type: "boolean" },
      output: { type: "string" },
      segments: { type: "string" },
      stem: { type: "string", multiple: true },
      variants: { type: "string" },
    },
  });
  if ((values.video === undefined) === (values["video-url"] === undefined)) {
    fail("pass exactly one of --video or --video-url");
  }
  const segments = (await readSegments(command, values.segments, SFX_SEGMENTS)) as
    | SfxSegment[]
    | undefined;
  return {
    params: {
      video: values.video,
      videoUrl: values["video-url"],
      musicPrompt: values["music-prompt"],
      sfxPrompt: values["sfx-prompt"],
      keepOriginalSound: values["keep-original-sound"] === true ? true : undefined,
      preserveSpeech: values["preserve-speech"] === true ? true : undefined,
      ducking: resolveDucking(values.ducking, values["no-ducking"]),
      segments,
      variantsNum: values.variants !== undefined ? Number(values.variants) : undefined,
    },
    output: values.output,
    stems: parseStems(values.stem),
  };
}

/** Write each `--stem` file requested for one variant of a combined sound
 * result, in addition to (never instead of) the combined output already
 * written to `mainOutput`. `media` is either the top-level `SoundResult`
 * (single-variant path) or one `SoundOutputEntry` (multi-variant path) — both
 * carry the same `music`/`music_processed`/`sfx` field names, so one function
 * serves both. A stem the entry does not carry — most commonly
 * `music_processed`, which only exists when `preserveSpeech` or `ducking`
 * actually altered the music bed — fails loudly through the same `fail()`
 * path as every other CLI error, rather than being skipped or writing an
 * empty file. */
async function writeStems(
  command: string,
  media: { music?: SfxMedia; music_processed?: SfxMedia; sfx?: SfxMedia },
  status: string,
  stems: SoundStem[],
  mainOutput: string,
): Promise<void> {
  for (const stem of stems) {
    const m = media[stem];
    if (!m) {
      const reason =
        stem === "music_processed"
          ? " — it only exists when a voice source was kept, i.e. with --keep-original-sound or --preserve-speech"
          : "";
      fail(`${command}: no "${stem}" stem on this result (status: ${status})${reason}`);
    }
    await writeAudio(await download(m), stemOutputPath(mainOutput, stem, m.url));
  }
}

/** Write a `videoToSound` / `videoToVideoSound` result: the combined output
 * plus any requested `--stem` files, for every variant.
 *
 * At the default `--variants` of 1 (the overwhelming common case) `outputs`
 * has at most one entry, and this writes exactly what both callers did
 * before variants existed — a single main file at `output`, unsuffixed, using
 * `urlFallback` to locate it (video-to-sound falls back to the sfx/music
 * stem URL if `output_url` is somehow missing; video-to-video-sound does
 * not, since a video result has no meaningful audio-only fallback). Above 1
 * it writes one set of files per variant, indexed via `variantOutputPath`, so
 * a multi-variant run never silently discards all but the first result. */
async function writeSoundResult(
  command: string,
  result: SoundResult,
  output: string | undefined,
  stems: SoundStem[],
  fallbackExt: string,
  urlFallback: (result: SoundResult) => string | undefined,
  emptyMessage: string,
): Promise<void> {
  const outputs = result.outputs;
  if (!outputs || outputs.length <= 1) {
    const url = outputs?.[0]?.output_url ?? urlFallback(result);
    if (!url) fail(emptyMessage);
    const mainOutput = outputPath(output, extFromUrl(url, fallbackExt));
    await writeAudio(await download(url), mainOutput);
    await writeStems(command, outputs?.[0] ?? result, result.status, stems, mainOutput);
    return;
  }
  const template = outputPath(output, extFromUrl(outputs[0]!.output_url, fallbackExt));
  for (const [index, entry] of outputs.entries()) {
    const variantOutput = variantOutputPath(template, index);
    await writeAudio(await download(entry.output_url), variantOutput);
    await writeStems(command, entry, result.status, stems, variantOutput);
  }
}

export async function runVideoToSound(client: SoniloClient, argv: string[]): Promise<void> {
  const { params, output, stems } = await parseSoundArgs("video-to-sound", argv);
  // keepOriginalSound is video-only: the audio endpoint's params type bans it
  // outright, so split it back off and reject it here rather than letting it
  // reach the wire as a field the server would silently drop.
  const { keepOriginalSound, ...audioParams } = params;
  if (keepOriginalSound !== undefined) {
    fail("--keep-original-sound is only supported by video-to-video-sound");
  }
  const task = await client.videoToSound.submit(audioParams);
  console.error(`Submitted task ${task.task_id}, waiting...`);
  const result = await client.tasks.wait<SoundResult>(task.task_id);
  await writeSoundResult(
    "video-to-sound",
    result,
    output,
    stems,
    "wav",
    (r) => r.output_url ?? r.sfx?.url ?? r.music?.url,
    "task succeeded but returned no output",
  );
}

export async function runVideoToVideoSound(client: SoniloClient, argv: string[]): Promise<void> {
  const { params, output, stems } = await parseSoundArgs("video-to-video-sound", argv);
  const task = await client.videoToVideoSound.submit(params);
  console.error(`Submitted task ${task.task_id}, waiting...`);
  const result = await client.tasks.wait<SoundResult>(task.task_id);
  await writeSoundResult(
    "video-to-video-sound",
    result,
    output,
    stems,
    "mp4",
    (r) => r.output_url,
    "task succeeded but returned no output video",
  );
}

/** Shared tail of `video-to-video-music` / `video-to-video-sfx`: announce the
 * submitted task, poll it, and write the muxed video(s).
 *
 * These two endpoints do NOT use the flat `output_url` envelope that
 * `video-to-video-sound` returns — their result carries the re-hosted video(s)
 * in `videos[]`, with `video` a permanent alias for `videos[0]`. Only
 * `video-to-video-music` takes `--variants`; `video-to-video-sfx` has no
 * variants knob, so its `videos[]` is always a single entry and this falls
 * through to the same one-file write it always did. Above one variant, one
 * file is written per entry, indexed via `variantOutputPath`. The extension
 * comes from each entry's own URL, defaulting to mp4. */
async function waitAndWriteVideo(
  client: SoniloClient,
  task: SfxTask,
  output: string | undefined,
): Promise<void> {
  console.error(`Submitted task ${task.task_id}, waiting...`);
  const result = await client.tasks.wait<VideoResult>(task.task_id);
  const videos = result.videos && result.videos.length > 0
    ? result.videos
    : result.video
      ? [result.video]
      : [];
  const first = videos[0];
  if (!first?.url) fail("task succeeded but returned no output video");
  const mainOutput = outputPath(output, extFromUrl(first.url, "mp4"));
  if (videos.length <= 1) {
    await writeAudio(await download(first.url), mainOutput);
    return;
  }
  for (const [index, video] of videos.entries()) {
    await writeAudio(await download(video.url), variantOutputPath(mainOutput, index));
  }
}

export async function runVideoToVideoMusic(client: SoniloClient, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      video: { type: "string" },
      "video-url": { type: "string" },
      prompt: { type: "string" },
      "keep-original-sound": { type: "boolean" },
      "preserve-speech": { type: "boolean" },
      "isolate-vocals": { type: "boolean" },
      ducking: { type: "boolean" },
      "no-ducking": { type: "boolean" },
      output: { type: "string" },
      variants: { type: "string" },
      "prompt-influence": { type: "string" },
    },
  });
  if ((values.video === undefined) === (values["video-url"] === undefined)) {
    fail("pass exactly one of --video or --video-url");
  }
  // Every flag is sent only when set, so each server default stands on its
  // own: preserve_speech is OR'd with the legacy isolate_vocals (an explicit
  // `false` would be noise), and keep_original_sound and ducking are both
  // default-OFF, so each rides its own opt-in flag.
  const task = await client.videoToVideoMusic.submit({
    video: values.video,
    videoUrl: values["video-url"],
    prompt: values.prompt,
    keepOriginalSound: values["keep-original-sound"] === true ? true : undefined,
    preserveSpeech: values["preserve-speech"] === true ? true : undefined,
    isolateVocals: values["isolate-vocals"] === true ? true : undefined,
    ducking: resolveDucking(values.ducking, values["no-ducking"]),
    variantsNum: values.variants !== undefined ? Number(values.variants) : undefined,
    // Explicit undefined check, not truthiness: --prompt-influence 0 is a
    // meaningful value (video leads entirely) and must still be sent.
    promptInfluence:
      values["prompt-influence"] !== undefined ? Number(values["prompt-influence"]) : undefined,
  });
  await waitAndWriteVideo(client, task, values.output);
}

export async function runVideoToVideoSfx(client: SoniloClient, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      video: { type: "string" },
      "video-url": { type: "string" },
      prompt: { type: "string" },
      output: { type: "string" },
      segments: { type: "string" },
    },
  });
  if ((values.video === undefined) === (values["video-url"] === undefined)) {
    fail("pass exactly one of --video or --video-url");
  }
  const segments = (await readSegments("video-to-video-sfx", values.segments, SFX_SEGMENTS)) as
    | SfxSegment[]
    | undefined;
  const task = await client.videoToVideoSfx.submit({
    video: values.video,
    videoUrl: values["video-url"],
    prompt: values.prompt,
    segments,
  });
  await waitAndWriteVideo(client, task, values.output);
}

/** Turn one `--output` value into a per-language path: `clip.mp4` + `es`
 * becomes `clip.es.mp4`. A dubbing task returns one video per language, so a
 * single literal destination cannot express the result; this mirrors the
 * Python CLI's `--stem` naming so both tools read the same way. The extension
 * search stops at the last path separator so a dot in a directory name (e.g.
 * `v1.2/clip`) is never mistaken for a file extension. */
export function languageOutputPath(template: string, language: string): string {
  const dot = template.lastIndexOf(".");
  const slash = Math.max(template.lastIndexOf("/"), template.lastIndexOf("\\"));
  if (dot > slash + 1) {
    return `${template.slice(0, dot)}.${language}${template.slice(dot)}`;
  }
  return `${template}.${language}.mp4`;
}

/** Default wait timeout for `sonilo dubbing`, in milliseconds.
 *
 * The dubbing backend polls its own pipeline for up to 7200000 ms (2 hours)
 * before giving up server-side. The SDK's generic default
 * (`DEFAULT_WAIT_TIMEOUT_MS`, 10 minutes) is far too short for this endpoint:
 * a 180-second video dubbed into several languages routinely takes longer
 * than 10 minutes, so using the generic default would make the CLI throw
 * `TaskTimeoutError` and exit non-zero on runs that are still succeeding
 * server-side. Matching the backend's own 2-hour ceiling means the CLI gives
 * up only once the backend has; `--timeout` overrides it. */
export const DUBBING_WAIT_TIMEOUT_MS = 7_200_000;

export function parseDubbingArgs(argv: string[]): {
  params: DubbingParams;
  output: string | undefined;
  timeout: number | undefined;
} {
  const { values } = parseArgs({
    args: argv,
    options: {
      video: { type: "string" },
      "video-url": { type: "string" },
      languages: { type: "string" },
      ducking: { type: "boolean" },
      output: { type: "string" },
      timeout: { type: "string" },
    },
  });
  if ((values.video === undefined) === (values["video-url"] === undefined)) {
    fail("pass exactly one of --video or --video-url");
  }
  let languages: string[] | undefined;
  if (values.languages !== undefined) {
    languages = values.languages
      .split(",")
      .map((code) => code.trim())
      .filter((code) => code.length > 0);
    if (languages.length === 0) {
      fail("--languages needs at least one language code, e.g. --languages es,fr");
    }
  }
  return {
    params: {
      video: values.video,
      videoUrl: values["video-url"],
      languages,
      // Default-OFF server-side (unlike v2m's --no-ducking): only sent when
      // the user explicitly opts in with --ducking.
      ducking: values.ducking === true ? true : undefined,
    },
    output: values.output,
    timeout: values.timeout !== undefined ? Number(values.timeout) : undefined,
  };
}

export async function runDubbing(client: SoniloClient, argv: string[]): Promise<void> {
  const { params, output, timeout } = parseDubbingArgs(argv);
  const task = await client.dubbing.submit(params);
  console.error(`Submitted task ${task.task_id}, waiting...`);
  const result = await client.tasks.wait<DubbingResult>(task.task_id, {
    timeout: timeout ?? DUBBING_WAIT_TIMEOUT_MS,
  });
  const outputs = result.outputs ?? {};
  const languages = Object.keys(outputs).sort();
  if (languages.length === 0) fail("task succeeded but returned no dubbed videos");
  const template = outputPath(output, "mp4");
  for (const language of languages) {
    const url = outputs[language]!;
    await writeAudio(await download(url), languageOutputPath(template, language));
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version")) {
    console.log(VERSION);
    return;
  }
  if (argv.length === 0 || argv.includes("--help") || argv[0] === "help") {
    console.log(HELP);
    return;
  }

  // --api-key is accepted anywhere in the argument list, not just after the
  // command, since users naturally reach for it last. Strip it (and its value)
  // before reading the command so it never gets mistaken for one.
  const { apiKeyFlag, rest } = extractApiKey(argv);
  const [command, ...commandArgs] = rest;
  const KNOWN_COMMANDS = new Set([
    "login",
    "logout",
    "whoami",
    "account",
    "usage",
    "text-to-music",
    "video-to-music",
    "text-to-sfx",
    "video-to-sfx",
    "video-to-sound",
    "video-to-video-sound",
    "video-to-video-music",
    "video-to-video-sfx",
    "dubbing",
    "tasks",
  ]);
  if (!KNOWN_COMMANDS.has(command ?? "")) {
    fail(`unknown command: ${command}. Run "sonilo --help" for usage.`);
  }

  // "login", "logout", and "whoami" must all be dispatched before
  // buildClient(): buildClient exits when no API key is configured, which is
  // exactly the situation login exists to fix (there is no key yet, or the
  // one on disk expired), exactly the situation logout produces on purpose,
  // and exactly the situation whoami exists to report on.
  if (command === "login") {
    return runLogin(commandArgs, defaultLoginDeps());
  }
  if (command === "logout") {
    return runLogout(commandArgs, defaultLoginDeps());
  }
  if (command === "whoami") {
    return runWhoami(commandArgs, process.env, (line) => console.log(line));
  }

  const client = buildClient(apiKeyFlag);

  switch (command) {
    case "account":
      return runAccount(client);
    case "usage": {
      const { values } = parseArgs({ args: commandArgs, options: { days: { type: "string" } } });
      return runUsage(client, values.days);
    }
    case "text-to-music":
      return runTextToMusic(client, commandArgs);
    case "video-to-music":
      return runVideoToMusic(client, commandArgs);
    case "text-to-sfx":
      return runTextToSfx(client, commandArgs);
    case "video-to-sfx":
      return runVideoToSfx(client, commandArgs);
    case "video-to-sound":
      return runVideoToSound(client, commandArgs);
    case "video-to-video-sound":
      return runVideoToVideoSound(client, commandArgs);
    case "video-to-video-music":
      return runVideoToVideoMusic(client, commandArgs);
    case "video-to-video-sfx":
      return runVideoToVideoSfx(client, commandArgs);
    case "dubbing":
      return runDubbing(client, commandArgs);
    case "tasks": {
      const [subcommand, taskId, ...taskArgs] = commandArgs;
      if (subcommand === "get") return runTasksGet(client, taskId);
      if (subcommand === "wait") {
        const { values } = parseArgs({
          args: taskArgs,
          options: {
            "poll-interval": { type: "string" },
            timeout: { type: "string" },
          },
        });
        return runTasksWait(client, taskId, {
          pollInterval:
            values["poll-interval"] !== undefined ? Number(values["poll-interval"]) : undefined,
          timeout: values.timeout !== undefined ? Number(values.timeout) : undefined,
        });
      }
      fail(`unknown "tasks" subcommand: ${subcommand ?? "(none)"}. Use "get" or "wait".`);
    }
  }
}

/** True when this module is the process entrypoint, resolving symlinks on both
 * sides so an npm-installed bin (always a symlink) is recognised. */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return false;
  }
}

// Only run when invoked directly (as the built bin), not when tests import
// these functions to exercise them against a mocked SoniloClient.
//
// realpath both sides before comparing: npm installs a bin as a SYMLINK
// (node_modules/.bin/sonilo -> ../sonilo-cli/dist/cli.js), so argv[1] is the
// link while import.meta.url is already resolved. Comparing them raw never
// matched under a real install, and every command silently exited 0.
// pathToFileURL, not `file://` + path, so paths with spaces still compare.
if (isMainModule()) {
  main().catch((err: unknown) => {
    if (err instanceof APIError) {
      fail(`${err.message}${err.code ? ` (${err.code})` : ""}`);
    }
    if (err instanceof SoniloError) {
      fail(err.message);
    }
    throw err;
  });
}
