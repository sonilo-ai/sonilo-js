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

# Generate a sound effect from a text prompt
sonilo text-to-sfx --prompt "glass bottle shattering on concrete" --duration 3

# Generate a sound effect matched to a video
sonilo video-to-sfx --video clip.mp4 --output foley.wav

# Generate a combined music + SFX track for a video (async only)
sonilo video-to-sound --video clip.mp4 --music-prompt "tense strings" --sfx-prompt "footsteps, distant thunder" --output mix.wav

# Same, but muxed back into the video
sonilo video-to-video-sound --video clip.mp4 --sfx-prompt "footsteps" --output scored.mp4

# Dub a video into other languages (async only, one file per language)
sonilo dubbing --video-url https://example.com/clip.mp4 --languages es,fr --output dubbed.mp4

# Check an async task
sonilo tasks get <task-id>
sonilo tasks wait <task-id> --poll-interval 2000 --timeout 120000
```

Run `sonilo --help` for the full option list, including `--isolate-vocals` /
`--preserve-speech` for `video-to-music`, `--music-prompt` / `--sfx-prompt` /
`--no-ducking` for the `video-to-sound` commands, `--languages` / `--timeout`
for `dubbing`, and the `--format` options each command accepts.

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

`--format wav` (or `--isolate-vocals` / `--preserve-speech`) submits an async
task and polls it instead of streaming the response — matching how the
underlying [`sonilo`](https://www.npmjs.com/package/sonilo) SDK requires
`mode: "async"` for those options.

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

## Programmatic use

This package is a thin CLI wrapper. For direct API access from Node.js or the
browser, use the [`sonilo`](https://www.npmjs.com/package/sonilo) SDK instead.
