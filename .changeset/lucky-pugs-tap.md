---
"sonilo": patch
"sonilo-cli": patch
---

Document the two 429s. The API's rate-limit message now names which limit was hit — requests per minute or concurrent generations — and the two want opposite handling, so `RateLimitError` gets a README section explaining how to tell them apart and what each one means. No runtime change.
