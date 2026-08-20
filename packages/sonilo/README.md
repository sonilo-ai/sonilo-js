# sonilo

Official TypeScript/JavaScript client for the [Sonilo](https://sonilo.com) API.
Works in Node.js ≥ 18 and modern browsers. Zero runtime dependencies.

## Installation

```bash
npm install sonilo
```

## Authentication

Create an API key in your [Sonilo dashboard](https://platform.sonilo.com/dashboard/api-keys?utm_source=sonilo_js&utm_medium=readme&utm_campaign=sdk_quickstart),
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

### Prompt influence

`promptInfluence` controls how strongly the generated music follows the prompt
(0-1, API default 0.5). Lower values let the video lead; higher values follow
the prompt more literally. It is free of charge, and available on
`videoToMusic` (both the stream and the async `submit()` path — it never
forces async) and `videoToVideoMusic`. Leave it unset to keep the server's
0.5 default; `0` is a meaningful value ("the video leads entirely") and is
sent when set. Out-of-range values are rejected with a 422.

```ts
await sonilo.videoToMusic.generate({
  video: "./my_video.mp4",
  prompt: "upbeat, energetic",
  promptInfluence: 0.8, // follow the prompt more literally
});
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
- `ducking` — duck the generated music under the source voice. It is **off by
  default**; pass `ducking: true` to run it. When it runs, the result gains a
  `ducked` array alongside `audio` — the `audio` track itself is the same
  either way.
- `outputFormat` — `"m4a"` (default), `"wav"`, or `"mp3"` (320 kbps).
  Anything but `m4a` is a finalize-time transcode and requires async mode.

```ts
const task = await client.videoToMusic.submit({
  video: "./my_video.mp4",
  preserveSpeech: true,
  outputFormat: "wav",
  ducking: true, // off by default — opt in to also get the `ducked` track
});
const result = await client.tasks.wait<MusicTaskResult>(task.task_id);
if (result.ducked) {
  await writeFile("ducked.wav", await download(result.ducked[0]!));
}
```

### Stems (async)

Set `stems: true` to also split the generated track into four separated
stems — `drums`, `bass`, `vocals`, `other`. It is **free of charge**, and
available on `textToMusic` and `videoToMusic`. It requires the async task API
(`mode: "async"` — the backend rejects it on the plain stream with a 400), so
it is only meaningful via `submit()`; on `videoToMusic` it splits the
**generated** music, never the source video's own audio.

When separation succeeds, the result gains a `stems` array with one entry per
stream: `{ stream_index, drums, bass, vocals, other }`, each stem an ordinary
media object (`url`, `content_type`, `file_size`) you can pass to
`download()`. **Look entries up by `stream_index`, never by array position** —
`stems` carries only the streams that separated successfully, so it can be
shorter than `audio`.

Failures land in `stems_error`, a string present when separation failed wholly
or in part, or was skipped. It can appear **alongside a partial `stems`
array**, so never treat it as "no stems" — check `stems` itself for what did
arrive. Either way the generated `audio` is unaffected.

Separation runs after generation and typically adds 2-6 minutes to the wait
(it gives up after 30), so raise `tasks.wait`'s `timeout` beyond the 10-minute
default. The stems normally follow the request's `outputFormat`; each stem's
own `content_type` reports what was actually delivered.

```ts
const task = await client.textToMusic.submit({
  prompt: "warm lo-fi piano",
  duration: 30,
  stems: true, // free — adds drums/bass/vocals/other alongside the mix
});
const result = await client.tasks.wait<MusicTaskResult>(task.task_id, {
  timeout: 2_400_000, // separation can add up to 30 minutes
});

if (result.stems_error) console.warn(result.stems_error); // may be partial
for (const track of result.audio ?? []) {
  const split = result.stems?.find((s) => s.stream_index === track.stream_index);
  if (!split) continue; // this stream did not separate — see stems_error
  await writeFile("drums.m4a", await download(split.drums));
  await writeFile("bass.m4a", await download(split.bass));
  await writeFile("vocals.m4a", await download(split.vocals));
  await writeFile("other.m4a", await download(split.other));
}
```

### Variants (async)

`variantsNum` generates several distinct music variants in one request (1-10,
default 1) — each is its own creative direction, with its own title. It's
available on `textToMusic`, `videoToMusic`, `videoToVideoMusic`,
`videoToSound` and `videoToVideoSound`. Cost scales linearly with the count,
and **values above 1 are never covered by the free trial**.

On `textToMusic`/`videoToMusic`, `variantsNum` above 1 requires the async task
API — same as `preserveSpeech` above — so it implies `mode: "async"` if you
don't set `mode` yourself; `stream()`/`generate()` never send it, since they
always request a plain stream. `videoToVideoMusic`, `videoToSound` and
`videoToVideoSound` are already async-only, so no extra `mode` handling is
needed there.

```ts
const task = await client.textToMusic.submit({
  prompt: "warm lo-fi piano",
  duration: 30,
  variantsNum: 3,
});
const result = await client.tasks.wait<MusicTaskResult>(task.task_id);

// audio has one entry per variant; each entry may carry its own `title`.
for (const variant of result.audio ?? []) {
  console.log(variant.title?.title, variant.url);
}
```

`videoToVideoMusic` returns one video per variant in `videos[]`, with `video`
kept as a permanent alias for `videos[0]`. `videoToSound`/`videoToVideoSound`
return one entry per variant in `outputs[]`, each shaped like the top-level
result (`output_url`, `output_type`, `output_bytes`, `music`,
`music_processed?`, `sfx`) — the top-level fields remain permanent aliases for
`outputs[0]`. All of these arrays are present even at the default
`variantsNum` of 1, as a single-entry array; every other field is unchanged.

`GET /v1/tasks/{id}` (`tasks.get`/`tasks.wait`) echoes the request's
`variantsNum` back as `variants_num`, but only when it was above 1.

## Video to video

Generate a soundtrack or sound effects and get back a **re-hosted video** with
the audio muxed in — not just an audio file. Both endpoints are async; poll to
a `VideoResult`:

```ts
import { SoniloClient, download } from "sonilo";
import { writeFile } from "node:fs/promises";

const client = new SoniloClient();

// Score music into the video. By default the returned video's audio is the
// generated music alone, with the source's own audio removed — pass
// `keepOriginalSound: true` to keep the source track (statically mixed, or
// ducked under the music with `ducking: true`).
const music = await client.videoToVideoMusic.generate({
  video: "./my_video.mp4", // Node path; File/Blob in the browser, or `videoUrl`
  prompt: "cinematic orchestral swell",
  preserveSpeech: true,
  // segments: [{ start: 0, prompt: "sparse pads" }, { start: 30, prompt: "add drums" }],
});
await writeFile("scored.mp4", await download(music.video!));

// Sound effects for the video, optionally per time segment
const sfx = await client.videoToVideoSfx.generate({
  video: "./my_video.mp4",
  segments: [{ start: 0, end: 2, prompt: "footsteps on gravel" }],
});
await writeFile("with_sfx.mp4", await download(sfx.video!));
```

## Video to sound

`videoToSound` and `videoToVideoSound` generate a music bed and sound effects
for the same clip and return them mixed into a single soundtrack — one call,
one charge, instead of chaining two requests. `videoToSound` returns the mixed
audio; `videoToVideoSound` returns the source video with that audio muxed in.
Both are async-only, and both accept the same options.

```ts
import { SoniloClient, download } from "sonilo";
import { writeFile } from "node:fs/promises";

const client = new SoniloClient();

const result = await client.videoToSound.generate({
  videoUrl: "https://example.com/clip.mp4",
  musicPrompt: "uplifting orchestral score",
  sfxPrompt: "match the on-screen action",
});

await writeFile("soundtrack.wav", await download(result.output_url));
```

The mixed result is `output_url` (`output_type` is `"audio"` here, `"video"`
for `videoToVideoSound`). The individual stems come back alongside it, so you
can re-balance the mix yourself:

```ts
await writeFile("music.m4a", await download(result.music));
await writeFile("sfx.wav", await download(result.sfx));
```

By default the result is the generated music + effects alone — the source
video's own speech is not carried into it. `preserveSpeech: true` brings in the
isolated speech, and `ducking: true` (off by default) brings in the whole
original track with the music dipped under it. `segments` takes the same
`{ start, end, prompt }` list as `videoToSfx`.

`videoToSound` also takes `outputFormat` — `"wav"` (default), `"m4a"` or
`"mp3"` — which applies to the combined track only; the `music` and `sfx`
stems keep their native formats. `videoToVideoSound` does not take it: that
endpoint always muxes the mix into an mp4, and its params type
(`VideoToVideoSoundParams`) omits the field so passing it is a compile
error.
Input videos may be at most 180 seconds long.

Use `submit()` instead of `generate()` to get a `task_id` back immediately and
poll it yourself with `client.tasks.wait<SoundResult>(taskId)`.

## Audio ducking

`client.audioDucking.submit()` / `.generate()` mix an existing music bed under
an existing voice track, dipping the music wherever the voice speaks and
lifting it back in the gaps. Nothing is generated — both inputs are yours.
Reach for it when the music is fixed or external; when the music is being
generated for the same clip anyway, `videoToSound` or `videoToMusic` with
`ducking: true` duck internally as part of that one call instead.

```ts
import { SoniloClient, download } from "sonilo";
import { writeFile } from "node:fs/promises";

const client = new SoniloClient();

const result = await client.audioDucking.generate({
  voice: "./interview.mp4", // Node path; File/Blob in the browser, or `voiceUrl`
  musicUrl: "https://example.com/bed.wav",
});

await writeFile(
  result.output_type === "video" ? "ducked.mp4" : "ducked.wav",
  await download(result.output_url!),
);
```

Params: exactly one of `voice` / `voiceUrl` and exactly one of `music` /
`musicUrl` (a local input and a URL mix freely across the two). The **voice**
may be audio or video — a video's own audio track becomes the voice, and the
ducked mix is muxed back into a new video, so the result is a `.mp4` instead
of a `.wav`. The **music** must be audio: the API never probes it for a video
stream, so a video there is silently mishandled rather than rejected. Each
input is capped at 360 seconds. Async-only; the result is a `DuckingResult`
carrying the same flat `output_url` / `output_type` envelope as
`videoToSound`, with no stems.

## Dubbing

`client.dubbing.submit()` / `.generate()` dub a video into one or more target
languages in a single async call — one call, one task, one dubbed video per
language.

```ts
import { SoniloClient } from "sonilo";
import type { DubbingResult } from "sonilo";

const client = new SoniloClient();

const task = await client.dubbing.submit({
  videoUrl: "https://example.com/clip.mp4",
  languages: ["es", "fr"],
});
const result = await client.tasks.wait<DubbingResult>(task.task_id);
for (const [language, url] of Object.entries(result.outputs ?? {})) {
  console.log(language, url);
}
```

`generate()` wraps submit + poll, same as the other async endpoints, and
accepts a `{ timeout }` option to override the default 10-minute wait. The
dubbing pipeline can take much longer than that, especially with several
languages in one call, so pass a longer timeout for anything but the shortest
clips. 7,200,000 ms matches the backend's own ceiling for a dubbing job and is
what the CLI defaults to. For long jobs you can also use `submit()` plus your
own `client.tasks.wait()`, as above:

```ts
const result = await client.dubbing.generate(
  { videoUrl: "https://example.com/clip.mp4", languages: ["es", "fr"] },
  { timeout: 7_200_000 }, // 2 hours, the backend's own ceiling
);
```

Params: exactly one of `video` / `videoUrl` (`videoUrl` must be **https** —
the dubbing pipeline fetches the source itself and rejects plain http). The
optional `languages` array defaults to `["zh_cn", "es", "fr"]`; supported
codes are `en, zh_cn, ja, ko, pt, es, de, fr, it, ru`. The optional `ducking`
boolean (default off, free) ducks the background music/effects bed under the
dubbed voice while it speaks; when off the bed is kept at a constant level.
Every endpoint's `ducking` is default-off, so this one is no exception.

Dubbing is async-only, and the source video may be at most 300 seconds long.
You are billed per language. Dubbing has **no free trial allowance** — unlike
every other endpoint, every call bills from the first one (see
[Free trial](#free-trial)).

The result is a `DubbingResult`, whose `outputs` is a map of language code to
dubbed `.mp4` URL — not the `audio`/`video`/`output_url` shape the other
endpoints use.

## Video analysis

`client.videoAnalysis` analyzes a video and returns a **creative brief** for
scoring it. Nothing is generated: no audio, no video, no file to download.
The result is the work order — a time-aligned `segments` plan plus one
`prompt` per requested variation, each ready to hand straight to
`videoToMusic`, `videoToSfx`, `videoToSound` or their video-to-video
counterparts.

Pass exactly one of `video` / `videoUrl`, plus optional `prompt` (guidance
for the analysis, at most 2000 characters) and `variantsNum` (1-5, default
1 — billed per brief). Source videos may be at most 600 seconds long, and
billing has a 10-second floor, so a very short clip still costs the same as a
10-second one.

```ts
const brief = await client.videoAnalysis.analyze({
  video: "trailer.mp4",
  prompt: "focus on the chase",
  variantsNum: 2,
});

for (const segment of brief.segments ?? []) {
  console.log(`${segment.start}-${segment.end}s [${segment.label}] ${segment.prompt}`);
}

// Feed a variation's prompt straight into a generation call.
const task = await client.videoToMusic.submit({
  video: "trailer.mp4",
  prompt: brief.variations![0]!.prompt,
});
```

The method is `analyze`, not `generate`, for the same reason there is no
download helper on the result: every other resource returns something you
save, and this one never does. Both `segments` and `variations` are optional
on the type because a `processing` or `failed` poll carries neither. Use
`submit()` instead of `analyze()` to get a `task_id` back immediately and
poll it yourself with
`client.tasks.wait<VideoAnalysisResult>(taskId)`.

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

## Free trial

Accounts created through self-serve signup start with free runs on most
endpoints — no card required:

| Free runs | Endpoints |
| --- | --- |
| 2 each | text-to-music, text-to-sfx, audio-ducking, video-analysis |
| 1 each | video-to-music, video-to-sfx, video-to-video-music, video-to-video-sfx, video-to-sound, video-to-video-sound |
| 0 | dubbing |

Once an endpoint's free runs are used up, calls to it bill at the normal rate.
**Dubbing has no free trial allowance at all** — it bills every call from the
first one. This is deliberate: dubbing charges `video_duration ×
number_of_languages`, so a single "free" run could easily cost more than the
free allowance on every other endpoint combined.

The table above is the current default. Read the live numbers from
`account.services()` rather than hard-coding them — see
[Account](#account) below, and [Errors](#errors) for what a spent trial
looks like at the call site.

## Account

```ts
const services = await sonilo.account.services();
const usage = await sonilo.account.usage({ days: 7 });
```

`services.trial` reports the free-trial allowance per service, so an
integration can degrade gracefully *before* a call fails:

```ts
const { trial } = await sonilo.account.services();
const quota = trial?.text_to_music;
if (quota && quota.remaining === 0) {
  // Prompt for a payment method instead of firing a call that will 402.
  console.log(`Free trial spent (${quota.used}/${quota.granted}).`);
}
```

`trial` is present only for self-serve accounts, so always treat it as
optional; a service missing from the map has no trial allowance rather than
an unlimited one.

## Errors

All errors extend `SoniloError`: `AuthenticationError` (401),
`PaymentRequiredError` (402), `TrialExhaustedError` (402, a subclass of
`PaymentRequiredError`), `RateLimitError` (429, `.retryAfter`),
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

### The three 402s

A `402` is not one condition. Branch on the class (or equivalently on
`.code`), never on the message text:

```ts
try {
  await sonilo.textToMusic.generate({ prompt: "lofi", duration: 30 });
} catch (err) {
  if (err instanceof TrialExhaustedError) {
    // code: "trial_exhausted" — the free trial for this service is spent and
    // the account has never been funded. Prompt for a payment method; a retry
    // can never succeed.
  } else if (err instanceof PaymentRequiredError) {
    // code: "insufficient_balance" — a funded wallet ran dry. Add balance and
    // retry the same request.
    // code: "payment_required" — anything else, e.g. a suspended account.
  }
}
```

`TrialExhaustedError` extends `PaymentRequiredError`, so an existing
`catch (err) { if (err instanceof PaymentRequiredError) ... }` keeps
catching every 402 — order the checks most-specific-first if you want to
tell them apart.

### The two 429s

`RateLimitError` covers two separate limits that want opposite handling.
The class and `.code` (`rate_limit_exceeded`) are identical for both — only
the message tells them apart:

- **Requests per minute** — `Rate limit exceeded: your account allows 60
  requests per minute. Please retry after 1 minute. To raise your limit,
  please contact info@sonilo.com.` Calls are going out too fast. The counter
  runs on a fixed 60-second window and rejected requests count toward it too,
  so a retry inside the window cannot succeed — a full minute always clears
  it, whatever your phase within the window.
- **Concurrent generations** — `Too many concurrent generations: 5 of 5 in
  progress. Please wait for one to finish before starting another. To raise
  your limit, please contact info@sonilo.com.` Every generation slot is busy.
  Waiting alone frees nothing — retry when one of your own in-flight
  generations finishes, not on a timer.

The numbers are the account's own limits; `account.services()` reports them
as `rpm_limit` and `concurrency_limit`. Email info@sonilo.com to raise
either. `.retryAfter` is set only when the server sends a `Retry-After`
header, so treat it as a hint rather than something to depend on.
