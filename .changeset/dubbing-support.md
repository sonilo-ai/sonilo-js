---
"sonilo": minor
"sonilo-cli": minor
---

Add dubbing support. `client.dubbing.submit()` / `.generate()` call `POST /v1/dubbing`, dubbing one video into several target languages in a single async call. The result's `outputs` field maps each language code to a dubbed `.mp4` URL. The CLI gains a `sonilo dubbing` command that writes one file per language.
