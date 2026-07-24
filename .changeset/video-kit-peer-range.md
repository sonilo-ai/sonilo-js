---
"sonilo-video-kit": patch
---

Widen the `sonilo` peer range to `>=0.5.1 <1.0.0` so a minor release of the
core client no longer forces a major release here.

`sonilo` is still pre-1.0, so its minors are additive rather than breaking,
but the old `^0.5.1` range excluded every one of them. Combined with
changesets' default of majoring peer dependents on any peer bump, shipping
`sonilo@0.6.0` would have released this untouched package as `1.0.0` —
falsely signalling both a stable API and a breaking change. The repo's
changeset config now also sets `onlyUpdatePeerDependentsWhenOutOfRange`, so
peer dependents are only bumped when a release genuinely leaves their range.
