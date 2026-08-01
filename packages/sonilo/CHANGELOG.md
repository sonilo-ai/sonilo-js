# sonilo

## 0.11.0

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

## 0.10.0

### Minor Changes

- 447bc10: Add `mp3` as an output container, expose `outputFormat` on `videoToSound`, and add `ducking` + `segments` to `videoToVideoMusic`.

  - `TextToMusicParams.outputFormat` and `VideoToMusicParams.outputFormat` now accept `"mp3"` (320 kbps) alongside `"m4a"` and `"wav"`. The async gate widened with them: any container other than the `m4a` default is a finalize-time transcode and requires `mode: "async"`, where the check previously named `"wav"` specifically. CLI `--format` accepts `mp3` on `text-to-music` and `video-to-music`, and anything but `m4a` now implies `--async`.
  - `videoToSound` gains `outputFormat` (`"wav"` default, or `"m4a"`/`"mp3"`), applying to the combined music + SFX track only — the `music` and `sfx` stems keep their native formats. `videoToVideoSound` does **not** take it: it always muxes the mix into an mp4. To make that a compile error rather than a value the server ignores, the params type split into `VideoToVideoSoundParams` (the base, now used by `videoToVideoSound`) and `VideoToSoundParams extends VideoToVideoSoundParams` (adds `outputFormat`). `VideoToVideoSoundParams` is newly exported. Passing `outputFormat` to `videoToVideoSound` no longer type-checks; every other usage is unchanged.
  - `videoToVideoMusic` gains `ducking` and `segments`. `ducking` is default-ON server-side, so it is omitted from the request when unset — pass `false` for music-only audio. `segments` takes the same `Segment[]` shape as `videoToMusic`.

  The `videoToVideoMusic` endpoint also changed behavior server-side: the returned video's audio now carries the source's speech with the generated music ducked under it, where it was previously music-only. Pass `ducking: false` to restore the old sound. Its input is now restricted to H.264, H.265/HEVC, VP9 or AV1 video (mp4/mov/m4v/webm) at up to 360 seconds, since the source picture is copied without re-encoding. Both are documented on the params type.

## 0.9.0

### Minor Changes

- 99ba0b6: Add the optional `ducking` boolean to dubbing (`DubbingParams.ducking`, CLI `--ducking`). Default off server-side: the background music/effects bed is always kept, at a constant level; pass `true` to duck it under the dubbed voice. Free parameter.

## 0.8.0

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

## 0.7.0

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

## 0.6.0

### Minor Changes

- d64b524: Add the `trial` field to `AccountServices`, mirroring the API's free-trial
  quota on `GET /v1/account/services`.

  Integrations previously had no way to see a free trial running out: the only
  signal was a `402` on the next generation call, so a newly signed-up developer
  hit a hard failure instead of a prompt to add a payment method. `trial` now
  reports `granted` / `used` / `remaining` per service, so callers can degrade
  gracefully before the trial is spent.

  The field is optional: the API returns it only for self-serve accounts and
  omits the key entirely otherwise, so consumers must treat it as possibly
  absent. The new `TrialQuota` type is exported from the package entrypoint.

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
