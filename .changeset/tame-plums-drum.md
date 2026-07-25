---
"sonilo-cli": minor
---

Add `--stem <name>` to `video-to-sound` and `video-to-video-sound`, matching
the Python CLI. `video-to-sound` and `video-to-video-sound` return a combined
render plus three individual layers (`music`, `music_processed`, `sfx`); the
Node CLI previously wrote only the combined output and silently discarded the
rest.

`--stem` is repeatable — pass it once per layer you want saved — and each
requested stem is written in addition to the combined output, never instead
of it. The stem file is named from `--output` with `.<stem>` inserted before
the extension, and that extension is taken from the stem's own result URL
(falling back to the main output's extension when the stem URL has none):
`--output mix.wav --stem music` writes `mix.wav` plus `mix.music.wav`.

`music_processed` only exists on a result when `--preserve-speech` or
ducking actually altered the music bed. Requesting it (or any other stem)
when the result does not carry it now fails with a clear error naming the
missing stem, instead of writing an empty file or exiting silently.
