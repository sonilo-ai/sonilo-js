---
"sonilo": patch
"sonilo-cli": patch
---

Document `ar`, `tr`, `vi` and `id` as dubbing targets.

`DubbingLanguage` gains the four codes for autocomplete. As with the last
batch, this is a suggestion improvement rather than a fix for a type error:
the union ends in `(string & {})`, left open so a server-side addition still
type-checks against an older SDK, and the CLI passes `--languages` through
without validating it. Neither surface was rejecting these codes — they just
never appeared in the list a caller reads.

`ar` is unqualified Arabic rather than one of the country dialects, so it is
the `es`/`pt` shape, not the `pt_br` one. `tr`, `vi` and `id` are plain
single-region entries.
