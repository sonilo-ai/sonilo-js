---
"sonilo": minor
"sonilo-cli": minor
---

Follow the API's `ducking` flip from default-on to default-off.

The server now treats an unset `ducking` as off on `/v1/video-to-music`,
`/v1/video-to-sound`, `/v1/video-to-video-music` and `/v1/video-to-video-sound`.
Both packages already omitted the field when unset and still do, so the wire
behaviour is unchanged — but everything that explained the old default was
wrong, and on the CLI the only expressible direction was the one that no longer
does anything.

- `sonilo`: the `ducking` JSDoc on all four param types, the
  `videoToVideoMusic` request/audio table, and the README now describe
  default-off. Two notes that reasoned from the old default are corrected:
  `videoToSound.keepOriginalSound` is `never` because that endpoint reaches the
  original track through `ducking: true`, not because its default already kept
  the voice; and dubbing's `ducking` is no longer "the opposite of
  video-to-music's".
- `sonilo-cli`: `video-to-sound`, `video-to-video-sound` and
  `video-to-video-music` gain `--ducking`. `--no-ducking` still parses and now
  sends an explicit `false` — removing it would have turned every script that
  passes it into an "unknown option" failure — and passing both fails rather
  than silently picking one.

Callers of `videoToSound` who relied on the default should know it is the one
endpoint where `ducking` picks the voice source as well as the mix: without it
the source's own speech is no longer in the deliverable at all, and the result
carries no `music_processed` stem.
