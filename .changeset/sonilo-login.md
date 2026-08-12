---
"sonilo-cli": minor
---

Add `sonilo login`, `sonilo logout` and `sonilo whoami`. Signing in stores a
credential in `~/.config/sonilo/credentials.json` and every command picks it up,
so an API key no longer has to be pasted or exported. `--api-key` and
`SONILO_API_KEY` still take precedence, in that order, so existing setups are
unaffected.
