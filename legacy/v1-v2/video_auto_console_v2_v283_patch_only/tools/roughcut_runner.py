#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from pathlib import Path
from datetime import datetime
import subprocess, json, sys, shlex

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".heic"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv"}
AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".aac", ".flac"}

PRESETS = {
    "landscape": (1920, 1080, "横屏 1920x1080"),
    "portrait": (1080, 1920, "竖屏 1080x1920"),
    "square": (1080, 1080, "方屏 1080x1080"),
}


def now_text():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def update_task_status(project, task, state, message):
    try:
        control = project / "00-总控表"
        control.mkdir(parents=True, exist_ok=True)
        p = control / "task-status.json"
        data = {}
        if p.exists():
            data = json.loads(p.read_text(encoding="utf-8"))
        data.setdefault("subtitle", {"state": "idle", "message": "字幕任务未运行", "updated_at": ""})
        data.setdefault("roughcut", {"state": "idle", "message": "粗剪任务未运行", "updated_at": ""})
        data[task] = {"state": state, "message": message, "updated_at": now_text()}
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass

def log_write(log_path, msg):
    print(msg, flush=True)
    with log_path.open("a", encoding="utf-8") as f:
        f.write(msg + "\n")

def read_json(path, default):
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return default

def ffmpeg_exists():
    try:
        subprocess.run(["ffmpeg", "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except Exception:
        return False

def run(cmd, log_path):
    log_write(log_path, "执行：" + " ".join([shlex.quote(str(x)) for x in cmd]))
    r = subprocess.run(cmd)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg 命令失败：" + str(r.returncode))

def find_audio(voice_dir, stem):
    for ext in AUDIO_EXTS:
        p = voice_dir / (stem + ext)
        if p.exists():
            return p
    return None

def backup_existing_output(out_path, project, log_path):
    if not out_path.exists():
        return
    backup_dir = project / "99-临时文件" / "backup" / ("roughcut-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / out_path.name
    out_path.replace(backup_path)
    log_write(log_path, "已备份旧粗剪：" + str(backup_path))

def filter_for_fit(fit, width, height):
    if fit == "contain":
        return f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1"
    return f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1"

def make_image_clip(src, out, duration, fit, width, height, log_path):
    vf = filter_for_fit(fit, width, height) + ",format=yuv420p"
    cmd = ["ffmpeg", "-y", "-loop", "1", "-t", str(duration), "-i", str(src), "-vf", vf, "-r", "30", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)]
    run(cmd, log_path)

def make_video_clip(src, out, duration, fit, width, height, log_path):
    vf = filter_for_fit(fit, width, height) + ",format=yuv420p"
    cmd = ["ffmpeg", "-y", "-i", str(src), "-t", str(duration), "-vf", vf, "-r", "30", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)]
    run(cmd, log_path)

def concat_clips(clips, out, log_path):
    list_file = out.parent / "concat_list.txt"
    list_file.write_text("\n".join(["file " + shlex.quote(str(c)) for c in clips]) + "\n", encoding="utf-8")
    cmd = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file), "-c", "copy", str(out)]
    run(cmd, log_path)

def add_audio(video, audio, out, log_path):
    cmd = ["ffmpeg", "-y", "-i", str(video), "-i", str(audio), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-shortest", str(out)]
    run(cmd, log_path)

def main():
    if len(sys.argv) < 2:
        print("缺少项目路径")
        return 1

    project = Path(sys.argv[1]).expanduser()
    preset = sys.argv[2] if len(sys.argv) >= 3 else "landscape"
    width, height, label = PRESETS.get(preset, PRESETS["landscape"])

    control = project / "00-总控表"
    pack_dir_root = project / "03-分段素材包"
    voice_dir = project / "04-配音"
    subtitle_dir = project / "05-字幕"
    rough_dir = project / "06-粗剪输出"
    cache_root = project / "99-临时文件" / "roughcut-cache"
    log_dir = control / "logs"

    rough_dir.mkdir(parents=True, exist_ok=True)
    cache_root.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "roughcut-log.md"

    log_write(log_path, "\n## " + datetime.now().strftime("%Y-%m-%d %H:%M:%S") + " 运行粗剪")
    log_write(log_path, "项目：" + str(project))
    log_write(log_path, "输出比例：" + label)
    update_task_status(project, "roughcut", "running", "正在运行粗剪……")

    if not ffmpeg_exists():
        log_write(log_path, "错误：找不到 ffmpeg。请先安装 ffmpeg：brew install ffmpeg")
        update_task_status(project, "roughcut", "error", "找不到 ffmpeg，粗剪失败。")
        return 2

    segments = read_json(control / "segments.json", {"segments": []}).get("segments", [])
    seg_assets = read_json(control / "segment-assets.json", {})
    output_count = 0
    skip_count = 0

    for seg in segments:
        key = seg["id"] + "-" + seg["name"]
        items = seg_assets.get(key, [])
        if not items:
            log_write(log_path, "\n跳过 " + key + "：未选择素材。")
            skip_count += 1
            continue

        pack_dir = pack_dir_root / key
        if not pack_dir.exists():
            log_write(log_path, "\n跳过 " + key + "：分段素材包不存在。")
            skip_count += 1
            continue

        files = sorted([f for f in pack_dir.iterdir() if f.is_file()])
        if not files:
            log_write(log_path, "\n跳过 " + key + "：分段素材包为空。")
            skip_count += 1
            continue

        log_write(log_path, "\n开始粗剪：" + key)
        seg_cache = cache_root / key
        seg_cache.mkdir(parents=True, exist_ok=True)
        for old in seg_cache.iterdir():
            if old.is_file():
                old.unlink()

        clips = []
        for idx, src in enumerate(files):
            item = items[idx] if idx < len(items) else {}
            try:
                duration = float(item.get("duration") or 5)
            except Exception:
                duration = 5.0
            fit = item.get("fit", "fill")
            clip = seg_cache / (str(idx + 1).zfill(3) + ".mp4")
            ext = src.suffix.lower()
            if ext in IMAGE_EXTS:
                make_image_clip(src, clip, duration, fit, width, height, log_path)
            elif ext in VIDEO_EXTS:
                make_video_clip(src, clip, duration, fit, width, height, log_path)
            else:
                log_write(log_path, "跳过不支持素材：" + src.name)
                continue
            clips.append(clip)

        if not clips:
            log_write(log_path, "没有可用片段：" + key)
            skip_count += 1
            continue

        silent_video = seg_cache / "silent_concat.mp4"
        concat_clips(clips, silent_video, log_path)

        stem = seg["id"] + "-" + seg["name"]
        audio = find_audio(voice_dir, stem)
        out = rough_dir / (stem + ".mp4")

        if not audio:
            log_write(log_path, "跳过 " + key + "：未找到同名配音，正式粗剪不生成无声视频。")
            log_write(log_path, "需要的配音文件名示例：" + stem + ".mp3 / .wav / .m4a")
            skip_count += 1
            continue

        subtitle = subtitle_dir / (stem + ".srt")
        if not subtitle.exists():
            log_write(log_path, "提醒：" + key + " 未找到同名字幕 " + stem + ".srt；字幕暂不烧录，所以不阻止粗剪。")

        backup_existing_output(out, project, log_path)
        add_audio(silent_video, audio, out, log_path)
        output_count += 1
        log_write(log_path, "已输出：" + str(out))

    final_msg = "粗剪完成：输出 " + str(output_count) + " 段，跳过 " + str(skip_count) + " 段。"
    update_task_status(project, "roughcut", "done", final_msg)
    log_write(log_path, "\n" + final_msg)
    log_write(log_path, "\n粗剪任务完成。回控制台点“刷新状态”。")
    return 0

if __name__ == "__main__":
    sys.exit(main())
