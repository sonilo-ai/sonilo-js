# sonilo-cli

Command-line interface for the [Sonilo](https://sonilo.com) API — generate
music and sound effects from your terminal without writing any code.

## Installation

```bash
npm install -g sonilo-cli
```

Or run it without installing:

```bash
npx sonilo-cli account
```

## Signing in

```bash
sonilo login    # opens your browser to approve this device
sonilo whoami   # show which account and key are currently active
sonilo logout   # revoke the stored key and forget it locally
```

`sonilo login` stores a credential in `~/.config/sonilo/credentials.json`
(override the directory with `XDG_CONFIG_HOME`), and every command picks it up
automatically — no key to paste or export.

Credentials are resolved in this order: `--api-key`, then `SONILO_API_KEY`,
then the stored credential from `sonilo login`. CI and other non-interactive
environments should keep using `SONILO_API_KEY`.

## Authentication

```bash
export SONILO_API_KEY=sk-...
```

Or pass `--api-key sk-...` on any command.

## Usage

```bash
# Plan limits and available services
sonilo account

# Usage summary (defaults to the last 30 days)
sonilo usage --days 7

# Generate music from a text prompt
sonilo text-to-music --prompt "warm lo-fi piano, rain in the background" --duration 30

# Generate music matched to a video
sonilo video-to-music --video clip.mp4 --prompt "tense, driving synths" --output score.wav --format wav

# Generate music with per-segment prompts
sonilo text-to-music --duration 60 --async \
  --segments '[{"start":0,"prompt":"airy pads","label":"intro"},{"start":15,"prompt":"driving beat","label":"chorus"}]'

# Generate 3 distinct variants in one call (forces --async); writes
# track.0.wav, track.1.wav, track.2.wav
sonilo text-to-music --prompt "warm lo-fi piano" --duration 30 --variants 3 --output track.wav

# Generate a sound effect from a text prompt
sonilo text-to-sfx --prompt "glass bottle shattering on concrete" --duration 3

# Generate a sound effect matched to a video
sonilo video-to-sfx --video clip.mp4 --output foley.wav

# Generate a combined music + SFX track for a video (async only)
sonilo video-to-sound --video clip.mp4 --music-prompt "tense strings" --sfx-prompt "footsteps, distant thunder" --output mix.wav

# Same, but also save the individual music and SFX stems (repeatable --stem)
sonilo video-to-sound --video clip.mp4 --sfx-prompt "footsteps" --output mix.wav --stem music --stem sfx

# Same, but muxed back into the video
sonilo video-to-video-sound --video clip.mp4 --sfx-prompt "footsteps" --output scored.mp4

# Score a video and get the video back with the music muxed in (async only)
sonilo video-to-video-music --video clip.mp4 --prompt "tense, driving synths" --output scored.mp4

# Add sound effects and get the video back with them muxed in (async only)
sonilo video-to-video-sfx --video clip.mp4 --prompt "footsteps, distant thunder" --output foley.mp4

# Dub a video into other languages (async only, one file per language)
sonilo dubbing --video-url https://example.com/clip.mp4 --languages es,fr --output dubbed.mp4

# Check an async task
sonilo tasks get <task-id>
sonilo tasks wait <task-id> --poll-interval 2000 --timeout 120000
```

Run `sonilo --help` for the full option list, including `--preserve-speech` and
`--prompt-influence` for `video-to-music` and `video-to-video-music`
(`--prompt-influence <0-1>` sets how strongly the music follows the prompt —
API default 0.5, lower lets the video lead, free of charge), `--music-prompt` /
`--sfx-prompt` / `--ducking` / `--stem` for the `video-to-sound` commands,
`--languages` / `--timeout` for `dubbing`, `--variants` for the five commands
that take it, and the `--format` options each command accepts. Music commands take `m4a`
(default), `wav` or `mp3` (320 kbps); anything but `m4a` implies `--async`.

`video-to-sound` and `video-to-video-sound` return a combined render plus
three individual layers — `music`, `music_processed`, and `sfx`. `--stem` (one
of those three names) saves a layer alongside the combined output instead of
discarding it; pass it more than once to save several. The file is named from
`--output` with the stem inserted before the extension, and the extension
itself comes from that stem's own result — not necessarily the same container
as the combined output:

```bash
sonilo video-to-sound --video clip.mp4 --output mix.wav --stem music --stem sfx
# writes mix.wav (combined), plus mix.music.<ext> and mix.sfx.<ext>,
# each <ext> taken from that stem's own file (falls back to .wav when the
# stem's URL carries no extension of its own)
```

`music_processed` only exists on the result when `--preserve-speech` or
ducking actually altered the music bed; requesting it when the result doesn't
carry it fails with a clear error rather than writing an empty file.

`--isolate-vocals` is a legacy alias for `--preserve-speech`, not a second
option: the API accepts either name and ORs them into one behaviour, so passing
both is the same as passing one.

The four video-out commands — `video-to-video-sound`, `video-to-video-music`,
`video-to-video-sfx` and `dubbing` — write a video rather than an audio file,
so they take no `--format` and default `--output` to `./output.mp4`. All of
them are async only: the CLI submits the task, prints its id, and polls until
it finishes.

## Segments

`text-to-music`, `video-to-music`, `video-to-sfx`, `video-to-video-sfx`,
`video-to-sound` and `video-to-video-sound` accept `--segments`, a JSON array
of per-segment prompts, in three forms — the curl / gh / aws convention:

```bash
--segments '[{"start":0,"prompt":"airy pads","label":"intro"}]'   # inline JSON
--segments @segments.json                                          # read from a file
--segments @-                                                      # read from stdin
```

A value starting with `@` names a source to read from (`@-` means stdin);
anything else is parsed as JSON directly. The required fields differ by
command:

- `text-to-music` / `video-to-music` take `{start, prompt, label?}`.
- `video-to-sfx` / `video-to-video-sfx` / `video-to-sound` /
  `video-to-video-sound` take `{start, end, prompt}`.

The CLI only checks this shape — that the value is valid JSON, a non-empty
array of objects, and each object carries the right fields with the right
types. It does not replicate the API's own rules (the first segment starting
at 0, minimum spacing between segments, the `label` enum, segment-count
limits): those are enforced server-side and returned as a `422` if violated.
If a command is given segments shaped for the other kind (e.g. SFX-shaped
`{start, end, prompt}` passed to `video-to-music`), the CLI rejects it
immediately and names the shape it expected, since that mismatch is a common
copy-paste mistake.

`dubbing` differs from the other commands in three ways worth knowing before
you run it:

- `--output` is a filename **template**, not a single destination: a dubbing
  task returns one video per language, so `--output clip.mp4` writes
  `clip.es.mp4`, `clip.fr.mp4`, and so on.
- Billing is **per language** — a three-language call costs three times a
  one-language call — and `dubbing` has **no free trial runs** at all (see
  [Free trial](#free-trial) below).
- `--timeout` defaults to 7200000 ms (2 hours), matching the backend's own
  ceiling for a dubbing job. If the wait still times out the task keeps
  running server-side — resume watching it with `sonilo tasks wait <task-id>`.

a non-`m4a` `--format` (or `--preserve-speech` / `--isolate-vocals` / `--variants`
above 1) submits an async task and polls it instead of streaming the
response — matching how the underlying
[`sonilo`](https://www.npmjs.com/package/sonilo) SDK requires
`mode: "async"` for those options.

## Variants

`--variants <n>` generates several distinct variants in one request (1-10,
default 1) — each is its own creative direction. It's available on
`text-to-music`, `video-to-music`, `video-to-video-music`, `video-to-sound`
and `video-to-video-sound`. Cost scales linearly with the count, and **values
above 1 are never covered by the free trial**.

At the default of 1, every command writes exactly the single file it always
has. Above 1, one file is written per variant — the `--output` path with the
variant's index inserted before the extension:

```bash
sonilo text-to-music --prompt "warm lo-fi piano" --duration 30 --variants 3 --output track.wav
# writes track.0.wav, track.1.wav, track.2.wav

sonilo video-to-video-music --video clip.mp4 --variants 2 --output scored.mp4
# writes scored.0.mp4, scored.1.mp4

sonilo video-to-sound --video clip.mp4 --variants 2 --output mix.wav --stem music
# writes mix.0.wav, mix.1.wav, plus mix.0.music.wav, mix.1.music.wav
```

On `text-to-music` / `video-to-music`, `--variants` above 1 forces `--async` —
same as a non-`m4a` `--format` and `--preserve-speech` — since the plain streaming
response can only ever carry one track. `video-to-video-music`,
`video-to-sound` and `video-to-video-sound` are already async-only, so
`--variants` needs no extra flag there.

## Free trial

`sonilo account` prints the account JSON on stdout and, when the account has
a free-trial allowance, one summary line on stderr:

```
Free trial: text-to-music 1/2 left, video-to-music 0/1 left
```

Because the summary goes to stderr, `sonilo account | jq .trial` still sees
clean JSON. Once a service shows `0` left, calls to it fail with
`HTTP 402: ... (trial_exhausted)` until a payment method is added — that is
the only 402 a retry can never fix.

**`dubbing` never appears in that summary: it has zero free runs and bills
from the very first call.** This is deliberate — dubbing charges `video
duration × number of languages`, so a single free run on it would be worth
far more than the free allowance on every other command combined.

## Rate limits

Two separate limits return `HTTP 429`, and they want opposite handling. The
CLI prints the API's own sentence, so the wording says which one you hit:

```
sonilo: HTTP 429: Rate limit exceeded: your account allows 60 requests per minute. Please retry after 1 minute. To raise your limit, please contact info@sonilo.com. (rate_limit_exceeded)
sonilo: HTTP 429: Too many concurrent generations: 5 of 5 in progress. Please wait for one to finish before starting another. To raise your limit, please contact info@sonilo.com. (rate_limit_exceeded)
```

The first means calls are going out too fast. The counter runs on a fixed
60-second window and rejected calls count toward it too, so wait the window
out instead of retrying inside it. The second means every generation slot is
busy — waiting alone frees nothing, a running generation has to finish first.

`sonilo account` prints the account's own `rpm_limit` and
`concurrency_limit`; the numbers above are the standard-tier defaults. Email
info@sonilo.com to raise either.

## Programmatic use

This package is a thin CLI wrapper. For direct API access from Node.js or the
browser, use the [`sonilo`](https://www.npmjs.com/package/sonilo) SDK instead.
