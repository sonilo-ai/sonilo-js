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

# Check an async task
sonilo tasks get <task-id>
sonilo tasks wait <task-id> --poll-interval 2000 --timeout 120000
```

Run `sonilo --help` for the full option list, including `--isolate-vocals` /
`--preserve-speech` for `video-to-music`, `--music-prompt` / `--sfx-prompt` /
`--no-ducking` for the `video-to-sound` commands, and the `--format` options
each command accepts.

`--format wav` (or `--isolate-vocals` / `--preserve-speech`) submits an async
task and polls it instead of streaming the response — matching how the
underlying [`sonilo`](https://www.npmjs.com/package/sonilo) SDK requires
`mode: "async"` for those options.

## Programmatic use

This package is a thin CLI wrapper. For direct API access from Node.js or the
browser, use the [`sonilo`](https://www.npmjs.com/package/sonilo) SDK instead.
