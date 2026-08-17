---
"sonilo": minor
"sonilo-cli": minor
---

Add `stems` to `textToMusic` and `videoToMusic`, and the matching `--stems`
flag to both CLI commands.

`stems: true` also splits the generated track into four separated stems —
`drums`, `bass`, `vocals`, `other`. It is free of charge. On `videoToMusic`
it splits the GENERATED music, never the source video's own audio. It
requires `mode: "async"` (the backend rejects it on the plain stream with a
400), so it is only meaningful via `submit()`; `stream()`/`generate()` never
send it, and on `videoToMusic` `submit()` auto-selects async, matching
`preserveSpeech`/`ducking`.

The task result gains two independent fields, typed on `MusicTaskResult`:
`stems` (one `StemsEntry` — `{ stream_index, drums, bass, vocals, other }`,
each stem an `SfxMedia` — per stream that separated successfully; look
entries up by `stream_index`, never by position, since the array can be
shorter than `audio`) and `stems_error` (why separation failed wholly or in
part, or was skipped — it can appear ALONGSIDE a partial `stems` array, so
its presence never means "no stems").

Separation runs after generation and typically adds 2-6 minutes to the wait
(giving up after 30), so raise `tasks.wait`'s timeout for stems runs. The CLI
does this itself (`--stems` waits up to 40 minutes), writes each stem next to
the main output with the stem name inserted before the extension (per variant
above `--variants` 1), warns on a partial result, and fails only when no
stems came back at all.
