---
"sonilo": minor
"sonilo-cli": minor
---

Add `keepOriginalSound` to `videoToVideoMusic` and `videoToVideoSound`, and the
matching `--keep-original-sound` flag to both CLI commands.

The server flipped both endpoints' defaults: a request that does **not** set
`keepOriginalSound` now returns the generated audio alone, where it previously
returned the source video's speech with the generated music ducked underneath.
`videoToVideoSound`'s default result therefore carries no `music_processed`
stem, since with no voice source there is no processed track. That change is
server-side and applies whether or not you upgrade — this release is what lets
you opt back in.

The two knobs are independent: `keepOriginalSound` picks the **voice source**
(whole original track, or `preserveSpeech` for the isolated speech only) and
`ducking` picks how it is **combined** with the generated audio (dynamic duck,
or `ducking: false` for a static voice-forward mix). `keepOriginalSound`
supersedes `preserveSpeech`; no combination is rejected.

`keepOriginalSound` is video-only. `VideoToSoundParams` types it `never`, so
passing it to `videoToSound` is a compile error rather than a field the server
silently drops — the mirror of how `outputFormat` is kept off
`videoToVideoSound`. The CLI rejects `--keep-original-sound` on `video-to-sound`
for the same reason.

`video-to-video-music` also gains `--no-ducking`, which the SDK already
supported but the CLI never exposed. Without it the static-mix combination was
unreachable from the command line.
