import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  APIError,
  SoniloClient,
  SoniloError,
  VERSION,
  download,
  type MusicTaskResult,
  type SfxResult,
  type SoundResult,
  type VideoToSoundParams,
  type WaitOptions,
} from "sonilo";

const HELP = `sonilo — command-line interface for the Sonilo API

Usage:
  sonilo <command> [options]

Commands:
  account                       Show plan limits and available services
  usage [--days <n>]            Show usage summary (default: last 30 days)
  text-to-music                 Generate music from a text prompt
  video-to-music                Generate music matched to a video
  text-to-sfx                   Generate a sound effect from a text prompt
  video-to-sfx                  Generate a sound effect matched to a video
  video-to-sound                Generate a combined music + SFX track for a video
  video-to-video-sound          Same as video-to-sound, muxed back into the video
  tasks get <task-id>           Fetch the current state of an async task
  tasks wait <task-id>          Poll an async task until it finishes
                                (--poll-interval <ms>, --timeout <ms>)

text-to-music options:
  --prompt <text>       Required. What the music should sound like.
  --duration <seconds>  Required. Track length.
  --output <path>       Where to save the audio (default: ./output.<ext>)
  --format <m4a|wav>    Output container. wav forces --async. Default: m4a
  --async               Submit and poll instead of streaming the response

video-to-music options:
  --video <path>              Required (or --video-url). Local file to score.
  --video-url <url>           Required (or --video). Remote video to score.
  --prompt <text>              Optional creative direction for the music.
  --output <path>              Where to save the audio (default: ./output.<ext>)
  --format <m4a|wav>           Output container. wav forces --async.
  --isolate-vocals              Split out a vocals-only stem. Forces --async.
  --preserve-speech             Keep source speech in the mix. Forces --async.
  --async                       Submit and poll instead of streaming

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

video-to-sound / video-to-video-sound options (both async-only):
  --video <path>         Required (or --video-url). Local file to score.
  --video-url <url>      Required (or --video). Remote video to score.
  --music-prompt <text>   Optional style hint for the music bed.
  --sfx-prompt <text>     Optional description of the sound effects.
  --preserve-speech       Keep the source speech in the result.
  --no-ducking            Disable ducking (music is ducked under speech by default).
  --output <path>         Where to save the result (default: ./output.<ext>)

Global options:
  --api-key <key>   Overrides the SONILO_API_KEY environment variable.
  --help             Show this help and exit.
  --version          Print the CLI version and exit.

Environment:
  SONILO_API_KEY     Your API key (starts with sk-). Required unless --api-key
                     is passed.

Examples:
  sonilo account
  sonilo text-to-music --prompt "warm lo-fi piano, rain in the background" --duration 30
  sonilo video-to-music --video clip.mp4 --prompt "tense, driving synths" --output score.wav --format wav
  sonilo text-to-sfx --prompt "glass bottle shattering on concrete" --duration 3
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
  return new SoniloClient({ apiKey });
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function runAccount(client: SoniloClient): Promise<void> {
  printJson(await client.account.services());
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

export async function runTextToMusic(client: SoniloClient, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      prompt: { type: "string" },
      duration: { type: "string" },
      output: { type: "string" },
      format: { type: "string" },
      async: { type: "boolean" },
    },
  });
  const prompt = requireFlag(values.prompt, "prompt");
  const duration = Number(requireFlag(values.duration, "duration"));
  const format = parseFormat(values.format, ["m4a", "wav"] as const, "m4a");
  const useAsync = values.async === true || format === "wav";

  if (!useAsync) {
    const track = await client.textToMusic.generate({ prompt, duration });
    await writeAudio(track.audio, outputPath(values.output, format));
    return;
  }
  const task = await client.textToMusic.submit({
    prompt,
    duration,
    mode: "async",
    outputFormat: format,
  });
  console.error(`Submitted task ${task.task_id}, waiting...`);
  const result = await client.tasks.wait<MusicTaskResult>(task.task_id);
  const track = result.audio?.[0];
  if (!track) fail("task succeeded but returned no audio");
  await writeAudio(await download(track), outputPath(values.output, format));
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
    },
  });
  if ((values.video === undefined) === (values["video-url"] === undefined)) {
    fail("pass exactly one of --video or --video-url");
  }
  const format = parseFormat(values.format, ["m4a", "wav"] as const, "m4a");
  const isolateVocals = values["isolate-vocals"] === true;
  const preserveSpeech = values["preserve-speech"] === true;
  const useAsync =
    values.async === true || format === "wav" || isolateVocals || preserveSpeech;

  if (!useAsync) {
    const track = await client.videoToMusic.generate({
      video: values.video,
      videoUrl: values["video-url"],
      prompt: values.prompt,
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
  });
  console.error(`Submitted task ${task.task_id}, waiting...`);
  const result = await client.tasks.wait<MusicTaskResult>(task.task_id);
  const track = result.audio?.[0];
  if (!track) fail("task succeeded but returned no audio");
  await writeAudio(await download(track), outputPath(values.output, format));
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
    },
  });
  if ((values.video === undefined) === (values["video-url"] === undefined)) {
    fail("pass exactly one of --video or --video-url");
  }
  const format = parseFormat(values.format, ["wav", "mp3", "aac", "flac"] as const, "wav");
  const task = await client.videoToSfx.submit({
    video: values.video,
    videoUrl: values["video-url"],
    prompt: values.prompt,
    audioFormat: format,
  });
  console.error(`Submitted task ${task.task_id}, waiting...`);
  const result = await client.tasks.wait<SfxResult>(task.task_id);
  const media = result.audio;
  if (!media) fail("task succeeded but returned no audio");
  await writeAudio(await download(media), outputPath(values.output, format));
}

/** Shared flag parsing for the two combined music + SFX endpoints, which take
 * identical form fields. `ducking` is default-ON server-side, so it is only
 * sent when the user explicitly opts out with --no-ducking. */
function parseSoundArgs(argv: string[]): {
  params: VideoToSoundParams;
  output: string | undefined;
} {
  const { values } = parseArgs({
    args: argv,
    options: {
      video: { type: "string" },
      "video-url": { type: "string" },
      "music-prompt": { type: "string" },
      "sfx-prompt": { type: "string" },
      "preserve-speech": { type: "boolean" },
      "no-ducking": { type: "boolean" },
      output: { type: "string" },
    },
  });
  if ((values.video === undefined) === (values["video-url"] === undefined)) {
    fail("pass exactly one of --video or --video-url");
  }
  return {
    params: {
      video: values.video,
      videoUrl: values["video-url"],
      musicPrompt: values["music-prompt"],
      sfxPrompt: values["sfx-prompt"],
      preserveSpeech: values["preserve-speech"] === true ? true : undefined,
      ducking: values["no-ducking"] === true ? false : undefined,
    },
    output: values.output,
  };
}

export async function runVideoToSound(client: SoniloClient, argv: string[]): Promise<void> {
  const { params, output } = parseSoundArgs(argv);
  const task = await client.videoToSound.submit(params);
  console.error(`Submitted task ${task.task_id}, waiting...`);
  const result = await client.tasks.wait<SoundResult>(task.task_id);
  const url = result.output_url ?? result.sfx?.url ?? result.music?.url;
  if (!url) fail("task succeeded but returned no output");
  await writeAudio(await download(url), outputPath(output, extFromUrl(url, "wav")));
}

export async function runVideoToVideoSound(client: SoniloClient, argv: string[]): Promise<void> {
  const { params, output } = parseSoundArgs(argv);
  const task = await client.videoToVideoSound.submit(params);
  console.error(`Submitted task ${task.task_id}, waiting...`);
  const result = await client.tasks.wait<SoundResult>(task.task_id);
  const url = result.output_url;
  if (!url) fail("task succeeded but returned no output video");
  await writeAudio(await download(url), outputPath(output, extFromUrl(url, "mp4")));
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
    "account",
    "usage",
    "text-to-music",
    "video-to-music",
    "text-to-sfx",
    "video-to-sfx",
    "video-to-sound",
    "video-to-video-sound",
    "tasks",
  ]);
  if (!KNOWN_COMMANDS.has(command ?? "")) {
    fail(`unknown command: ${command}. Run "sonilo --help" for usage.`);
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

// Only run when invoked directly (as the built bin), not when tests import
// these functions to exercise them against a mocked SoniloClient.
if (import.meta.url === `file://${process.argv[1]}`) {
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
