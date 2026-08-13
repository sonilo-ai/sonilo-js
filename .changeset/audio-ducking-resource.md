---
"sonilo": minor
"sonilo-cli": minor
---

Add audio ducking: `client.audioDucking.submit()/generate()` for POST /v1/audio-ducking (duck an existing music bed under a voice track; the voice may be a video, in which case the result is a re-muxed mp4), and the `sonilo audio-ducking` CLI command. The CLI rejects a local `--music` file that is not audio, since the API does not detect a video there.
