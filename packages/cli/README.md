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

# Generate music with per-segment prompts
sonilo text-to-music --duration 60 --async \
  --segments '[{"start":0,"prompt":"airy pads","label":"intro"},{"start":15,"prompt":"driving beat","label":"chorus"}]'

# Generate a sound effect from a text prompt
sonilo text-to-sfx --prompt "glass bottle shattering on concrete" --duration 3

# Generate a sound effect matched to a video
sonilo video-to-sfx --video clip.mp4 --output foley.wav

# Generate a combined music + SFX track for a video (async only)
sonilo video-to-sound --video clip.mp4 --music-prompt "tense strings" --sfx-prompt "footsteps, distant thunder" --output mix.wav

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

Run `sonilo --help` for the full option list, including `--preserve-speech` for
`video-to-music` and `video-to-video-music`, `--music-prompt` / `--sfx-prompt` /
`--no-ducking` for the `video-to-sound` commands, `--languages` / `--timeout`
for `dubbing`, and the `--format` options each command accepts.

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

`--format wav` (or `--preserve-speech` / `--isolate-vocals`) submits an async
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
