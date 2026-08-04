---
"sonilo": patch
"sonilo-cli": patch
---

Follow the API's shorter 429 wording. The per-minute message now says "Please retry after 1 minute" instead of explaining the window inline, and both messages ask politely; the READMEs quote them verbatim, so they move together. The window explanation stays in the docs, where it belongs. No runtime change.
