---
"sonilo": patch
"sonilo-cli": patch
---

Document Tamil, Malayalam, Kannada, Gujarati, Punjabi and Sindhi as dubbing targets.

`ta`, `ml`, `kn`, `gu`, `pa_in` and `sd_in` join `DubbingLanguage`, the README
and `sonilo dubbing --help`. Nothing in the SDK or CLI ever rejected them — the
union is open and the API is the authority — so an older version already
accepts them; this release adds the autocomplete and the documentation.
`pa_in` and `sd_in` carry the region because only the Indian variant of each
is available.
