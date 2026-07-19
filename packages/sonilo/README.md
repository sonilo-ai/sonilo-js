# sonilo

Official TypeScript/JavaScript client for the [Sonilo](https://sonilo.com) API.
Works in Node.js ≥ 18 and modern browsers. Zero runtime dependencies.

## Installation

```bash
npm install sonilo
```

## Authentication

Create an API key in your [Sonilo dashboard](https://platform.sonilo.com/dashboard/api-keys),
then give it to the client either as an environment variable (recommended) or
inline:

```bash
export SONILO_API_KEY=sk_...
```

```ts
const sonilo = new SoniloClient();                     // reads SONILO_API_KEY
// or pass it directly:
const sonilo = new SoniloClient({ apiKey: "sk_..." });
```

Keep your key secret — use it only server-side, never commit it, and prefer the
environment variable over hardcoding it.

## Quickstart

```ts
import { SoniloClient } from "sonilo";

const sonilo = new SoniloClient(); // reads SONILO_API_KEY

const track = await sonilo.textToMusic.generate({
  prompt: "cinematic orchestral score",
  duration: 60,
});
// track.audio is a Uint8Array of MP3 bytes
```

## Video to music

```ts
// Node: file path, browser: File/Blob from an <input type="file">
const track = await sonilo.videoToMusic.generate({
  video: "./my_video.mp4",
  prompt: "upbeat, energetic",
});

// Or point at a hosted video
await sonilo.videoToMusic.generate({ videoUrl: "https://example.com/clip.mp4" });
```

### Preserve speech (async)

Set `preserveSpeech: true` to keep the source speech/vocals in the result.
This requires the async task API — the plain stream above doesn't support it —
so it implies `mode: "async"` if you don't set `mode` yourself. Submit, then
poll with `client.tasks.wait<MusicTaskResult>()`. The result carries the
generated `audio` plus a separate speech stem (`vocals`) and a `mux` (the
generated music mixed with the preserved speech):

```ts
import { SoniloClient, download } from "sonilo";
import type { MusicTaskResult } from "sonilo";
import { writeFile } from "node:fs/promises";

const client = new SoniloClient();
const task = await client.videoToMusic.submit({
  video: "./my_video.mp4",
  prompt: "upbeat, energetic",
  preserveSpeech: true,
});
const result = await client.tasks.wait<MusicTaskResult>(task.task_id);

// `audio` is always an array for async video-to-music (one entry per output
// stream); `vocals` and `mux` are only present when preserveSpeech is set.
await writeFile("mix.m4a", await download(result.audio[0]!));
await writeFile("vocals.m4a", await download(result.vocals!));
```

### Ducking, speech & output format (async video-to-music)

The async `submit()` path also accepts:

- `preserveSpeech` — keep the source speech/vocals in the result (see
  [Preserve speech](#preserve-speech-async) above).
- `ducking` — duck the generated music under the source voice. It is **on by
  default** in async mode; pass `ducking: false` to opt out. When it runs, the
  result gains a `ducked` array alongside `audio`.
- `outputFormat` — `"m4a"` (default) or `"wav"` (requires async mode).

```ts
const task = await client.videoToMusic.submit({
  video: "./my_video.mp4",
  preserveSpeech: true,
  outputFormat: "wav",
  // ducking is on by default in async — set `false` to disable
});
const result = await client.tasks.wait<MusicTaskResult>(task.task_id);
if (result.ducked) {
  await writeFile("ducked.wav", await download(result.ducked[0]!));
}
```

## Video to video

Generate a soundtrack or sound effects and get back a **re-hosted video** with
the audio muxed in — not just an audio file. Both endpoints are async; poll to
a `VideoResult`:

```ts
import { SoniloClient, download } from "sonilo";
import { writeFile } from "node:fs/promises";

const client = new SoniloClient();

// Score music into the video (optionally keep the original speech)
const music = await client.videoToVideoMusic.generate({
  video: "./my_video.mp4", // Node path; File/Blob in the browser, or `videoUrl`
  prompt: "cinematic orchestral swell",
  preserveSpeech: true,
});
await writeFile("scored.mp4", await download(music.video!));

// Sound effects for the video, optionally per time segment
const sfx = await client.videoToVideoSfx.generate({
  video: "./my_video.mp4",
  segments: [{ start: 0, end: 2, prompt: "footsteps on gravel" }],
});
await writeFile("with_sfx.mp4", await download(sfx.video!));
```

## Configuration

```ts
const client = new SoniloClient({
  apiKey: "sk_...", // defaults to SONILO_API_KEY
  baseUrl: "https://api.sonilo.com",
  timeout: 600_000, // milliseconds, default 600000 (10 minutes)
});
```

`timeout` bounds one-shot requests (account, tasks, SFX submits) and
`download()` — it protects against a stalled connection hanging forever.
It does **not** bound streaming music generation
(`textToMusic`/`videoToMusic` `.stream()`/`.generate()`): those hold the
response body open for as long as generation takes, so an absolute timeout
would kill a healthy long-running stream. Pass your own `signal` in
`TextToMusicParams`/`VideoToMusicParams` (e.g. from an `AbortController`,
or `AbortSignal.timeout(ms)` for an absolute cap) to bound or cancel a
music stream instead — it's forwarded to `fetch` as-is and never
rewrapped as `RequestTimeoutError`.

## Streaming

```ts
import { SoniloClient, isAudioChunkEvent } from "sonilo";

for await (const event of sonilo.textToMusic.stream({ prompt: "lofi", duration: 30 })) {
  if (isAudioChunkEvent(event)) {
    // event.data is a Uint8Array — feed it to your player as it arrives
  }
}
```

## Segments

Shape the composition with start-only contiguous segments (each ends where
the next begins):

```ts
await sonilo.textToMusic.generate({
  prompt: "epic trailer",
  duration: 60,
  segments: [
    { start: 0, prompt: "soft intro", label: "intro" },
    { start: 20, prompt: "building tension", label: "verse" },
    { start: 40, prompt: "full orchestra", label: "chorus" },
  ],
});
```

## Sound effects (async tasks)

SFX endpoints are asynchronous: submitting returns a `task_id`, and the result
is fetched by polling. `generate()` wraps submit + poll:

```ts
import { SoniloClient, download } from "sonilo";
import { writeFile } from "node:fs/promises";

const client = new SoniloClient();
const result = await client.textToSfx.generate({ prompt: "glass shattering", duration: 5 });
await writeFile("sfx.m4a", await download(result.audio));
```

Or control polling yourself:

```ts
const task = await client.videoToSfx.submit({
  video: "clip.mp4", // Node.js path; pass File/Blob in the browser
  segments: [{ start: 0, end: 2.5, prompt: "footsteps on gravel" }],
  audioFormat: "wav",
});
const result = await client.tasks.wait(task.task_id, { pollInterval: 2000, timeout: 600000 });
```

`tasks.get(taskId)` fetches state once and never throws on a failed task;
`tasks.wait()` / `generate()` throw `TaskFailedError` (with `.code`,
`.refunded`) on failure and `TaskTimeoutError` if the deadline passes — the
task keeps running server-side and can still be polled afterwards. Result URLs
are presigned and expire; download promptly or re-fetch via `tasks.get`.

## Account

```ts
const services = await sonilo.account.services();
const usage = await sonilo.account.usage({ days: 7 });
```

## Errors

All errors extend `SoniloError`: `AuthenticationError` (401),
`PaymentRequiredError` (402), `RateLimitError` (429, `.retryAfter`),
`BadRequestError` (400/413/422, `.detail`), `APIError` (anything else),
`GenerationError` for failures mid-stream, `TaskFailedError` (`.code`,
`.taskId`, `.refunded`) for a failed SFX task, `TaskTimeoutError`
(`.taskId`) when `tasks.wait()` / `generate()` hits its deadline, and
`RequestTimeoutError` when a one-shot request or `download()` is aborted
by its own `timeout` (a caller-supplied `AbortSignal` is never rewrapped
this way, and streaming music generation is never subject to this timeout
at all).

Every `APIError` also carries `.status`, `.body` (the parsed response),
`.code` (the API's error code, e.g. `"rate_limit_exceeded"`), and `.errors`
(the validation detail array on a 422), in addition to any subclass-specific
properties above.
