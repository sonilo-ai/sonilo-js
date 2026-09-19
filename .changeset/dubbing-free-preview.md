---
"sonilo": minor
"sonilo-cli": minor
---

Dubbing: the free trial is now a 15-second preview, and the result says so.

A self-serve account's first single-language `dubbing` call without scripts
translates only the first 15 seconds of the video, at no charge. The task
carries `trial_preview` in every state — `preview_seconds`,
`source_duration_seconds`, `trimmed`, `languages`, `full_video_cost_usd`
(what the whole video would cost) and a ready-made `message` — typed as
`DubbingResult.trial_preview` / `TrialPreview`. `sonilo dubbing` prints the
message with its other status lines. Both READMEs previously said dubbing
had no free trial.
