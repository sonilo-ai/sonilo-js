// Generate a soundtrack for a video that already has dialogue, then duck the
// music under the speech.
//
//   SONILO_API_KEY=sk_... node examples/duck-video.mjs ./clip.mp4
//
// The video must have an audio track and run no longer than 360 s. Ducking runs
// on the Sonilo API and is billed on the video's duration.
import { generateMusicForVideo, duckMusicUnderSpeech } from "../dist/index.js";

const video = process.argv[2] ?? "./clip.mp4";

const track = await generateMusicForVideo(video, {
  prompt: "warm, understated bed for a talking-head interview",
});

const output = await duckMusicUnderSpeech({
  video,
  audio: track.audio,
  output: "./clip.ducked.mp4",
});

console.log(`Wrote ${output}`);
