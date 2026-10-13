# AGENTS.md

Notes for coding agents working in this monorepo, and for agents writing code
against the Sonilo JavaScript packages.

## What this repo is

npm workspaces monorepo with three published packages:

| Package | Path | What it is |
|---|---|---|
| `sonilo` | `packages/sonilo` | TypeScript client for the Sonilo API. Zero runtime dependencies, Node.js 18+ and browsers |
| `sonilo-cli` | `packages/cli` | `sonilo` command line tool, built on `sonilo` |
| `sonilo-video-kit` | `packages/sonilo-video-kit` | Node-only helpers that generate a soundtrack and mix it into a video with local ffmpeg |

The Python counterparts live in
[sonilo-python](https://github.com/sonilo-ai/sonilo-python).

## Layout

```
packages/sonilo/src/client.ts        SoniloClient: auth, base URL, timeout, request()
packages/sonilo/src/resources/*.ts   one class per endpoint (textToMusic, videoToSfx, dubbing, ...)
packages/sonilo/src/errors.ts        error classes, mapped from HTTP status and the API `code`
packages/sonilo/src/types.ts         request and result types
packages/cli/src/cli.ts              every CLI command
packages/cli/src/login.ts            `sonilo login` device flow; credentials.ts reads/writes the file
packages/sonilo-video-kit/src/       generate, mix, duck, loudness, ffmpeg wrappers
packages/*/src/version.ts            generated, do not edit
scripts/sync-versions.mjs            writes version.ts from each package.json
.changeset/                          pending release notes
```

## Commands

Node 22 in CI. `sonilo-video-kit` tests need `ffmpeg` and `ffprobe` on PATH.

```bash
npm ci
npm run lint    # builds sonilo, then tsc --noEmit in every package
npm run build   # sonilo, then sonilo-video-kit, then sonilo-cli
npm test        # builds sonilo, then vitest run in every package
```

CI (`.github/workflows/ci.yml`) runs exactly these on every PR. Run one
package with `npm test -w sonilo` (or `-w sonilo-cli`, `-w sonilo-video-kit`);
build `sonilo` first, since the other two import its `dist`.

## Making changes

- Every user-facing change needs a changeset: `npx changeset`, pick the
  packages and the bump. Do not edit `version` in `package.json` or any
  `version.ts` by hand. On merge to `main` the Release workflow opens a
  "Version Packages" PR; merging that publishes to npm.
- New endpoint: add a resource class under `packages/sonilo/src/resources/`,
  register it in `client.ts`, export its types from `index.ts`, add a test,
  document it in `packages/sonilo/README.md`, then add the CLI command if it
  produces a result a user would run from a terminal.
- Use the API's field names in requests (`video_url`, `variants_num`) and
  camelCase in the TypeScript params (`videoUrl`, `variantsNum`).
- Branch on the API's error `code`, never on message text.
- Keep `sonilo` free of runtime dependencies.
- Wrappers pass `clientName` / `clientVersion` so their traffic is reported
  in the `X-Sonilo-Client` header; direct SDK use leaves them unset.

## Using the SDK

Get an `sk-` key at https://platform.sonilo.com/dashboard/api-keys and set
`SONILO_API_KEY`, or pass `apiKey`. The CLI also accepts the credential from
`sonilo login` (a 90-day key in `~/.config/sonilo/credentials.json`).

```ts
import { SoniloClient, download } from "sonilo";

const sonilo = new SoniloClient(); // reads SONILO_API_KEY; baseUrl defaults to https://api.sonilo.com

// Music streams back as bytes
const track = await sonilo.videoToMusic.generate({ video: "./clip.mp4", prompt: "warm, hopeful" });

// Task-based endpoints: generate() submits and waits; submit() returns { task_id }
const sfx = await sonilo.textToSfx.generate({ prompt: "glass shattering on stone", duration: 5 });
const bytes = await download(sfx.audio);

const task = await sonilo.videoToSound.submit({ videoUrl: "https://example.com/clip.mp4" });
const result = await sonilo.tasks.wait(task.task_id);
```

Resources on the client: `textToMusic`, `videoToMusic`, `textToSfx`,
`videoToSfx`, `videoToVideoMusic`, `videoToVideoSfx`, `videoToSound`,
`videoToVideoSound`, `videoAnalysis`, `audioDucking`, `dubbing`, `proofread`,
`tasks`, `account`.

CLI equivalents: `sonilo text-to-music`, `video-to-music`, `text-to-sfx`,
`video-to-sfx`, `video-to-sound`, `video-to-video-*`, `audio-ducking`,
`video-analysis`, `dubbing`, `proofread`, `tasks get|wait`, `account`,
`usage`, `login`, `whoami`, `logout`.

Video length caps (422 before any charge): music 360 s; SFX, sound and video
analysis 480 s; audio ducking 360 s per input; dubbing and proofread 300 s.

## Errors

| Class | Status / code | What to do |
|---|---|---|
| `AuthenticationError` | 401 | Key invalid, revoked or expired; replace it or `sonilo login` again |
| `TrialExhaustedError` | 402 `trial_exhausted` | Free runs for that service are spent; add a payment method at https://platform.sonilo.com/dashboard/billing. Retrying cannot help |
| `PaymentRequiredError` | 402 `insufficient_balance`, `payment_required` | Top up, then retry |
| `BadRequestError` | 400 / 413 / 422 | Async-only option without async, file too large, over a length cap, bad `segments` |
| `RateLimitError` | 429 `rate_limit_exceeded` | RPM limit: wait a full minute. Concurrency limit: wait for a running task |
| `TaskFailedError` | task `failed` | `.code`, `.refunded`; failed generations are refunded |
| `TaskTimeoutError` | | Still running and already charged; call `tasks.wait(err.taskId)` again instead of resubmitting |
| `RequestTimeoutError` | | One-shot request or `download()` hit the client `timeout` (default 600000 ms) |

`TrialExhaustedError` extends `PaymentRequiredError`, so check it first.
