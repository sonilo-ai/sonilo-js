---
"sonilo": minor
"sonilo-cli": minor
---

Add `promptInfluence` to `videoToMusic` and `videoToVideoMusic`, and the
matching `--prompt-influence` flag to both CLI commands.

`promptInfluence` controls how strongly the generated music follows the prompt
(0-1, API default 0.5). Lower values let the video lead; higher values follow
the prompt more literally. It is free of charge.

Left unset, nothing goes on the wire and the server's long-standing 0.5
default applies — existing calls behave exactly as before. `0` is a meaningful
value ("the video leads entirely") and is always sent, never dropped as falsy.

It is a generation-time knob, not a finalize-time one, so on `videoToMusic` it
works on the plain `stream()`/`generate()` path as well as `submit()` and
never forces `mode: "async"`. It exists only on `videoToMusic` and
`videoToVideoMusic` — not on the sound, SFX, text-to-music or dubbing
endpoints. Out-of-range values are rejected server-side with a 422; the SDK
does not pre-validate, matching `variantsNum`.
