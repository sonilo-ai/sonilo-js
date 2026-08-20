# sonilo

## 0.16.1

### Patch Changes

- a9750db: Document dubbing's raised source-video cap: 300 seconds (5 min), up from 180. The limit is enforced by the API, so nothing in these packages gated on it — but the README and the CLI's `--help` both stated the old number, and a caller who believes it trims a video that would have been accepted.

## 0.16.0

### Minor Changes

- f1cc567: Add `stems` to `textToMusic` and `videoToMusic`, and the matching `--stems`
  flag to both CLI commands.

  `stems: true` also splits the generated track into four separated stems —
  `drums`, `bass`, `vocals`, `other`. It is free of charge. On `videoToMusic`
  it splits the GENERATED music, never the source video's own audio. It
  requires `mode: "async"` (the backend rejects it on the plain stream with a
  400), so it is only meaningful via `submit()`; `stream()`/`generate()` never
  send it, and on `videoToMusic` `submit()` auto-selects async, matching
  `preserveSpeech`/`ducking`.

  The task result gains two independent fields, typed on `MusicTaskResult`:
  `stems` (one `StemsEntry` — `{ stream_index, drums, bass, vocals, other }`,
  each stem an `SfxMedia` — per stream that separated successfully; look
  entries up by `stream_index`, never by position, since the array can be
  shorter than `audio`) and `stems_error` (why separation failed wholly or in
  part, or was skipped — it can appear ALONGSIDE a partial `stems` array, so
  its presence never means "no stems").

  Separation runs after generation and typically adds 2-6 minutes to the wait
  (giving up after 30), so raise `tasks.wait`'s timeout for stems runs. The CLI
  does this itself (`--stems` waits up to 40 minutes), writes each stem next to
  the main output with the stem name inserted before the extension (per variant
  above `--variants` 1), warns on a partial result, and fails only when no
  stems came back at all.

## 0.15.0

### Minor Changes

- a01f3fe: Add `client.videoAnalysis` and the `sonilo video-analysis` command, wrapping `POST /v1/video-analysis`.

  video-analysis is the first Sonilo product whose result is not media: it generates nothing and there is no file to download. The result is a work order — a time-aligned `segments` plan plus one `prompt` per requested variation, each ready to hand straight to `videoToMusic`, `videoToSfx`, `videoToSound` or their video-to-video counterparts.

  That shapes the surface in two places:

  - the resource method is `analyze()`, not `generate()`, and `VideoAnalysisResult` carries no download helper — persisting the brief is the caller's business;
  - the CLI prints the brief to stdout as JSON so it can be piped into the next command, and writes a file only when `--output` asks for one.

  New exported types: `VideoAnalysisParams`, `VideoAnalysisResult`, `AnalysisSegment`, `AnalysisVariation`.

## 0.14.0

### Minor Changes

- 3508487: Add audio ducking: `client.audioDucking.submit()/generate()` for POST /v1/audio-ducking (duck an existing music bed under a voice track; the voice may be a video, in which case the result is a re-muxed mp4), and the `sonilo audio-ducking` CLI command. The CLI rejects a local `--music` file that is not audio, since the API does not detect a video there.

## 0.13.0

### Minor Changes

- 2756e1e: Add `promptInfluence` to `videoToMusic` and `videoToVideoMusic`, and the
  matching `--prompt-influence` flag to both CLI commands.

  `promptInfluence` controls how strongly the generated music follows the prompt
  (0-1, API default 0.5). Lower values let the video lead; higher values follow
  the prompt more literally. It is free of charge.

  Left unset, nothing goes on the wire and the server's long-standing 0.5
  default applies — existing calls behave exactly as before. `0` is a meaningful
  value ("the video leads entirely") and is always sent, never dropped as falsy.

  It is a generation-time knob, not a finalize-time one, so on `videoToMusic` it
  works on the plain `stream()`/`generate()` path as well as `submit()` and
  never forces `mode: "async"`. It exists only on `videoToMusic` and
  `videoToVideoMusic` — not on the sound, SFX, text-to-music or dubbing
  endpoints. Out-of-range values are rejected server-side with a 422; the SDK
  does not pre-validate, matching `variantsNum`.

## 0.12.0

### Minor Changes

- 9e07bd3: Follow the API's `ducking` flip from default-on to default-off.

  The server now treats an unset `ducking` as off on `/v1/video-to-music`,
  `/v1/video-to-sound`, `/v1/video-to-video-music` and `/v1/video-to-video-sound`.
  Both packages already omitted the field when unset and still do, so the wire
  behaviour is unchanged — but everything that explained the old default was
  wrong, and on the CLI the only expressible direction was the one that no longer
  does anything.

  - `sonilo`: the `ducking` JSDoc on all four param types, the
    `videoToVideoMusic` request/audio table, and the README now describe
    default-off. Two notes that reasoned from the old default are corrected:
    `videoToSound.keepOriginalSound` is `never` because that endpoint reaches the
    original track through `ducking: true`, not because its default already kept
    the voice; and dubbing's `ducking` is no longer "the opposite of
    video-to-music's".
  - `sonilo-cli`: `video-to-sound`, `video-to-video-sound` and
    `video-to-video-music` gain `--ducking`. `--no-ducking` still parses and now
    sends an explicit `false` — removing it would have turned every script that
    passes it into an "unknown option" failure — and passing both fails rather
    than silently picking one.

  Callers of `videoToSound` who relied on the default should know it is the one
  endpoint where `ducking` picks the voice source as well as the mix: without it
  the source's own speech is no longer in the deliverable at all, and the result
  carries no `music_processed` stem.

## 0.11.2

### Patch Changes

- c8c8035: Follow the API's shorter 429 wording. The per-minute message now says "Please retry after 1 minute" instead of explaining the window inline, and both messages ask politely; the READMEs quote them verbatim, so they move together. The window explanation stays in the docs, where it belongs. No runtime change.

## 0.11.1

### Patch Changes

- f925a8a: Document the two 429s. The API's rate-limit message now names which limit was hit — requests per minute or concurrent generations — and the two want opposite handling, so `RateLimitError` gets a README section explaining how to tell them apart and what each one means. No runtime change.

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
