#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from pathlib import Path
from datetime import datetime
import subprocess, json, sys, html, math

def now_text():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

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
        data.setdefault("fcpxml", {"state": "idle", "message": "FCPXML 未生成", "updated_at": ""})
        data[task] = {"state": state, "message": message, "updated_at": now_text()}
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass

def run_text(cmd):
    try:
        r = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    return ""

def probe_duration(path):
    out = run_text(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)])
    try:
        v = float(out)
        if v > 0:
            return v
    except Exception:
        pass
    return 5.0

def probe_size(path):
    out = run_text(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", str(path)])
    try:
        w, h = out.split("x")
        return int(w), int(h)
    except Exception:
        return 1920, 1080

def frames_for_seconds(seconds):
    return max(1, int(math.ceil(seconds * 30)))

def fdur(frames):
    # 30fps in FCPXML rational form: frames * 1/30 = frames*100/3000
    return str(frames * 100) + "/3000s"

def xml_escape(x):
    return html.escape(str(x), quote=True)

def main():
    if len(sys.argv) < 2:
        print("缺少项目路径")
        return 1

    project = Path(sys.argv[1]).expanduser()
    control = project / "00-总控表"
    rough_dir = project / "06-粗剪输出"
    fcp_dir = project / "07-FCP工程"
    log_dir = control / "logs"
    cache_dir = project / "99-临时文件" / "fcpxml-cache"
    fcp_dir.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "fcpxml-log.md"

    log_write(log_path, "\n## " + now_text() + " 生成 FCPXML")
    log_write(log_path, "项目：" + str(project))
    update_task_status(project, "fcpxml", "running", "正在生成 FCPXML 时间线……")

    segments = read_json(control / "segments.json", {"segments": []}).get("segments", [])
    clips = []

    for seg in segments:
        stem = seg["id"] + "-" + seg["name"]
        rough = rough_dir / (stem + ".mp4")
        if not rough.exists():
            log_write(log_path, "跳过：" + stem + "，缺少粗剪 mp4")
            continue
        duration_sec = probe_duration(rough)
        frames = frames_for_seconds(duration_sec)
        clips.append({
            "stem": stem,
            "path": rough,
            "frames": frames,
            "duration": fdur(frames),
        })

    if not clips:
        msg = "没有找到可导入的粗剪 mp4，请先运行粗剪。"
        log_write(log_path, msg)
        update_task_status(project, "fcpxml", "error", msg)
        return 2

    width, height = probe_size(clips[0]["path"])
    total_frames = sum(c["frames"] for c in clips)

    resources = []
    spine = []
    offset_frames = 0

    resources.append('    <format id="r1" name="FFVideoFormatCustom30" frameDuration="100/3000s" width="' + str(width) + '" height="' + str(height) + '" colorSpace="1-1-1 (Rec. 709)"/>')

    for idx, c in enumerate(clips, start=2):
        rid = "r" + str(idx)
        name = xml_escape(c["stem"])
        uri = c["path"].resolve().as_uri()
        resources.append('    <asset id="' + rid + '" name="' + name + '" start="0s" duration="' + c["duration"] + '" hasVideo="1" hasAudio="1" format="r1" audioSources="1" audioChannels="2" audioRate="48000">')
        resources.append('      <media-rep kind="original-media" src="' + xml_escape(uri) + '"/>')
        resources.append('    </asset>')
        spine.append('          <asset-clip name="' + name + '" ref="' + rid + '" offset="' + fdur(offset_frames) + '" start="0s" duration="' + c["duration"] + '"/>')
        offset_frames += c["frames"]

    project_name = xml_escape(project.name)
    event_name = xml_escape(project.name + "-自动粗剪")
    timeline_name = xml_escape(project.name + "-FCP时间线")
    out = fcp_dir / (project.name + "-自动粗剪.fcpxml")

    xml = []
    xml.append('<?xml version="1.0" encoding="UTF-8"?>')
    xml.append('<fcpxml version="1.10">')
    xml.append('  <resources>')
    xml.extend(resources)
    xml.append('  </resources>')
    xml.append('  <library>')
    xml.append('    <event name="' + event_name + '">')
    xml.append('      <project name="' + timeline_name + '">')
    xml.append('        <sequence format="r1" duration="' + fdur(total_frames) + '" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">')
    xml.append('          <spine>')
    xml.extend(spine)
    xml.append('          </spine>')
    xml.append('        </sequence>')
    xml.append('      </project>')
    xml.append('    </event>')
    xml.append('  </library>')
    xml.append('</fcpxml>')
    out.write_text("\n".join(xml), encoding="utf-8")

    msg = "FCPXML 生成完成：导入 " + str(len(clips)) + " 段粗剪。"
    log_write(log_path, msg)
    log_write(log_path, "已输出：" + str(out))
    update_task_status(project, "fcpxml", "done", msg)
    return 0

if __name__ == "__main__":
    sys.exit(main())
