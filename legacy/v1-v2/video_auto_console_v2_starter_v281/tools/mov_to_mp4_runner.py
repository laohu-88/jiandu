#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from pathlib import Path
from datetime import datetime
import subprocess, json, sys, shlex

def now_text():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def log_write(log_path, msg):
    print(msg, flush=True)
    with log_path.open("a", encoding="utf-8") as f:
        f.write(msg + "\n")

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
        data.setdefault("convert", {"state": "idle", "message": "mov 转 mp4 未运行", "updated_at": ""})
        data[task] = {"state": state, "message": message, "updated_at": now_text()}
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass

def run(cmd, log_path):
    log_write(log_path, "执行：" + " ".join([shlex.quote(str(x)) for x in cmd]))
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if r.stdout:
        log_write(log_path, r.stdout.strip())
    if r.returncode != 0:
        raise RuntimeError("ffmpeg 返回错误码：" + str(r.returncode))

def ffmpeg_exists():
    try:
        subprocess.run(["ffmpeg", "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except Exception:
        return False

def backup_existing(out_path, project, log_path):
    if not out_path.exists():
        return
    backup_dir = project / "99-临时文件" / "backup" / ("final-mp4-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / out_path.name
    out_path.replace(backup_path)
    log_write(log_path, "已备份旧 mp4：" + str(backup_path))

def main():
    if len(sys.argv) < 2:
        print("缺少项目路径")
        return 1

    project = Path(sys.argv[1]).expanduser()
    control = project / "00-总控表"
    final_dir = project / "08-最终导出"
    log_dir = control / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    final_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "convert-log.md"

    log_write(log_path, "\n## " + now_text() + " mov 转 mp4")
    log_write(log_path, "项目：" + str(project))
    update_task_status(project, "convert", "running", "正在转换 mov 到 mp4……")

    if not ffmpeg_exists():
        msg = "找不到 ffmpeg，无法转换。请先安装：brew install ffmpeg"
        log_write(log_path, msg)
        update_task_status(project, "convert", "error", msg)
        return 2

    movs = sorted([p for p in final_dir.iterdir() if p.is_file() and p.suffix.lower() == ".mov"])
    if not movs:
        msg = "08-最终导出 里没有找到 mov 文件。请先从 FCP 导出 mov 到这个文件夹。"
        log_write(log_path, msg)
        update_task_status(project, "convert", "error", msg)
        return 3

    converted = 0
    failed = 0

    for mov in movs:
        out = final_dir / (mov.stem + ".mp4")
        log_write(log_path, "\n开始转换：" + mov.name)
        try:
            backup_existing(out, project, log_path)
            cmd = [
                "ffmpeg", "-y",
                "-i", str(mov),
                "-c:v", "libx264",
                "-preset", "medium",
                "-crf", "20",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac",
                "-b:a", "192k",
                "-movflags", "+faststart",
                str(out)
            ]
            run(cmd, log_path)
            log_write(log_path, "已输出：" + str(out))
            converted += 1
        except Exception as e:
            log_write(log_path, "转换失败：" + str(e))
            failed += 1

    state = "done" if failed == 0 else "error"
    msg = "mov 转 mp4 完成：成功 " + str(converted) + " 个，失败 " + str(failed) + " 个。"
    update_task_status(project, "convert", state, msg)
    log_write(log_path, "\n" + msg)
    return 0 if failed == 0 else 4

if __name__ == "__main__":
    sys.exit(main())
