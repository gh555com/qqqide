#!/usr/bin/env python3
"""
Build video: TTS → 2x speed → HTML animation → Playwright → MP4
Output: output.mp4 (~4.5 min)
"""
import asyncio, json, os, sys, subprocess, shutil, re

ROOT = os.path.dirname(os.path.abspath(__file__))
NARRATION = os.path.join(ROOT, "narration.json")
TTS_DIR = os.path.join(ROOT, "tts")
SCENES_HTML = os.path.join(ROOT, "scenes.html")
FINAL_HTML = os.path.join(ROOT, "scenes_final.html")
OUTPUT_MP4 = os.path.join(ROOT, "output.mp4")
OUTPUT_MP4_V2 = os.path.join(ROOT, "output_v2.mp4")
CONCAT_AUDIO = os.path.join(ROOT, "tts", "concat_2x.mp3")
VIDEOS_DIR = os.path.join(ROOT, "playwright_videos")

VOICE = "zh-CN-YunyangNeural"  # Professional news-style male voice
FPS = 25  # Playwright default
WIDTH = 1920
HEIGHT = 1080
FFMPEG = "E:/s/d/ffmpeg.exe"
SPEED_FACTOR = 2.0  # 2x speed
END_PADDING = 3.0  # Extra seconds at the end to prevent cutoff

os.makedirs(TTS_DIR, exist_ok=True)

def log(msg):
    print(f"[build] {msg}")

# ─── STEP 1: TTS ───
async def generate_tts():
    from edge_tts import Communicate
    data = json.load(open(NARRATION, "r", encoding="utf-8"))
    for scene in data["scenes"]:
        sid = scene["id"]
        path_1x = os.path.join(TTS_DIR, "s{:02d}_1x.mp3".format(sid))
        if os.path.exists(path_1x):
            log("TTS s{:02d} exists, skip".format(sid))
            continue
        log("TTS s{:02d}: {}".format(sid, scene["title"]))
        comm = Communicate(scene["cn"], VOICE)
        await comm.save(path_1x)
    log("All TTS done")

# ─── STEP 2: Speed up 2x ───
def speed_up_all():
    """Speed up each 1x MP3 to 2x using ffmpeg atempo filter"""
    data = json.load(open(NARRATION, "r", encoding="utf-8"))
    for scene in data["scenes"]:
        sid = scene["id"]
        src = os.path.join(TTS_DIR, "s{:02d}_1x.mp3".format(sid))
        dst = os.path.join(TTS_DIR, "s{:02d}.mp3".format(sid))
        if os.path.exists(dst):
            log("2x s{:02d} exists, skip".format(sid))
            continue
        if not os.path.exists(src):
            raise FileNotFoundError("Missing 1x: {}".format(src))
        log("Speed up s{:02d} 2x ...".format(sid))
        # atempo filter: 2.0 = double speed
        subprocess.run([
            FFMPEG, "-y", "-i", src,
            "-filter:a", "atempo=2.0",
            "-vn", dst
        ], check=True, capture_output=True)
    log("All 2x done")

# ─── STEP 3: Measure 2x durations ───
def measure_durations():
    data = json.load(open(NARRATION, "r", encoding="utf-8"))
    total = 0.0
    for scene in data["scenes"]:
        sid = scene["id"]
        path_2x = os.path.join(TTS_DIR, "s{:02d}.mp3".format(sid))
        if not os.path.exists(path_2x):
            raise FileNotFoundError("Missing 2x: {}".format(path_2x))
        result = subprocess.run([FFMPEG, "-i", path_2x, "-f", "null", "-"],
                               capture_output=True, text=True)
        m = re.search(r"Duration: (\d+):(\d+):(\d+)\.(\d+)", result.stderr)
        if m:
            h, mi, s, cs = map(int, m.groups())
            dur = h * 3600 + mi * 60 + s + cs / 100.0
        else:
            dur = 12.0
        scene["duration"] = round(dur, 1)
        scene["start"] = round(total, 1)
        total += dur
        log("  s{:02d}: {:.1f}s (2x)".format(sid, dur))
    
    data["totalDuration"] = round(total, 1)
    json.dump(data, open(NARRATION, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    log("Total 2x: {:.1f}s ({:.1f} min)".format(total, total/60))
    return data

# ─── STEP 4: Concat all 2x audio + add silence at end ───
def concat_audio(data):
    if os.path.exists(CONCAT_AUDIO):
        log("Concat audio exists, skip")
        return
    list_path = os.path.join(TTS_DIR, "concat_list.txt")
    with open(list_path, "w", encoding="utf-8") as f:
        for scene in data["scenes"]:
            sid = scene["id"]
            apath = os.path.join(TTS_DIR, "s{:02d}.mp3".format(sid))
            f.write("file '{}'\n".format(apath))
    
    # Concat with silence padding at end to prevent cutoff
    subprocess.run([
        FFMPEG, "-y",
        "-f", "concat", "-safe", "0", "-i", list_path,
        "-c", "copy", CONCAT_AUDIO
    ], check=True)
    log("Audio concatenated: {}".format(CONCAT_AUDIO))

# ─── Generate final HTML with scene data ───
def gen_html(data):
    scenes_json = json.dumps(data["scenes"], ensure_ascii=False)
    with open(SCENES_HTML, "r", encoding="utf-8") as f:
        html = f.read()
    html = html.replace("/*SCENES_JSON_PLACEHOLDER*/", scenes_json)
    html = html.replace("/*TOTAL_DURATION_PLACEHOLDER*/", str(data["totalDuration"]))
    with open(FINAL_HTML, "w", encoding="utf-8") as f:
        f.write(html)
    log("Generated {}".format(FINAL_HTML))

# ─── STEP 5: Record video via Playwright ───
async def record_video(data):
    if os.path.exists(OUTPUT_MP4_V2):
        log("Output exists, skip")
        return
    from playwright.async_api import async_playwright

    gen_html(data)
    total_dur = data["totalDuration"]
    shutil.rmtree(VIDEOS_DIR, ignore_errors=True)
    os.makedirs(VIDEOS_DIR, exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": WIDTH, "height": HEIGHT},
            device_scale_factor=1,
            record_video_dir=VIDEOS_DIR,
            record_video_size={"width": WIDTH, "height": HEIGHT},
        )
        page = await context.new_page()
        url = "file:///" + FINAL_HTML.replace("\\", "/")
        await page.goto(url, wait_until="networkidle")
        
        # Wait for auto-play + total duration + padding
        wait_time = total_dur + END_PADDING + 10  # extra buffer
        log("Recording for {:.1f}s ...".format(wait_time))
        
        await page.wait_for_function(
            "window.__allScenesDone === true",
            timeout=int((wait_time + 60) * 1000)
        )
        # Extra wait for last scene render completion
        await asyncio.sleep(END_PADDING + 1)
        await context.close()
        await browser.close()

    # Find recorded video
    webm_files = []
    for root_dir, dirs, files in os.walk(VIDEOS_DIR):
        for f in files:
            if f.endswith(".webm"):
                webm_files.append(os.path.join(root_dir, f))
    if not webm_files:
        raise RuntimeError("No video recorded!")
    raw_video = webm_files[0]
    log("Recorded: {}".format(raw_video))

    # Combine video + audio with proper timing
    # The video will be longer than audio due to the auto-play wait
    # We add silence padding to audio to match
    log("Adding silence padding to audio...")
    silence_path = os.path.join(TTS_DIR, "silence.mp3")
    subprocess.run([
        FFMPEG, "-y", "-f", "lavfi",
        "-i", "anullsrc=r=24000:cl=mono",
        "-t", str(END_PADDING + 5),
        silence_path
    ], check=True, capture_output=True)
    
    padded_audio = os.path.join(TTS_DIR, "concat_padded.mp3")
    pad_list = os.path.join(TTS_DIR, "pad_list.txt")
    with open(pad_list, "w", encoding="utf-8") as f:
        f.write("file '{}'\n".format(CONCAT_AUDIO))
        f.write("file '{}'\n".format(silence_path))
    subprocess.run([
        FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", pad_list,
        "-c", "copy", padded_audio
    ], check=True)
    
    log("Combining video + audio ...")
    subprocess.run([
        FFMPEG, "-y",
        "-i", raw_video,
        "-i", padded_audio,
        "-c:v", "libx264", "-c:a", "aac",
        "-pix_fmt", "yuv420p",
        "-preset", "fast", "-crf", "23",
        "-shortest", "-map", "0:v:0", "-map", "1:a:0",
        OUTPUT_MP4_V2
    ], check=True)

    size_mb = os.path.getsize(OUTPUT_MP4_V2) / 1024 / 1024
    log("Done! {} ({:.1f} MB)".format(OUTPUT_MP4_V2, size_mb))
    shutil.rmtree(VIDEOS_DIR, ignore_errors=True)

# ─── MAIN ───
async def main():
    log("=== Step 1: TTS ===")
    await generate_tts()
    log("=== Step 2: 2x speed ===")
    speed_up_all()
    log("=== Step 3: Measure durations ===")
    data = measure_durations()
    log("=== Step 4: Concat audio ===")
    concat_audio(data)
    log("=== Step 5: Record video ===")
    await record_video(data)
    log("=== FINAL: {} ===".format(OUTPUT_MP4))

if __name__ == "__main__":
    asyncio.run(main())
