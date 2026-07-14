import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

function run(args: string[]): void {
  const res = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`fixture ffmpeg failed: ${res.stderr}`);
  }
}

/** Generate tiny test media with lavfi: 1 s test video (with and without an
 * audio track) and a 2 s sine-wave MP3 standing in for generated music. */
export async function makeFixtures(dir: string): Promise<{
  videoWithAudio: string;
  videoSilent: string;
  videoSilentTrack: string;
  videoLongSilent: string;
  videoTooLong: string;
  musicMp3: string;
  duckedWav: string;
}> {
  const videoWithAudio = join(dir, "with_audio.mp4");
  const videoSilent = join(dir, "silent.mp4");
  const videoSilentTrack = join(dir, "silent_track.mp4");
  const videoLongSilent = join(dir, "long_silent.mp4");
  const musicMp3 = join(dir, "music.mp3");
  run([
    "-f", "lavfi", "-i", "testsrc=duration=1:size=128x72:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    videoWithAudio,
  ]);
  run([
    "-f", "lavfi", "-i", "testsrc=duration=1:size=128x72:rate=10",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
    videoSilent,
  ]);
  run([
    "-f", "lavfi", "-i", "testsrc=duration=1:size=128x72:rate=10",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    videoSilentTrack,
  ]);
  run([
    "-f", "lavfi", "-i", "testsrc=duration=4:size=128x72:rate=10",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
    videoLongSilent,
  ]);
  run(["-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-c:a", "libmp3lame", musicMp3]);
  const duckedWav = join(dir, "ducked.wav");
  run(["-f", "lavfi", "-i", "sine=frequency=330:duration=1", duckedWav]);
  // 361 s — one second past the ducking API's 360 s cap. Kept cheap: 1 fps at
  // 64x36. It carries an audio track so the duration guard is what rejects it,
  // not the missing-audio guard.
  const videoTooLong = join(dir, "too_long.mp4");
  run([
    "-f", "lavfi", "-i", "testsrc=duration=361:size=64x36:rate=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=361",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    videoTooLong,
  ]);
  return {
    videoWithAudio,
    videoSilent,
    videoSilentTrack,
    videoLongSilent,
    videoTooLong,
    musicMp3,
    duckedWav,
  };
}
