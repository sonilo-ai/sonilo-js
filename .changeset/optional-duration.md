---
"sonilo": minor
"sonilo-cli": minor
---

`duration` is optional on text-to-music and text-to-sfx.

The API resolves an omitted duration itself, so the client leaves the field out
rather than inventing a number. Text-to-music picks a length that suits the
prompt — or, when `segments` are given, runs to the last segment's `start` plus
30 seconds. Text-to-sfx generates its own default length.

`TextToSfxParams.duration` also accepts fractional seconds: the API's minimum
dropped to 0.5, and the shortest effects — a latch, a click, a single footstep —
run well under a second.

Both are widening changes: every existing call that passes a duration behaves
exactly as before. On the CLI, `--duration` is no longer required by
`text-to-music` or `text-to-sfx`.
