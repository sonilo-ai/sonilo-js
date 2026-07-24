---
"sonilo-cli": minor
---

Add `--segments` to `text-to-music`, `video-to-music`, `video-to-sfx`, `video-to-sound` and `video-to-video-sound`, matching the structured parameter both SDKs already support. The flag accepts the same three forms as `curl`/`gh`/`aws`: inline JSON, `@path` to read a file, or `@-` to read stdin.

The CLI validates only the shape of the value — that it parses as JSON, is a non-empty array of objects, and each object carries the right fields for the command's shape (`{start, prompt, label?}` for music, `{start, end, prompt}` for SFX). It does not replicate the API's semantic rules (segment ordering, spacing, the `label` enum, count limits), leaving those to the server's own validation. Passing segments shaped for the other kind of command is rejected immediately with a message naming the expected shape.
