---
"sonilo": minor
"sonilo-cli": minor
---

Add `variantsNum` (1-10, default 1) to generate several distinct music
variants in one request: `textToMusic`, `videoToMusic`, `videoToVideoMusic`,
`videoToSound` and `videoToVideoSound`. Cost scales linearly, and values
above 1 are never covered by the free trial. On `textToMusic`/`videoToMusic`
it requires `mode: "async"`, same as `outputFormat: "wav"` and
`preserveSpeech`.

Result envelopes gain per-variant data, strictly additive: `MusicMediaEntry`
carries an optional `title`; `VideoResult` gains `videos[]` (`video` stays a
permanent alias for `videos[0]`); `SoundResult` gains `outputs[]` (the
existing top-level fields stay permanent aliases for `outputs[0]`); task
results (`tasks.get`/`tasks.wait`) echo `variants_num` when it was above 1.
These arrays are present even at the default `variantsNum` of 1, as a
single-entry array.

The CLI gains `--variants <n>` on the five affected commands. At the default
of 1, every command still writes exactly one file; above 1, one file is
written per variant, with the variant's index inserted before the extension
(e.g. `--output track.wav --variants 3` writes `track.0.wav`, `track.1.wav`,
`track.2.wav`).
