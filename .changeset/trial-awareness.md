---
"sonilo": minor
"sonilo-cli": minor
---

Make the free trial visible before it runs out, and distinguishable when it does.

`TrialExhaustedError` is a new subclass of `PaymentRequiredError`, raised for
the `402` whose body carries `code: "trial_exhausted"` — the free trial for
that service is spent and the account has never been funded, so a retry can
never succeed and the caller should ask for a payment method instead. Existing
`catch (err) { if (err instanceof PaymentRequiredError) ... }` code keeps
catching it unchanged; order the checks most-specific-first to tell it apart
from a funded wallet that ran dry (`insufficient_balance`).

`sonilo account` now prints a one-line free-trial summary
(`Free trial: text-to-music 1/2 left, ...`) on stderr, leaving stdout as pure
JSON so pipelines are unaffected. The line is omitted for accounts that have
no trial allowance to report.
