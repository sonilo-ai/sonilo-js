---
"sonilo-cli": minor
---

Add the `video-to-video-music` and `video-to-video-sfx` commands, closing the
last gap between the API's generation endpoints and the CLI. Both are async
only and write a video: they submit the task, poll it, and save the re-hosted
result (default `./output.mp4`). `video-to-video-music` takes `--prompt`,
`--preserve-speech` and the legacy `--isolate-vocals`; `video-to-video-sfx`
takes `--prompt` and `--segments` with the SFX shape `{start, end, prompt}`.
