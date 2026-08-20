---
"sonilo": patch
"sonilo-cli": patch
---

Document dubbing's raised source-video cap: 300 seconds (5 min), up from 180. The limit is enforced by the API, so nothing in these packages gated on it — but the README and the CLI's `--help` both stated the old number, and a caller who believes it trims a video that would have been accepted.
