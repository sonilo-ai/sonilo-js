// Usage: SONILO_API_KEY=sk_... node examples/generate.mjs "lofi beat" 30
import { writeFile } from "node:fs/promises";
import { SoniloClient } from "../dist/index.js";

const [prompt = "cinematic orchestral score", duration = "60"] = process.argv.slice(2);
const sonilo = new SoniloClient();

const track = await sonilo.textToMusic.generate({
  prompt,
  duration: Number(duration),
});
await writeFile("output.mp3", track.audio);
console.log(`Saved output.mp3 (${track.audio.length} bytes)${track.title ? ` — "${track.title}"` : ""}`);
