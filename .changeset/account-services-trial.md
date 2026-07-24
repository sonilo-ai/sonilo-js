---
"sonilo": patch
---

Add the `trial` field to `AccountServices`, mirroring the API's free-trial
quota on `GET /v1/account/services`.

Integrations previously had no way to see a free trial running out: the only
signal was a `402` on the next generation call, so a newly signed-up developer
hit a hard failure instead of a prompt to add a payment method. `trial` now
reports `granted` / `used` / `remaining` per service, so callers can degrade
gracefully before the trial is spent.

The field is optional: the API returns it only for self-serve accounts and
omits the key entirely otherwise, so consumers must treat it as possibly
absent. The new `TrialQuota` type is exported from the package entrypoint.
