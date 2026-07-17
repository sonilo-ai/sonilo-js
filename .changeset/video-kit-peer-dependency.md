---
"sonilo-video-kit": minor
---

`sonilo` is now a peer dependency instead of a bundled dependency. Install it
alongside the kit: `npm install sonilo sonilo-video-kit`. This guarantees a
single shared copy of the core client so that `instanceof` checks against its
typed errors (e.g. `PaymentRequiredError`) behave correctly.
