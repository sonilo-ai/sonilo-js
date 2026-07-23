---
"sonilo": minor
---

Add `videoToSound` and `videoToVideoSound` for the combined music + sound-effects
endpoints, with the `SoundResult` type carrying the mixed `output_url` and the
`music` / `music_processed` / `sfx` stems. `download()` now also accepts a bare
URL string.
