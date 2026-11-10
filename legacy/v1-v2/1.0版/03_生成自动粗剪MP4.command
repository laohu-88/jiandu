#!/bin/zsh

python3 - <<'PY'
from pathlib import Path
import subprocess
import shutil
import re

# 检查 ffmpeg
if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
    print("没找到 ffmpeg / ffprobe。")
    print("请先运行：brew install ffmpeg")
    raise SystemExit

# 选择项目文件夹
script = '''
tell application "Finder"
    set selectedFolder to choose folder with prompt "请选择视频项目文件夹，例如：002_新项目开始"
    POSIX path of selectedFolder
end tell
'''
result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)

if result.returncode != 0:
    print("已取消选择。")
    raise SystemExit

project = Path(result.stdout.strip())

seg_dir = project / "02_分段素材包"
audio_dir = project / "03_配音"
out_dir = project / "04_自动粗剪MP4"
tmp_dir = project / "99_过程文件" / "自动粗剪临时文件"

if not seg_dir.exists():
    print("没找到 02_分段素材包：", seg_dir)
    print("请先生成或放好分段素材包。")
    raise SystemExit

if not audio_dir.exists():
    print("没找到 03_配音：", audio_dir)
    print("请先把剪映导出的分段配音放进 03_配音。")
    raise SystemExit

out_dir.mkdir(parents=True, exist_ok=True)
tmp_dir.mkdir(parents=True, exist_ok=True)

image_exts = {".png", ".jpg", ".jpeg", ".webp", ".heic"}
video_exts = {".mov", ".mp4", ".m4v"}

def get_duration(path):
    r = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path)
        ],
        capture_output=True,
        text=True
    )
    try:
        return float(r.stdout.strip())
    except Exception:
        return 10.0

def find_audio(prefix):
    candidates = sorted([
        p for p in audio_dir.iterdir()
        if p.is_file() and p.name.startswith(prefix)
    ])
    if not candidates:
        return None
    mp3s = [p for p in candidates if ".mp3" in p.name.lower()]
    return mp3s[0] if mp3s else candidates[0]

def convert_heic_if_needed(p, work_dir, idx):
    if p.suffix.lower() != ".heic":
        return p

    out = work_dir / f"converted_{idx:02d}.jpg"

    subprocess.run(
        ["sips", "-s", "format", "jpeg", str(p), "--out", str(out)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )

    return out if out.exists() else p

def make_image_clip(src, out, dur):
    cmd = [
        "ffmpeg", "-y",
        "-loop", "1",
        "-t", f"{dur:.3f}",
        "-i", str(src),
        "-vf",
        "scale=1920:1080:force_original_aspect_ratio=decrease,"
        "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,"
        "setsar=1",
        "-r", "30",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-an",
        str(out)
    ]

    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def make_video_clip(src, out, dur):
    cmd = [
        "ffmpeg", "-y",
        "-stream_loop", "-1",
        "-t", f"{dur:.3f}",
        "-i", str(src),
        "-vf",
        "scale=1920:1080:force_original_aspect_ratio=decrease,"
        "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,"
        "setsar=1",
        "-r", "30",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-an",
        str(out)
    ]

    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

# 自动识别 02_分段素材包 里的分段文件夹
segment_folders = sorted([
    p for p in seg_dir.iterdir()
    if p.is_dir() and p.name[:2].isdigit()
])

if not segment_folders:
    print("02_分段素材包 里没有找到以 01、02、03 开头的分段文件夹。")
    raise SystemExit

print("找到分段：")
for f in segment_folders:
    print(" -", f.name)

for folder in segment_folders:
    prefix = folder.name[:2]
    audio = find_audio(prefix)

    print(f"\n开始生成第 {prefix} 段：{folder.name}")

    if not audio:
        print(f"缺少第 {prefix} 段配音。请确认 03_配音 里有以 {prefix} 开头的音频文件。")
        continue

    visuals = [
        p for p in folder.iterdir()
        if p.is_file() and p.name != ".DS_Store"
    ]
    visuals.sort(key=lambda p: p.name)

    if not visuals:
        print("该段没有素材：", folder)
        continue

    audio_dur = get_duration(audio)
    per_dur = max(1.0, audio_dur / len(visuals))

    seg_tmp = tmp_dir / folder.name
    if seg_tmp.exists():
        shutil.rmtree(seg_tmp)
    seg_tmp.mkdir(parents=True)

    clip_paths = []

    for i, v in enumerate(visuals, 1):
        ext = v.suffix.lower()
        clip_out = seg_tmp / f"clip_{i:02d}.mp4"

        if ext in image_exts:
            src = convert_heic_if_needed(v, seg_tmp, i)
            make_image_clip(src, clip_out, per_dur)
        elif ext in video_exts:
            make_video_clip(v, clip_out, per_dur)
        else:
            print("跳过不支持素材：", v.name)
            continue

        if clip_out.exists():
            clip_paths.append(clip_out)

    if not clip_paths:
        print("没有成功生成片段：", folder.name)
        continue

    concat_file = seg_tmp / "concat.txt"
    with concat_file.open("w", encoding="utf-8") as f:
        for c in clip_paths:
            f.write(f"file '{c.as_posix()}'\n")

    silent_video = seg_tmp / "silent.mp4"

    subprocess.run(
        [
            "ffmpeg", "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", str(concat_file),
            "-c", "copy",
            str(silent_video)
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )

    out_mp4 = out_dir / f"{folder.name}_自动粗剪.mp4"

    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(silent_video),
            "-i", str(audio),
            "-t", f"{audio_dur:.3f}",
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "192k",
            "-shortest",
            str(out_mp4)
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )

    if out_mp4.exists():
        print("完成：", out_mp4.name)
    else:
        print("生成失败：", folder.name)

print("\n全部处理完成。")
print("输出文件夹：", out_dir)
subprocess.run(["open", str(out_dir)])
PY

echo "可以关闭这个窗口。"
