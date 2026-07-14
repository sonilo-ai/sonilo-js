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
  videoSparsePictureMkv: string;
  videoSparsePictureTs: string;
  videoLongPictureLongerAudioMkv: string;
  videoFragmentedEmptyMoov: string;
  videoFragmentedKeyframe: string;
  videoEditList: string;
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
  // THE FIXTURE THAT REPRODUCES THE BILLING BUG. 10 s of picture at 1 fps under
  // a 30 s audio track, in Matroska.
  //
  // The point is the SPARSITY of the picture, not the container. When
  // libavformat cannot establish a video stream's timing from its packets --
  // which is what happens when the picture's packets are sparse in the byte
  // stream (low frame rate, few frames) -- it BACKFILLS `st->duration` from the
  // container's Duration element. ffprobe then prints a video-stream `duration`
  // FIELD equal to format.duration, i.e. the maximum over all streams, i.e. the
  // AUDIO's length:
  //
  //   stream 0 video  duration='30.128000'  tags={'DURATION': '00:00:10.000000000'}
  //                   ^^^ the AUDIO's length          ^^^ the picture's TRUE length
  //
  // So the file carries BOTH numbers, and a cascade that reads the FIELD first
  // takes the audio's. Billed at 30 s for a 10 s picture: a 3x overcharge, and a
  // deliverable whose picture freezes at 10 s.
  //
  // The older `audio_outlives_picture.mkv` above CANNOT catch this: at 10 fps its
  // packets are dense enough that ffprobe establishes the stream's timing itself
  // and emits NO field at all, so it lands on the DURATION tag by accident and
  // passes even with the bug present. Sparsity is the whole trigger.
  const videoSparsePictureMkv = join(dir, "sparse_picture.mkv");
  run([
    "-f", "lavfi", "-i", "testsrc=duration=10:size=64x36:rate=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=30:sample_rate=8000",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "32k",
    videoSparsePictureMkv,
  ]);
  // The same backfill, in MPEG-TS -- where there is NO DURATION tag to fall back
  // on. ffprobe reports duration='29.767978' (the container's) for a 10 s
  // picture, carries no tag, no nb_frames, and `avg_frame_rate=0/0`, which is
  // what defeats a packets/frame-rate measurement as well. The picture's length
  // can only be recovered by MEASURING the span its packets occupy. Probe-level
  // fixture only: a 1 fps mpegts is degenerate enough that ffmpeg cannot re-read
  // its codec parameters ("no TS found at start of file"), so it cannot be muxed.
  const videoSparsePictureTs = join(dir, "sparse_picture.ts");
  run([
    "-f", "lavfi", "-i", "testsrc=duration=10:size=64x36:rate=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=30:sample_rate=8000",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "32k",
    videoSparsePictureTs,
  ]);
  // A LEGAL video the cap guard must not reject: 352 s of picture (under the
  // API's 360 s limit, and the only figure the backend gates on) under 365 s of
  // audio (over it). The backend accepts exactly this -- audio_ducking.py gates
  // on the video stream's duration, and its comments cite a real 358 s picture /
  // 361 s audio case. A guard reading the container's duration instead reports
  // "runs 365.1s" and refuses a video the API would have taken.
  //
  // A SLIDESHOW: one frame per 4 s (88 frames spanning 352 s), which is both the
  // realistic shape and, crucially, sparse enough to TRIGGER THE BACKFILL --
  // ffprobe reports this video stream's `duration` FIELD as 365.128 (the audio's,
  // i.e. the container's) while its DURATION TAG says 00:05:52 (352 s).
  //
  // The previous version of this fixture ran at 1 fps for 350 s, and at 350 frames
  // ffprobe establishes the stream's timing itself and emits NO field at all -- so
  // it landed on the DURATION tag by accident and the cap test passed even with
  // the bug present. It asserted the right property against a fixture that could
  // not exercise it. It is also cheaper this way: 88 frames instead of 350.
  const videoLongPictureLongerAudioMkv = join(dir, "long_picture_longer_audio.mkv");
  run([
    "-f", "lavfi", "-i", "testsrc=duration=350:size=64x36:rate=1/4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=365:sample_rate=8000",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "32k",
    videoLongPictureLongerAudioMkv,
  ]);
  // THE FRAGMENTED-MP4 UNDERBILL. 10 s of picture at 1 fps under a 30 s audio
  // track, written with ffmpeg's two documented fragmenting recipes. This is the
  // shape that CUTS THE USER'S SPEECH OFF, and it is the dangerous direction:
  // every other billing bug in this file overcharges, this one UNDERcharges and
  // delivers a truncated mix.
  //
  // With no moov to describe the track, libavformat takes the stream's
  // `start_time` from the FIRST PACKET IN DECODE ORDER, which under B-pyramid is
  // not the packet with the smallest pts. It reports:
  //
  //   start_time=2.000000  duration=8.128052   <- the picture really runs 10 s
  //   format.duration=30.128   (the audio's)   <- and its packets start at pts 0.000061
  //
  // because it computes `st->duration` as `packet_span - start_time`, subtracting
  // a start that is a PHANTOM. The field (8.13) is nowhere near the container
  // (30.13), so the looks-like-the-container's guard does NOT fire and the field
  // is trusted: 8.13 s of voice is uploaded under a 10 s picture, the customer is
  // billed 0.81x, and THE LAST TWO SECONDS OF THEIR SPEECH ARE GONE. The error is
  // `2/fps`, so it bites hardest at low frame rates -- an OBS "fragmented MP4"
  // screen share, ffmpeg's own streaming recipe, CMAF/DASH segments,
  // MediaRecorder output of a mostly-static screen share.
  //
  // BOTH recipes are kept because they defeat DIFFERENT signals, and neither
  // signal saves either file:
  //   +frag_keyframe+empty_moov -> nb_frames=N/A  (no per-track frame accounting)
  //   +frag_keyframe            -> nb_frames=10   (frame accounting present!)
  // so a guard keyed on `nb_frames` presence passes the second one straight
  // through. Only checking where the picture's packets actually END catches both.
  const videoFragmentedEmptyMoov = join(dir, "fragmented_empty_moov.mp4");
  run([
    "-f", "lavfi", "-i", "testsrc=duration=10:size=64x36:rate=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=30:sample_rate=8000",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "32k",
    "-movflags", "+frag_keyframe+empty_moov",
    videoFragmentedEmptyMoov,
  ]);
  const videoFragmentedKeyframe = join(dir, "fragmented_keyframe.mp4");
  run([
    "-f", "lavfi", "-i", "testsrc=duration=10:size=64x36:rate=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=30:sample_rate=8000",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "32k",
    "-movflags", "+frag_keyframe",
    videoFragmentedKeyframe,
  ]);
  // AN EDIT-LIST MP4 -- `ffmpeg -ss 2 -c copy`, i.e. every iPhone trim, and the
  // single most common video on earth. The OTHER side of the guard, and the
  // fixture that keeps the 1.25x overbill dead.
  //
  // All 50 coded frames of the 10 s source are RETAINED; an `elst` trims the
  // PRESENTATION to 8 s. So the file reports, correctly:
  //
  //   start_time=0.000000  duration=8.000000  nb_frames=50   (decodes to 8.00 s)
  //
  // ...while its RAW PACKET TIMESTAMPS -- which do NOT have the edit list applied
  // -- run from pts -2.000 to 8.000, a span of 10.000. Any measurement that takes
  // `max - min` therefore reads 10 s for an 8 s deliverable and bills 1.25x.
  // Frames at negative pts are exactly the frames the edit list DISCARDS, which
  // is why the measurement clamps its origin at zero.
  //
  // 5 fps (50 frames) rather than 25 to stay cheap; the mechanism is identical.
  const videoEditListSource = join(dir, "edit_list_source.mp4");
  run([
    "-f", "lavfi", "-i", "testsrc=duration=10:size=64x36:rate=5",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=30:sample_rate=8000",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "32k",
    videoEditListSource,
  ]);
  const videoEditList = join(dir, "edit_list.mp4");
  run(["-ss", "2", "-i", videoEditListSource, "-c", "copy", videoEditList]);
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
    videoSparsePictureMkv,
    videoSparsePictureTs,
    videoLongPictureLongerAudioMkv,
    videoFragmentedEmptyMoov,
    videoFragmentedKeyframe,
    videoEditList,
    audioOnly,
    audioWithCoverArt,
    videoWithCoverArt,
    musicMp3,
    musicTooLong,
    duckedWav,
  };
}
