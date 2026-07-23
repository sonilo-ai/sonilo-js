---
"sonilo": patch
"sonilo-cli": patch
"sonilo-video-kit": patch
---

Let wrappers identify themselves in `X-Sonilo-Client`

The CLI and video kit build on the SDK, so every call they made reported as
`sdk-js` — making their traffic indistinguishable from direct SDK use in
server-side analytics, with no way to recover the split retroactively.

`SoniloClientOptions` now takes optional `clientName`/`clientVersion`,
defaulting to `sdk-js` and the SDK version. The CLI sends `cli-js` and the
video kit sends `videokit-js`. A caller-supplied client keeps its owner's
identity; only the kit's internally constructed default clients are tagged.

Also fixes two version bugs found along the way: `version.ts` had drifted to
`0.4.0` while the package was `0.5.0`, so every request under-reported the SDK
version; and `sonilo --version` printed the SDK's version rather than the
CLI's. Both constants are now generated from `package.json` by
`scripts/sync-versions.mjs`, chained onto the `version` script so changesets
cannot bump one without the other.
