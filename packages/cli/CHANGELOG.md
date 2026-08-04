# sonilo-cli

## 0.9.2

### Patch Changes

- c8c8035: Follow the API's shorter 429 wording. The per-minute message now says "Please retry after 1 minute" instead of explaining the window inline, and both messages ask politely; the READMEs quote them verbatim, so they move together. The window explanation stays in the docs, where it belongs. No runtime change.
- Updated dependencies [c8c8035]
  - sonilo@0.11.2

## 0.9.1

### Patch Changes

- f925a8a: Document the two 429s. The API's rate-limit message now names which limit was hit — requests per minute or concurrent generations — and the two want opposite handling, so `RateLimitError` gets a README section explaining how to tell them apart and what each one means. No runtime change.
- Updated dependencies [f925a8a]
  - sonilo@0.11.1

## 0.9.0

### Minor Changes

- 2cf0fcd: Add `keepOriginalSound` to `videoToVideoMusic` and `videoToVideoSound`, and the
  matching `--keep-original-sound` flag to both CLI commands.

  The server flipped both endpoints' defaults: a request that does **not** set
  `keepOriginalSound` now returns the generated audio alone, where it previously
  returned the source video's speech with the generated music ducked underneath.
  `videoToVideoSound`'s default result therefore carries no `music_processed`
  stem, since with no voice source there is no processed track. That change is
  server-side and applies whether or not you upgrade — this release is what lets
  you opt back in.

  The two knobs are independent: `keepOriginalSound` picks the **voice source**
  (whole original track, or `preserveSpeech` for the isolated speech only) and
  `ducking` picks how it is **combined** with the generated audio (dynamic duck,
  or `ducking: false` for a static voice-forward mix). `keepOriginalSound`
  supersedes `preserveSpeech`; no combination is rejected.

  `keepOriginalSound` is video-only. `VideoToSoundParams` types it `never`, so
  passing it to `videoToSound` is a compile error rather than a field the server
  silently drops — the mirror of how `outputFormat` is kept off
  `videoToVideoSound`. The CLI rejects `--keep-original-sound` on `video-to-sound`
  for the same reason.

  `video-to-video-music` also gains `--no-ducking`, which the SDK already
  supported but the CLI never exposed. Without it the static-mix combination was
  unreachable from the command line.

### Patch Changes

- Updated dependencies [2cf0fcd]
  - sonilo@0.11.0

## 0.8.0

### Minor Changes

- 447bc10: Add `mp3` as an output container, expose `outputFormat` on `videoToSound`, and add `ducking` + `segments` to `videoToVideoMusic`.

  - `TextToMusicParams.outputFormat` and `VideoToMusicParams.outputFormat` now accept `"mp3"` (320 kbps) alongside `"m4a"` and `"wav"`. The async gate widened with them: any container other than the `m4a` default is a finalize-time transcode and requires `mode: "async"`, where the check previously named `"wav"` specifically. CLI `--format` accepts `mp3` on `text-to-music` and `video-to-music`, and anything but `m4a` now implies `--async`.
  - `videoToSound` gains `outputFormat` (`"wav"` default, or `"m4a"`/`"mp3"`), applying to the combined music + SFX track only — the `music` and `sfx` stems keep their native formats. `videoToVideoSound` does **not** take it: it always muxes the mix into an mp4. To make that a compile error rather than a value the server ignores, the params type split into `VideoToVideoSoundParams` (the base, now used by `videoToVideoSound`) and `VideoToSoundParams extends VideoToVideoSoundParams` (adds `outputFormat`). `VideoToVideoSoundParams` is newly exported. Passing `outputFormat` to `videoToVideoSound` no longer type-checks; every other usage is unchanged.
  - `videoToVideoMusic` gains `ducking` and `segments`. `ducking` is default-ON server-side, so it is omitted from the request when unset — pass `false` for music-only audio. `segments` takes the same `Segment[]` shape as `videoToMusic`.

  The `videoToVideoMusic` endpoint also changed behavior server-side: the returned video's audio now carries the source's speech with the generated music ducked under it, where it was previously music-only. Pass `ducking: false` to restore the old sound. Its input is now restricted to H.264, H.265/HEVC, VP9 or AV1 video (mp4/mov/m4v/webm) at up to 360 seconds, since the source picture is copied without re-encoding. Both are documented on the params type.

### Patch Changes

- Updated dependencies [447bc10]
  - sonilo@0.10.0

## 0.7.0

### Minor Changes

- 99ba0b6: Add the optional `ducking` boolean to dubbing (`DubbingParams.ducking`, CLI `--ducking`). Default off server-side: the background music/effects bed is always kept, at a constant level; pass `true` to duck it under the dubbed voice. Free parameter.

### Patch Changes

- Updated dependencies [99ba0b6]
  - sonilo@0.9.0

## 0.6.0

### Minor Changes

- 926195e: Add `variantsNum` (1-10, default 1) to generate several distinct music
  variants in one request: `textToMusic`, `videoToMusic`, `videoToVideoMusic`,
  `videoToSound` and `videoToVideoSound`. Cost scales linearly, and values
  above 1 are never covered by the free trial. On `textToMusic`/`videoToMusic`
  it requires `mode: "async"`, same as `outputFormat: "wav"` and
  `preserveSpeech`.

  Result envelopes gain per-variant data, strictly additive: `MusicMediaEntry`
  carries an optional `title`; `VideoResult` gains `videos[]` (`video` stays a
  permanent alias for `videos[0]`); `SoundResult` gains `outputs[]` (the
  existing top-level fields stay permanent aliases for `outputs[0]`); task
  results (`tasks.get`/`tasks.wait`) echo `variants_num` when it was above 1.
  These arrays are present even at the default `variantsNum` of 1, as a
  single-entry array.

  The CLI gains `--variants <n>` on the five affected commands. At the default
  of 1, every command still writes exactly one file; above 1, one file is
  written per variant, with the variant's index inserted before the extension
  (e.g. `--output track.wav --variants 3` writes `track.0.wav`, `track.1.wav`,
  `track.2.wav`).

### Patch Changes

- Updated dependencies [926195e]
  - sonilo@0.8.0

## 0.5.0

### Minor Changes

- f3e6785: Add the `video-to-video-music` and `video-to-video-sfx` commands, closing the
  last gap between the API's generation endpoints and the CLI. Both are async
  only and write a video: they submit the task, poll it, and save the re-hosted
  result (default `./output.mp4`). `video-to-video-music` takes `--prompt`,
  `--preserve-speech` and the legacy `--isolate-vocals`; `video-to-video-sfx`
  takes `--prompt` and `--segments` with the SFX shape `{start, end, prompt}`.

  Also fix the `video-to-music` help text, which listed `--isolate-vocals` and
  `--preserve-speech` as two independent options and described the former as
  splitting out a "vocals-only stem". They are one feature under two names — the
  API accepts either and ORs them — and this command writes only the main audio
  track, so `--isolate-vocals` is now documented as a legacy alias for
  `--preserve-speech` and no longer advertises a stem the CLI cannot hand back.

- f4b74b2: Add `--stem <name>` to `video-to-sound` and `video-to-video-sound`, matching
  the Python CLI. `video-to-sound` and `video-to-video-sound` return a combined
  render plus three individual layers (`music`, `music_processed`, `sfx`); the
  Node CLI previously wrote only the combined output and silently discarded the
  rest.

  `--stem` is repeatable — pass it once per layer you want saved — and each
  requested stem is written in addition to the combined output, never instead
  of it. The stem file is named from `--output` with `.<stem>` inserted before
  the extension, and that extension is taken from the stem's own result URL
  (falling back to the main output's extension when the stem URL has none):
  `--output mix.wav --stem music` writes `mix.wav` plus `mix.music.wav`.

  `music_processed` only exists on a result when `--preserve-speech` or
  ducking actually altered the music bed. Requesting it (or any other stem)
  when the result does not carry it now fails with a clear error naming the
  missing stem, instead of writing an empty file or exiting silently.

## 0.4.0

### Minor Changes

- 85bfca8: Add `--segments` to `text-to-music`, `video-to-music`, `video-to-sfx`, `video-to-sound` and `video-to-video-sound`, matching the structured parameter both SDKs already support. The flag accepts the same three forms as `curl`/`gh`/`aws`: inline JSON, `@path` to read a file, or `@-` to read stdin.

  The CLI validates only the shape of the value — that it parses as JSON, is a non-empty array of objects, and each object carries the right fields for the command's shape (`{start, prompt, label?}` for music, `{start, end, prompt}` for SFX). It does not replicate the API's semantic rules (segment ordering, spacing, the `label` enum, count limits), leaving those to the server's own validation. Passing segments shaped for the other kind of command is rejected immediately with a message naming the expected shape.

## 0.3.0

### Minor Changes

- 3d19e10: Add dubbing support. `client.dubbing.submit()` / `.generate()` call `POST /v1/dubbing`, dubbing one video into several target languages in a single async call. The result's `outputs` field maps each language code to a dubbed `.mp4` URL. The CLI gains a `sonilo dubbing` command that writes one file per language, and waits up to 1 hour by default (override with `--timeout <ms>`) instead of the SDK's generic 10-minute default, since the dubbing backend itself keeps trying for up to 2 hours.
- c0c559d: Make the free trial visible before it runs out, and distinguishable when it does.

  `TrialExhaustedError` is a new subclass of `PaymentRequiredError`, raised for
  the `402` whose body carries `code: "trial_exhausted"` — the free trial for
  that service is spent and the account has never been funded, so a retry can
  never succeed and the caller should ask for a payment method instead. Existing
  `catch (err) { if (err instanceof PaymentRequiredError) ... }` code keeps
  catching it unchanged; order the checks most-specific-first to tell it apart
  from a funded wallet that ran dry (`insufficient_balance`).

  `sonilo account` now prints a one-line free-trial summary
  (`Free trial: text-to-music 1/2 left, ...`) on stderr, leaving stdout as pure
  JSON so pipelines are unaffected. The line is omitted for accounts that have
  no trial allowance to report.

### Patch Changes

- Updated dependencies [3d19e10]
- Updated dependencies [c0c559d]
  - sonilo@0.7.0

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
