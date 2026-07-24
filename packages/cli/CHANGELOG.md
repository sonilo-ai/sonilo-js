# sonilo-cli

## 0.2.2

### Patch Changes

- 3235b48: Widen the `sonilo` dependency range to `>=0.5.1 <1.0.0` so the CLI picks up
  minor releases of the core client.

  The old `^0.5.1` range excluded every 0.x minor, so `sonilo@0.6.0` and later
  would never have been installed for CLI users — the CLI would have stayed
  pinned to 0.5.x and silently missed new API surface. Unlike the video kit's
  peer dependency this never produced a wrong version number, only a stale
  install.

- Updated dependencies [d64b524]
  - sonilo@0.6.0

## 0.2.1

### Patch Changes

- 6602bc5: Fix the bin entrypoint never running under a real install

  `sonilo-cli@0.2.0` was inert: every command exited 0 with no output. The
  entrypoint guard compared `import.meta.url` against `` `file://${process.argv[1]}` ``,
  but npm installs a bin as a symlink (`node_modules/.bin/sonilo` ->
  `../sonilo-cli/dist/cli.js`), so `argv[1]` is the link while `import.meta.url`
  is already resolved. The two never matched and `main()` was never called.

  Both sides are now resolved with `realpathSync` and compared as file URLs via
  `pathToFileURL`, which also fixes paths containing spaces.

  The existing tests all import the `run*` functions directly, so none of them
  ever executed the entrypoint. Added tests that run the built file the way a
  user gets it — directly, and through a symlink.

## 0.2.0

### Minor Changes

- 46b68d4: Initial release: `sonilo-cli`, a command-line interface for the Sonilo API. Covers account/usage, text-to-music, video-to-music, text-to-sfx, video-to-sfx, video-to-sound, video-to-video-sound, and task polling — install with `npm install -g sonilo-cli`.

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

- Updated dependencies [38cdfa2]
  - sonilo@0.5.1
