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
  videoAudioOutlivesPicture: string;
  audioOnly: string;
  audioWithCoverArt: string;
  musicMp3: string;
  musicTooLong: string;
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
  // A video whose AUDIO TRACK OUTLIVES ITS PICTURE: 1 s of picture, 3 s of
  // audio (no -shortest). Routine in the wild — encoder padding produces it —
  // and the shape the ducking API's own comments cite (4 s picture / 10 s
  // audio) as an accepted input. ffprobe reports format.duration = 3.0 (the
  // max over all streams) but the video stream's own duration = 1.0, so any
  // code that bills, trims, or muxes on format.duration is working with the
  // wrong number.
  const videoAudioOutlivesPicture = join(dir, "audio_outlives_picture.mp4");
  run([
    "-f", "lavfi", "-i", "testsrc=duration=1:size=128x72:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    videoAudioOutlivesPicture,
  ]);
  // Audio-only, no video stream at all: a voiceover .m4a. The ducking API
  // accepts this as a voice input, so callers naturally hand it to us — but
  // there is no picture to mux back onto.
  const audioOnly = join(dir, "voice_only.m4a");
  run(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", audioOnly]);
  // Audio whose ONLY "video" stream is attached cover art (ffprobe:
  // codec_type=video, disposition.attached_pic=1) — an ordinary music/podcast
  // file with album art. It has a `videoCodec`, so a naive has-a-picture check
  // passes it, yet `-map 0:V` (capital V) excludes attached pictures and would
  // match no stream at all.
  const coverPng = join(dir, "cover.png");
  run(["-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-frames:v", "1", coverPng]);
  const audioWithCoverArt = join(dir, "cover_art.m4a");
  run([
    "-i", audioOnly, "-i", coverPng,
    "-map", "0:a", "-map", "1:v",
    "-c:a", "copy", "-c:v", "mjpeg",
    "-disposition:v:0", "attached_pic",
    audioWithCoverArt,
  ]);
  // 361 s of music — one second past the cap the API applies to the MUSIC
  // track too. Cheap: a low-sample-rate mono sine.
  const musicTooLong = join(dir, "music_too_long.mp3");
  run([
    "-f", "lavfi", "-i", "sine=frequency=220:duration=361:sample_rate=8000",
    "-ac", "1", "-c:a", "libmp3lame", "-b:a", "32k",
    musicTooLong,
  ]);
  return {
    videoWithAudio,
    videoSilent,
    videoSilentTrack,
    videoLongSilent,
    videoTooLong,
    videoAudioOutlivesPicture,
    audioOnly,
    audioWithCoverArt,
    musicMp3,
    musicTooLong,
    duckedWav,
  };
}
