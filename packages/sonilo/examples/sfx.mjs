// Generate a sound effect from text and save it locally.
// Usage: SONILO_API_KEY=sk_... node examples/sfx.mjs
import { writeFile } from "node:fs/promises";
import { SoniloClient, download } from "sonilo";

const client = new SoniloClient();
const result = await client.textToSfx.generate({
  prompt: "glass shattering on a stone floor",
  duration: 5,
});
const bytes = await download(result.audio);
await writeFile("sfx.m4a", bytes);
console.log(`Saved sfx.m4a (${bytes.length} bytes)`);
