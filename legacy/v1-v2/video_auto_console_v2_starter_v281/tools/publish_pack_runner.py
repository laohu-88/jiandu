#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from pathlib import Path
from datetime import datetime
import json, sys, shutil

VIDEO_EXTS = {".mp4"}
COVER_EXTS = {".png", ".jpg", ".jpeg", ".webp"}

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
        data.setdefault("convert", {"state": "idle", "message": "mov 转 mp4 未运行", "updated_at": ""})
        data.setdefault("publish", {"state": "idle", "message": "发布包未生成", "updated_at": ""})
        data[task] = {"state": state, "message": message, "updated_at": now_text()}
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass

def latest_file(folder, exts):
    if not folder.exists():
        return None
    files = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in exts]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0] if files else None

def next_version_dir(platform_dir):
    platform_dir.mkdir(parents=True, exist_ok=True)
    nums = []
    for p in platform_dir.iterdir():
        if p.is_dir() and p.name.startswith("v"):
            try:
                nums.append(int(p.name[1:]))
            except Exception:
                pass
    n = max(nums) + 1 if nums else 1
    return platform_dir / ("v" + str(n))

def safe_copy(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)

def write_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")

def main():
    if len(sys.argv) < 2:
        print("缺少项目路径")
        return 1

    project = Path(sys.argv[1]).expanduser()
    control = project / "00-总控表"
    final_dir = project / "08-最终导出"
    cover_dir = project / "09-封面"
    publish_root = project / "10-发布包"
    log_dir = control / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "publish-log.md"

    log_write(log_path, "\n## " + now_text() + " 生成发布包")
    log_write(log_path, "项目：" + str(project))
    update_task_status(project, "publish", "running", "正在生成发布包……")

    final_mp4 = latest_file(final_dir, VIDEO_EXTS)
    if final_mp4 is None:
        msg = "没有找到最终 mp4。请先把 FCP 导出的 mov 转成 mp4，放在 08-最终导出。"
        log_write(log_path, msg)
        update_task_status(project, "publish", "error", msg)
        return 2

    cover = latest_file(cover_dir, COVER_EXTS)
    publish_json = read_json(control / "publish.json", {})
    video_plan = control / "video-plan.md"
    publish_plan = control / "publish-plan.md"

    platforms = ["B站", "小红书"]
    made = []

    for platform in platforms:
        out_dir = next_version_dir(publish_root / platform)
        out_dir.mkdir(parents=True, exist_ok=True)

        video_name = "视频-" + final_mp4.name
        safe_copy(final_mp4, out_dir / video_name)
        log_write(log_path, platform + " 已复制视频：" + str(out_dir / video_name))

        if cover:
            cover_name = "封面-" + cover.name
            safe_copy(cover, out_dir / cover_name)
            log_write(log_path, platform + " 已复制封面：" + str(out_dir / cover_name))
        else:
            cover_name = ""
            log_write(log_path, platform + " 未找到封面文件，已跳过封面复制。")

        platform_data = publish_json.get(platform, {}) if isinstance(publish_json, dict) else {}
        title = platform_data.get("title") or publish_json.get("title") or project.name
        desc = platform_data.get("desc") or publish_json.get("desc") or ""
        tags = platform_data.get("tags") or publish_json.get("tags") or []

        if isinstance(tags, str):
            tags_text = tags
        else:
            tags_text = " ".join(["#" + str(t).lstrip("#") for t in tags]) if tags else ""

        md = []
        md.append("# " + platform + " 发布文案")
        md.append("")
        md.append("## 标题")
        md.append(str(title))
        md.append("")
        md.append("## 简介 / 正文")
        md.append(str(desc).strip() or "（这里填写发布正文）")
        md.append("")
        md.append("## 标签")
        md.append(tags_text or "（这里填写标签）")
        md.append("")
        md.append("## 文件")
        md.append("- 视频：" + video_name)
        if cover_name:
            md.append("- 封面：" + cover_name)
        else:
            md.append("- 封面：未放入，请手动补封面")
        md.append("")
        md.append("## 发布前检查")
        md.append("- [ ] 视频能正常播放")
        md.append("- [ ] 标题无错字")
        md.append("- [ ] 封面清晰")
        md.append("- [ ] 简介/正文已填写")
        md.append("- [ ] 标签已填写")
        md.append("- [ ] 没有暴露隐私、路径、账号、密钥")
        md.append("- [ ] 发布后截图保存到 11-复盘数据/01-数据截图")
        write_text(out_dir / (platform + "-发布文案.md"), "\n".join(md))

        checklist = []
        checklist.append("# " + platform + " 发布检查清单")
        checklist.append("")
        checklist.append("发布时间：")
        checklist.append("")
        checklist.append("链接：")
        checklist.append("")
        checklist.append("发布后数据记录：")
        checklist.append("- 1小时：")
        checklist.append("- 24小时：")
        checklist.append("- 72小时：")
        checklist.append("")
        checklist.append("备注：")
        write_text(out_dir / "发布检查清单.md", "\n".join(checklist))

        if video_plan.exists():
            safe_copy(video_plan, out_dir / "原始视频方案.md")
        if publish_plan.exists():
            safe_copy(publish_plan, out_dir / "原始发布方案.md")

        made.append(str(out_dir))

    msg = "发布包生成完成：B站、小红书各 1 个版本。"
    log_write(log_path, msg)
    for x in made:
        log_write(log_path, "输出：" + x)
    update_task_status(project, "publish", "done", msg)
    return 0

if __name__ == "__main__":
    sys.exit(main())
