---
"sonilo-cli": minor
---

Add the `video-to-video-music` and `video-to-video-sfx` commands, closing the
last gap between the API's generation endpoints and the CLI. Both are async
only and write a video: they submit the task, poll it, and save the re-hosted
result (default `./output.mp4`). `video-to-video-music` takes `--prompt`,
`--preserve-speech` and the legacy `--isolate-vocals`; `video-to-video-sfx`
takes `--prompt` and `--segments` with the SFX shape `{start, end, prompt}`.

Also fix the `video-to-music` help text, which listed `--isolate-vocals` and
`--preserve-speech` as two independent options and described the former as
splitting out a "vocals-only stem". They are one feature under two names — the
API accepts either and ORs them — and this command writes only the main audio
track, so `--isolate-vocals` is now documented as a legacy alias for
`--preserve-speech` and no longer advertises a stem the CLI cannot hand back.
