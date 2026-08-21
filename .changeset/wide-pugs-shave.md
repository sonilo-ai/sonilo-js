---
"sonilo": patch
"sonilo-cli": patch
---

Document `pt_br`, `es_419` and `th` as dubbing targets.

`DubbingLanguage` gains the three codes for autocomplete. It needed no
widening to keep compiling — the union ends in `(string & {})`, left open
so a server-side addition still type-checks against an older SDK — so this
is a suggestion improvement, not a fix for a type error anyone was hitting.

`pt_br` (Brazilian Portuguese) and `es_419` (Latin American Spanish) are
additions to `pt` and `es`, not replacements: plain `pt` and `es` still
resolve to unqualified Portuguese and Spanish server-side, so nothing
changes for a caller already asking for them.
