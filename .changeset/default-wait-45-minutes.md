---
"sonilo": patch
"sonilo-cli": patch
---

`tasks.wait()` and every async `generate()` now wait up to 45 minutes
(2700000 ms) by default, up from 10. The API lets a task wait up to 40
minutes for a generation runner before failing it, so the old default could
give up on a task that later succeeded and was billed. `--stems` in the CLI
now waits 75 minutes (the new default plus the 30-minute separation ceiling),
up from 40. Pass `timeout` (or `--timeout`) to choose your own.
