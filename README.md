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

- `musicVolume` (0–1, default 0.5): 0.5 is the matched level; each step of
  0.25 shifts ±6 dB (full range ±12 dB). 0 mutes the music.
- `originalVolume` (0–1, default 1): absolute — 1 keeps the original exactly
  as recorded, 0 removes it entirely.
- `loudnessMatch: false` switches both knobs to plain absolute gains.
- `normalize: false` skips the delivery-loudness pass.

If loudness measurement fails (exotic codecs, unreadable audio), the kit
silently falls back to absolute-gain behavior rather than failing your render.

## Errors

`VideoKitError` (invalid arguments, unreadable video), `FfmpegNotFoundError`
(ffmpeg/ffprobe missing — message includes install hints), `FfmpegError`
(ffmpeg failed — carries `exitCode` and `stderrTail`). Errors from the Sonilo
API pass through as the `sonilo` package's typed errors.

## Roadmap

- `duckMusicUnderSpeech()` — automatic music ducking under dialogue, pending
  the speech-analysis API.

## License

MIT
