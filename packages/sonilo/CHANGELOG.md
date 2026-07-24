# sonilo

## 0.5.1

### Patch Changes

- 38cdfa2: Let wrappers identify themselves in `X-Sonilo-Client`

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

## 0.5.0

### Minor Changes

- 2be192e: Add `videoToSound` and `videoToVideoSound` for the combined music + sound-effects
  endpoints, with the `SoundResult` type carrying the mixed `output_url` and the
  `music` / `music_processed` / `sfx` stems. `download()` now also accepts a bare
  URL string.

## 0.4.0

### Minor Changes

- 23b67f1: Add `videoToVideoMusic` and `videoToVideoSfx` resources (async video-output endpoints). Add `preserveSpeech`, `outputFormat`, and `ducking` to `videoToMusic.submit`, `mode`/`outputFormat` + async `submit()` to `textToMusic`, and a `ducked` field on music results. Fix the client version header (was 0.2.0).
