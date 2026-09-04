---
"sonilo": patch
---

Document the raised source-video cap on the sound endpoints: `videoToSound` and `videoToVideoSound` accept sources up to 480 seconds (8 minutes), up from 180.

The limit is enforced by the API, so nothing in this package gated on it — but the README stated the old number, and a caller who believes it trims a video the API would have taken.
