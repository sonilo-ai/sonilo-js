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

Two requirements are enforced locally, before anything is uploaded or charged:
the video must have an audio track, and it must run no longer than **360
seconds**. Either failure throws; the kit never quietly falls back to an
un-ducked mix. Use `mixWithVideo` for silent or longer videos.

If a final, purely-local step — remuxing the ducked audio onto your picture,
or placing the finished file at `output` — fails after the API call has
already run (for example, `output`'s extension names a container that can't
hold your video's codec, such as `.webm` for an h264 source; or `output`'s
directory doesn't exist or is read-only; or the disk holding `output` fills
up), the kit does not throw away the mix you already paid for. It saves the
downloaded ducked audio to `<output>.ducked.wav` and throws an error naming
that path, so you can fix the local problem (e.g. pick a working container,
or a valid `output` path) and finish locally instead of calling
`duckMusicUnderSpeech` again and being billed a second time. The file is
also always placed at `output` atomically — a failure partway through never
leaves a truncated file there. In the rare case where even that rescue save
fails (e.g. `output`'s directory doesn't exist, so there's nowhere to save
the rescue copy either), the error says so explicitly instead of surfacing a
bare filesystem error.

## Errors

`VideoKitError` (invalid arguments, unreadable video), `FfmpegNotFoundError`
(ffmpeg/ffprobe missing — message includes install hints), `FfmpegError`
(ffmpeg failed — carries `exitCode` and `stderrTail`), `DuckingFailedError` (the
ducking API accepted the job but could not finish it — carries `code` and
`refunded`, which reports whether the charge was reversed). Errors from the
Sonilo API pass through as the `sonilo` package's typed errors.

## License

MIT
