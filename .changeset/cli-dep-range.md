---
"sonilo-cli": patch
---

Widen the `sonilo` dependency range to `>=0.5.1 <1.0.0` so the CLI picks up
minor releases of the core client.

The old `^0.5.1` range excluded every 0.x minor, so `sonilo@0.6.0` and later
would never have been installed for CLI users — the CLI would have stayed
pinned to 0.5.x and silently missed new API surface. Unlike the video kit's
peer dependency this never produced a wrong version number, only a stale
install.
