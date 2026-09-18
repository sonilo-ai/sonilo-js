---
"sonilo": minor
"sonilo-cli": minor
---

video-analysis: add the `mode` parameter (`both` | `music` | `sfx`, server default `both`). In `both` mode the result also carries a sound-design brief as `sfx_segments` and a single `sfx_prompt`, and the result echoes `mode`; the CLI's JSON brief includes all three when present and takes `--mode`. `mode: "music"` reproduces the previous result shape. Max video duration is now 480 seconds. Price unchanged.
