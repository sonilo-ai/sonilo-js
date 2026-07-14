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
  videoAudioOutlivesPictureMkv: string;
  videoAudioOutlivesPictureWebm: string;
  videoLongPictureLongerAudioMkv: string;
  audioOnly: string;
  audioWithCoverArt: string;
  videoWithCoverArt: string;
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
  // The SAME shape (1 s of picture, 3 s of audio) in Matroska and WebM.
  //
  // These are not redundant with the .mp4 above: Matroska and WebM never emit a
  // per-stream `duration` FIELD at all. A probe that falls back to the
  // container's format.duration when the field is missing therefore reads 3.0 s
  // -- the AUDIO's length -- for 100% of MKV/WebM files, which is precisely the
  // number that must never reach the billing/trim path. (The picture's real
  // length is in the stream's `tags.DURATION`, "00:00:01.000000000".)
  //
  // Kept cheap: 128x72 at 10 fps, and vp9 at `-deadline realtime -cpu-used 8`
  // (10 frames; ~40 ms).
  const videoAudioOutlivesPictureMkv = join(dir, "audio_outlives_picture.mkv");
  run([
    "-f", "lavfi", "-i", "testsrc=duration=1:size=128x72:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    videoAudioOutlivesPictureMkv,
  ]);
  const videoAudioOutlivesPictureWebm = join(dir, "audio_outlives_picture.webm");
  run([
    "-f", "lavfi", "-i", "testsrc=duration=1:size=128x72:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-deadline", "realtime", "-cpu-used", "8",
    "-c:a", "libopus",
    videoAudioOutlivesPictureWebm,
  ]);
  // A LEGAL video the cap guard must not reject: 350 s of picture (under the
  // API's 360 s limit, and the only figure the backend gates on) under 365 s of
  // audio (over it). The backend accepts exactly this -- audio_ducking.py gates
  // on the video stream's duration, and its comments cite a real 358 s picture /
  // 361 s audio case. A guard reading the container's duration instead reports
  // "runs 365.0s" and refuses a video the API would have taken. Matroska,
  // because that is where the missing per-stream duration bites. Cheap: 1 fps at
  // 64x36, 8 kHz mono audio.
  const videoLongPictureLongerAudioMkv = join(dir, "long_picture_longer_audio.mkv");
  run([
    "-f", "lavfi", "-i", "testsrc=duration=350:size=64x36:rate=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=365:sample_rate=8000",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "32k",
    videoLongPictureLongerAudioMkv,
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
  // A REAL video that ALSO carries attached cover art (an iTunes/M4V export, a
  // podcast episode with an episode thumbnail): a genuine h264 picture, an aac
  // track, AND a `disposition.attached_pic=1` mjpeg stream. This is the file
  // that tells `-map 0:V` apart from `-map 0:v`: capital V selects only the
  // real picture, lowercase drags the cover art into the deliverable as a
  // second video stream.
  const videoWithCoverArt = join(dir, "video_cover_art.mp4");
  run([
    "-i", videoWithAudio, "-i", coverPng,
    "-map", "0:v:0", "-map", "0:a:0", "-map", "1:v:0",
    "-c:v:0", "copy", "-c:a", "copy", "-c:v:1", "mjpeg",
    "-disposition:v:1", "attached_pic",
    videoWithCoverArt,
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
    videoAudioOutlivesPictureMkv,
    videoAudioOutlivesPictureWebm,
    videoLongPictureLongerAudioMkv,
    audioOnly,
    audioWithCoverArt,
    videoWithCoverArt,
    musicMp3,
    musicTooLong,
    duckedWav,
  };
}
