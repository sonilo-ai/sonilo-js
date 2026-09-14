---
"sonilo": minor
"sonilo-cli": minor
---

Dubbing takes subtitle scripts, returns re-timed SRTs, and exposes `lipsync`.

`DubbingParams.subtitles` is a map of target language to script — the lines
you want spoken in that language, not a source transcript — sent as one
`subtitles[<language>]` part each. A value starting with `https://` travels as
a URL; any other string is a local `.srt`/`.vtt` path, and browsers can pass a
`File`. `exportSrt` then returns each language's script re-timed against the
delivered audio, under `DubbingResult.subtitles`, alongside the
`subtitle_preflight` and `subtitle_export` report maps. Those maps' numeric
fields are typed `number | string` (a finished task carries them as strings)
and their `report_url` is `string | null` (the key is always written).

`dubbing.submit()` now returns a new `DubbingTask`: additively `SfxTask` plus
the acknowledgement's own `subtitle_preflight`, so a caller learns straight
from the 202 that the pipeline changed lines in a script they submitted.
`SfxTask` is shared with every other endpoint and is unchanged.

`lipsync` has existed on the endpoint since before this client and never
propagated. It is default-ON, so it is sent only when you pass it; `false`
keeps your source's own frames, resolution and frame rate and replaces the
audio alone.

In the CLI: `--subtitle <language>=<path-or-url>` (repeatable, one per target
language), `--export-srt`, which writes each re-timed file beside its video
(`clip.es.mp4` → `clip.es.srt`) and prints the preflight and export status of
every language, and `--no-lipsync`.
