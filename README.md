# sonilo

Official TypeScript/JavaScript client for the [Sonilo](https://sonilo.com) API.
Works in Node.js ≥ 18 and modern browsers. Zero runtime dependencies.

## Installation

```bash
npm install sonilo
```

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
await writeFile("sfx.m4a", await download(result.audio!));
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
and `GenerationError` for failures mid-stream.

## License

MIT
