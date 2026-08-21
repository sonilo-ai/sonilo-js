---
"sonilo": patch
"sonilo-cli": patch
---

Document video analysis's lowered source-video cap: 360 seconds (6 min), down from 600. The limit is enforced by the API, so nothing in these packages gated on it — but 600 was never a real limit there either: a shared 360-second probe ceiling rejected every longer source before the endpoint's own check ran, so a caller who believed the old number was sending uploads the API was always going to refuse.
