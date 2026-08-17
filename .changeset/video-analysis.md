---
"sonilo": minor
"sonilo-cli": minor
---

Add `client.videoAnalysis` and the `sonilo video-analysis` command, wrapping `POST /v1/video-analysis`.

video-analysis is the first Sonilo product whose result is not media: it generates nothing and there is no file to download. The result is a work order — a time-aligned `segments` plan plus one `prompt` per requested variation, each ready to hand straight to `videoToMusic`, `videoToSfx`, `videoToSound` or their video-to-video counterparts.

That shapes the surface in two places:

- the resource method is `analyze()`, not `generate()`, and `VideoAnalysisResult` carries no download helper — persisting the brief is the caller's business;
- the CLI prints the brief to stdout as JSON so it can be piped into the next command, and writes a file only when `--output` asks for one.

New exported types: `VideoAnalysisParams`, `VideoAnalysisResult`, `AnalysisSegment`, `AnalysisVariation`.
