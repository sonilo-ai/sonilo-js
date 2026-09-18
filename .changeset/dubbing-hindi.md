---
"sonilo": patch
"sonilo-cli": patch
---

Document Hindi as a dubbing target.

`hi` joins `DubbingLanguage`, the README and `sonilo dubbing --help`. Nothing
in the SDK or CLI ever rejected it — the union is open and the API is the
authority — so an older version already accepts it; this release adds the
autocomplete and the documentation.
