# sonilo

## 0.5.0

### Minor Changes

- 2be192e: Add `videoToSound` and `videoToVideoSound` for the combined music + sound-effects
  endpoints, with the `SoundResult` type carrying the mixed `output_url` and the
  `music` / `music_processed` / `sfx` stems. `download()` now also accepts a bare
  URL string.

## 0.4.0

### Minor Changes

- 23b67f1: Add `videoToVideoMusic` and `videoToVideoSfx` resources (async video-output endpoints). Add `preserveSpeech`, `outputFormat`, and `ducking` to `videoToMusic.submit`, `mode`/`outputFormat` + async `submit()` to `textToMusic`, and a `ducked` field on music results. Fix the client version header (was 0.2.0).
