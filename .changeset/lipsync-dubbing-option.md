---
"sonilo": minor
"@sonilo/cli": minor
---

Dubbing: add `lipsync`, defaulting to on.

`lipsync: false` (`--no-lipsync` on the CLI) asks the backend to translate the
audio without re-rendering the speaker's mouth. The video comes back at its
original resolution and frame rate rather than re-rendered, and only the audio
is replaced — so the mouths keep moving to the original language. Useful for
footage with no on-camera speaker, or when preserving the exact original
picture matters more than matching lip movement.

Omitted when unset, so the server keeps owning the default.
