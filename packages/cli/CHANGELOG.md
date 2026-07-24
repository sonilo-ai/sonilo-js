# sonilo-cli

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
