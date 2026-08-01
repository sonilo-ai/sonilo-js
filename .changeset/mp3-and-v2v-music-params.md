---
"sonilo": minor
"sonilo-cli": minor
---

Add `mp3` as an output container, expose `outputFormat` on `videoToSound`, and add `ducking` + `segments` to `videoToVideoMusic`.

- `TextToMusicParams.outputFormat` and `VideoToMusicParams.outputFormat` now accept `"mp3"` (320 kbps) alongside `"m4a"` and `"wav"`. The async gate widened with them: any container other than the `m4a` default is a finalize-time transcode and requires `mode: "async"`, where the check previously named `"wav"` specifically. CLI `--format` accepts `mp3` on `text-to-music` and `video-to-music`, and anything but `m4a` now implies `--async`.
- `videoToSound` gains `outputFormat` (`"wav"` default, or `"m4a"`/`"mp3"`), applying to the combined music + SFX track only — the `music` and `sfx` stems keep their native formats. `videoToVideoSound` does **not** take it: it always muxes the mix into an mp4. To make that a compile error rather than a value the server ignores, the params type split into `VideoToVideoSoundParams` (the base, now used by `videoToVideoSound`) and `VideoToSoundParams extends VideoToVideoSoundParams` (adds `outputFormat`). `VideoToVideoSoundParams` is newly exported. Passing `outputFormat` to `videoToVideoSound` no longer type-checks; every other usage is unchanged.
- `videoToVideoMusic` gains `ducking` and `segments`. `ducking` is default-ON server-side, so it is omitted from the request when unset — pass `false` for music-only audio. `segments` takes the same `Segment[]` shape as `videoToMusic`.

The `videoToVideoMusic` endpoint also changed behavior server-side: the returned video's audio now carries the source's speech with the generated music ducked under it, where it was previously music-only. Pass `ducking: false` to restore the old sound. Its input is now restricted to H.264, H.265/HEVC, VP9 or AV1 video (mp4/mov/m4v/webm) at up to 360 seconds, since the source picture is copied without re-encoding. Both are documented on the params type.
