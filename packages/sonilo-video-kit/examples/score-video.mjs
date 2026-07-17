// Usage: SONILO_API_KEY=sk_... node examples/score-video.mjs ./clip.mp4 "upbeat, energetic"
import { generateMusicForVideo, mixWithVideo } from "../dist/index.js";

const [video, prompt = "cinematic score"] = process.argv.slice(2);
if (!video) {
  console.error("usage: node examples/score-video.mjs <video.mp4> [prompt]");
  process.exit(1);
}

const track = await generateMusicForVideo(video, { prompt });
console.log(`Generated ${track.audio.length} bytes${track.title ? ` — "${track.title}"` : ""}`);

const output = video.replace(/(\.[^.]+)?$/, ".scored.mp4");
await mixWithVideo({ video, audio: track.audio, output });
console.log(`Saved ${output}`);
