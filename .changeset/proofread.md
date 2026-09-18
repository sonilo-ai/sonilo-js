---
"sonilo": minor
"sonilo-cli": minor
---

Proofread: transcribe a video and translate the transcript into editable
subtitle files.

`client.proofread.submit()` / `.generate()` post `POST /v1/proofread` with
exactly one of `video` / `videoUrl` (`videoUrl` must be `https://`, as on
dubbing), optional `languages` — the same codes `DubbingParams.languages`
takes, sent as one JSON-array form field and omitted entirely when unset,
which is what asks for the source-language transcript alone — and optional
`sourceLanguage`, a hint for the spoken language. Codes are not validated
client-side: the server owns that list, exactly as it does for dubbing.

A finished task is a `ProofreadResult`: `subtitles`, a map of language code to
`.srt` URL that always includes the **detected** `source_language` alongside
the requested targets, plus `cue_count` and `warnings`, a map of language to
non-blocking `ProofreadIssue`s (`cue`, `code`, `severity`, and whatever
measurement that code brought with it). Nothing in `warnings` fails the task or
withholds a file.

Nothing is dubbed and nothing is spoken: this is the step before
`client.dubbing`. Correct the returned scripts, then pass them to
`client.dubbing` as `subtitles[<language>]` so the dub speaks exactly the
approved wording.

In the CLI: `sonilo proofread --video <path>` / `--video-url`, `--languages`,
`--source-language` and `--output` (a filename template, default
`proofread.srt`, one `.srt` per language with the code inserted before the
extension — `scripts/clip.srt` → `scripts/clip.en.srt`; missing directories are
created). It then prints the detected source language, the cue count and one
line per warning, and waits with the usual default timeout rather than
dubbing's two hours.
