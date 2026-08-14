---
"sonilo-cli": minor
---

`sonilo whoami` is now usable as a check. It exits 1 when there is no credential instead of exiting 0 while printing "Not signed in", so scripts and agents can branch on it the way they branch on `gh auth status`; an expired credential still exits 0, since it names a real account and wants `sonilo login` rather than first-time setup. It also no longer prints an empty `account:` line for an account with no display name — the API sends `account_name: " "` and the nullish fallback let that single space through, which read exactly like a credential that had failed to load.

Minor rather than patch: anything currently relying on `whoami` exiting 0 while signed out will start seeing 1.
