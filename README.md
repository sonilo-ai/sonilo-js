# sonilo-video-kit

Video helpers for the [Sonilo](https://sonilo.com) API: generate a soundtrack
for a video and mix it in locally with ffmpeg. Node.js ≥ 18.

Requires `ffmpeg` + `ffprobe` on your PATH (macOS: `brew install ffmpeg`,
Debian/Ubuntu: `apt-get install ffmpeg`) — or pass `ffmpegPath`/`ffprobePath`
(e.g. from the `ffmpeg-static` package).

## Installation

```bash
npm install sonilo-video-kit
```

## Quickstart

```ts
import { generateMusicForVideo, mixWithVideo } from "sonilo-video-kit";

const track = await generateMusicForVideo("./clip.mp4", {
  prompt: "upbeat, energetic",
}); // uses SONILO_API_KEY

await mixWithVideo({
  video: "./clip.mp4",
  audio: track.audio,
  output: "./clip.scored.mp4",
});
```

## Loudness-matched mixing

By default the kit measures the loudness (LUFS) of your video's own audio and
of the generated music, then sits the music 4 LU below the original — so
dialogue stays intelligible without hand-tuning. The final file is normalized
to −14 LUFS (streaming-platform delivery level) with a −1 dBFS peak limiter.
The delivery-normalize boost is capped at +12 dB; attenuation (bringing an
overly loud render down to target) is uncapped.

- `musicVolume` (0–1, default 0.5): 0.5 is the matched level; each step of
  0.25 shifts ±6 dB (full range ±12 dB). 0 mutes the music.
- `originalVolume` (0–1, default 1): absolute — 1 keeps the original exactly
  as recorded, 0 removes it entirely.
- `loudnessMatch: false` switches both knobs to plain absolute gains.
- `normalize: false` skips the delivery-loudness pass.

If loudness measurement fails (exotic codecs, unreadable audio), the kit
silently falls back to absolute-gain behavior rather than failing your render.

## Ducking music under speech

`mixWithVideo` sits the music at a fixed level under the original audio.
`duckMusicUnderSpeech` goes further: it rides the music down whenever someone
speaks and back up in the gaps.

```ts
import { duckMusicUnderSpeech } from "sonilo-video-kit";

await duckMusicUnderSpeech({
  video: "./interview.mp4",
  audio: track.audio,
  output: "./interview.ducked.mp4",
});
```

Unlike `mixWithVideo`, which is entirely local and free, this calls the Sonilo
ducking API and is **billed on your video's duration**. The kit uploads only the
video's extracted audio track — your picture never leaves the machine and is
copied into the result untouched.

The API sets the ducking curve itself (speech gate, duck depth, −14 LUFS
delivery, −1 dBTP ceiling), so there are no volume knobs to pass.

Requirements are enforced locally, before anything is uploaded or charged: the
video must have an audio track and a real picture, it must run no longer than
**360 seconds**, `output` must carry a file extension and live in a directory
that already exists and is writable, and **your picture must be stream-copyable
into the container `output`'s extension names** — the kit dry-runs the final mux
first, so a wrong extension (`.webm` for an h264 video) or a video stream ffmpeg
cannot copy at all is refused *before* the API call rather than after it. The
error names your codec and, when another container would work, tells you which
one (checked against your actual file, not a lookup table). Any failure throws
before the API is called; the kit never quietly falls back to an un-ducked mix.
Use `mixWithVideo` for silent or longer videos.

Both the 360 s limit and the amount you are billed are measured on the
**picture**, never on the container. A video whose audio track outlives its
picture (routine encoder padding; and the norm for `.mkv`/`.webm`) is billed for
the seconds you actually receive, not for the longest stream in the file — and a
350-second picture under a 365-second audio track is accepted, exactly as the API
itself accepts it.

### Nothing you have paid for is thrown away

The API charges when the job is **submitted**, and the task then runs to
completion server-side whatever happens to your process. So every failure after
that point is handled so that the mix you have already paid for stays reachable.

Transient failures are simply retried (with backoff): a 5xx while polling the
task, a dropped connection, a 503 from the storage host while downloading the
finished mix. One blip mid-poll no longer bins a paid job.

If a failure after submit is *not* recoverable — the poll fails terminally, the
download can't be completed, the wait times out, or you abort — the error names
the **task id** and tells you that the charge has already been made and that the
task is still finishing on the server. Poll `GET /v1/tasks/<task_id>` yourself
(`client.request("/v1/tasks/<task_id>")`) until it reports `succeeded` and
download the `output_url` it returns: that re-fetches the mix you paid for
rather than submitting — and paying for — a second job. Calling
`duckMusicUnderSpeech` again would charge you twice. (The presigned URL itself
is deliberately kept out of error messages: it grants read access to your
artifact, and errors end up in logs.)

If a final, purely-local step — remuxing the ducked audio onto your picture,
or placing the finished file at `output` — fails after the API call has
already run (the disk holding `output` fills up mid-mux; the source file is
truncated under you), the kit does not throw away the mix you already
paid for. It saves the
downloaded ducked audio to `<output>.ducked.wav` and throws an error naming
that path, so you can fix the local problem (e.g. pick a working container,
or a valid `output` path) and finish locally instead of calling
`duckMusicUnderSpeech` again and being billed a second time. If a rescued mix
from an earlier run is already sitting at `<output>.ducked.wav`, it is left
untouched and the new one is saved alongside it (`<output>.ducked.1.wav`) —
a rescue never overwrites or deletes a paid-for mix it did not itself write.
The file is also always placed at `output` atomically — a failure partway
through never leaves a truncated file there. In the rare case where even that
rescue save fails (e.g. the disk is full, so there's nowhere to save the rescue
copy either), the error says so explicitly, names the task id, and points you at
the re-poll above instead of surfacing a bare filesystem error.

## Errors

`VideoKitError` (invalid arguments, unreadable video), `FfmpegNotFoundError`
(ffmpeg/ffprobe missing — message includes install hints), `FfmpegError`
(ffmpeg failed — carries `exitCode` and `stderrTail`), `DuckingFailedError` (the
ducking API accepted the job but could not finish it — carries `code` and
`refunded`). Errors from the Sonilo API pass through as the `sonilo` package's
typed errors.

Failures *after* the ducking job was submitted are wrapped in a `VideoKitError`,
so that the message can carry the task id and the fact that you have already been
charged (see above). The original error stays reachable on `cause`, so your own
cancellation is still recognisable as one:

```ts
try {
  await duckMusicUnderSpeech({ video, audio, output, signal: controller.signal });
} catch (err) {
  if (err instanceof VideoKitError && (err.cause as Error | undefined)?.name === "AbortError") {
    return; // we aborted this ourselves
  }
  throw err; // note: the task is still running, and still billed — see the task id in the message
}
```

`refunded` reports what the server said **at the moment the task was polled**,
not a final verdict: the backend marks a task failed before it reverses the
charge, and retries a reversal that fails. So `refunded: false` means the
reversal had not landed yet, not that you were definitely billed — the message
says as much.

## License

MIT
