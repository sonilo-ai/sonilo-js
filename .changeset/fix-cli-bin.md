---
"sonilo-cli": patch
---

Fix the bin entrypoint never running under a real install

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
