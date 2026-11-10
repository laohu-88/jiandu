#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from pathlib import Path
from datetime import datetime
import subprocess, json, sys, re

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
        data.setdefault("fcpsubtitle", {"state": "idle", "message": "FCP 字幕 SRT 未生成", "updated_at": ""})
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
        return v if v > 0 else 0.0
    except Exception:
        return 0.0

def parse_time(t):
    t = t.strip()
    t = t.replace("：", ":").replace("，", ",").replace("．", ".")
    # 支持 00:00:01,234 / 00:00:01.234 / 0:01.234
    m = re.search(r"(?:(\d+):)?(\d{1,2}):(\d{1,2})[\.,](\d{1,3})", t)
    if not m:
        return None
    h = int(m.group(1) or 0)
    mi = int(m.group(2))
    s = int(m.group(3))
    ms_s = (m.group(4) + "000")[:3]
    ms = int(ms_s)
    return h * 3600 + mi * 60 + s + ms / 1000.0

def fmt_time(sec):
    ms_total = max(0, int(round(sec * 1000)))
    ms = ms_total % 1000
    total = ms_total // 1000
    s = total % 60
    total //= 60
    mi = total % 60
    h = total // 60
    return f"{h:02d}:{mi:02d}:{s:02d},{ms:03d}"



def decode_unicode_escapes_maybe(s):
    if not s:
        return ""
    # 先处理 JSON 常见转义，不影响正常中文
    try:
        if "\\u" in s or "\\n" in s or "\\t" in s:
            # 包一层引号让 json 解码字符串转义
            return json.loads('"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\\\\u", "\\u").replace("\\\\n", "\\n").replace("\\\\t", "\\t") + '"')
    except Exception:
        pass
    try:
        if "\\u" in s:
            return s.encode("utf-8").decode("unicode_escape")
    except Exception:
        pass
    return s

def extract_json_like_text(raw):
    # 兼容 {"text": "..."} 以及 {"text"： "..."} 这种全角冒号
    m = re.search(r'["“]?text["”]?\s*[:：]\s*["“](.*?)["”]\s*(?:[,，}]|$)', raw, re.S)
    if m:
        return decode_unicode_escapes_maybe(m.group(1)).strip()
    return ""

def extract_plain_text_from_subtitle_like_file(path):
    raw = path.read_text(encoding="utf-8", errors="ignore").strip()
    if not raw:
        return ""
    # JSON fallback: {"text": "..."} or {"segments":[...]}
    if raw.startswith("{") or raw.startswith("["):
        try:
            data = json.loads(raw.replace("：", ":"))
            if isinstance(data, dict):
                if isinstance(data.get("text"), str):
                    return decode_unicode_escapes_maybe(data.get("text", "")).strip()
                segs = data.get("segments")
                if isinstance(segs, list):
                    texts = []
                    for s in segs:
                        if isinstance(s, dict) and isinstance(s.get("text"), str):
                            texts.append(decode_unicode_escapes_maybe(s["text"]).strip())
                    return " ".join([x for x in texts if x]).strip()
            if isinstance(data, list):
                texts = []
                for s in data:
                    if isinstance(s, dict) and isinstance(s.get("text"), str):
                        texts.append(decode_unicode_escapes_maybe(s["text"]).strip())
                return " ".join([x for x in texts if x]).strip()
        except Exception:
            text2 = extract_json_like_text(raw)
            if text2:
                return text2
    # TXT fallback: remove obvious timestamp lines / indices
    lines = []
    for line in raw.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        t = line.strip()
        if not t:
            continue
        if re.match(r"^\d+$", t):
            continue
        if "-->" in t:
            continue
        if t.upper().startswith("WEBVTT"):
            continue
        lines.append(decode_unicode_escapes_maybe(t))
    return " ".join(lines).strip()

def split_text_to_caption_items(text, duration):
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    # 按中文标点优先切句；太长再按长度切
    parts = re.split(r"(?<=[。！？!?])", text)
    chunks = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        while len(p) > 32:
            chunks.append(decode_unicode_escapes_maybe(p[:32]))
            p = p[32:]
        if p:
            chunks.append(decode_unicode_escapes_maybe(p))
    if not chunks:
        return []
    duration = duration if duration and duration > 0 else max(2.0, len(chunks) * 2.0)
    per = max(1.2, duration / len(chunks))
    items = []
    t = 0.0
    for i, body in enumerate(chunks):
        start = t
        end = min(duration, t + per)
        if end <= start:
            end = start + 1.2
        items.append((start, end, body))
        t += per
    return items

def read_srt_items(path, fallback_duration=0.0):
    text = path.read_text(encoding="utf-8", errors="ignore").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return []
    text2 = text.replace("WEBVTT", "").strip()
    lines = text2.split("\n")
    items = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if re.match(r"^\d+$", line):
            i += 1
            if i >= len(lines):
                break
            line = lines[i].strip()
        if "-->" not in line:
            i += 1
            continue
        left, right = line.split("-->", 1)
        start = parse_time(left)
        end = parse_time(right)
        i += 1
        body_lines = []
        while i < len(lines) and lines[i].strip():
            body_lines.append(lines[i].strip())
            i += 1
        body = "\n".join(body_lines).strip()
        if start is not None and end is not None and body:
            items.append((start, end, body))
        i += 1
    if items:
        return items

    # 兜底：有些 ww 输出/搬运结果实际是 JSON 或纯文本，不含时间轴。
    plain = extract_plain_text_from_subtitle_like_file(path)
    return split_text_to_caption_items(plain, fallback_duration)

def main():
    if len(sys.argv) < 2:
        print("缺少项目路径")
        return 1

    project = Path(sys.argv[1]).expanduser()
    control = project / "00-总控表"
    rough_dir = project / "06-粗剪输出"
    subtitle_dir = project / "05-字幕"
    fcp_dir = project / "07-FCP工程"
    log_dir = control / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    fcp_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "fcp-subtitle-log.md"

    log_write(log_path, "\n## " + now_text() + " 生成 FCP 字幕 SRT")
    update_task_status(project, "fcpsubtitle", "running", "正在生成 FCP 可编辑字幕 SRT……")

    segments = read_json(control / "segments.json", {"segments": []}).get("segments", [])
    if not segments:
        msg = "没有 segments.json 分段数据。"
        log_write(log_path, msg)
        update_task_status(project, "fcpsubtitle", "error", msg)
        return 2

    merged = []
    offset = 0.0
    used = 0
    skipped = 0

    for seg in segments:
        stem = seg["id"] + "-" + seg["name"]
        rough = rough_dir / (stem + ".mp4")
        srt = subtitle_dir / (stem + ".srt")

        if not rough.exists():
            log_write(log_path, "跳过 " + stem + "：缺少粗剪 mp4")
            skipped += 1
            continue

        dur = probe_duration(rough)
        if not srt.exists():
            log_write(log_path, "跳过 " + stem + "：缺少同名字幕 srt")
            offset += dur
            skipped += 1
            continue

        items = read_srt_items(srt, dur)
        if not items:
            sample = srt.read_text(encoding="utf-8", errors="ignore")[:300].replace("\n", " / ")
            log_write(log_path, "跳过 " + stem + "：字幕为空或无法解析。前300字符：" + sample)
            offset += dur
            skipped += 1
            continue

        for start, end, body in items:
            merged.append((offset + start, offset + end, body))
        log_write(log_path, "已合并 " + stem + "：" + str(len(items)) + " 条字幕，偏移 " + str(round(offset, 3)) + " 秒")
        offset += dur
        used += 1

    if not merged:
        msg = "没有可合并的字幕。请先生成每段 srt，并运行粗剪。"
        log_write(log_path, msg)
        update_task_status(project, "fcpsubtitle", "error", msg)
        return 3

    out = fcp_dir / (project.name + "-FCP可编辑字幕.srt")
    out_plain = fcp_dir / (project.name + "-FCP可编辑字幕-普通UTF8备份.srt")
    lines = []
    for i, (start, end, body) in enumerate(merged, start=1):
        body = decode_unicode_escapes_maybe(body)
        lines.append(str(i))
        lines.append(fmt_time(start) + " --> " + fmt_time(end))
        lines.append(body)
        lines.append("")
    content = "\n".join(lines)
    # FCP 导入中文字幕时，UTF-8 with BOM 更稳
    out.write_text(content, encoding="utf-8-sig")
    out_plain.write_text(content, encoding="utf-8")

    msg = "FCP 字幕 SRT 生成完成：合并 " + str(used) + " 段，跳过 " + str(skipped) + " 段，共 " + str(len(merged)) + " 条字幕。"
    log_write(log_path, msg)
    log_write(log_path, "已输出 FCP 推荐版 UTF-8-BOM：" + str(out))
    log_write(log_path, "已输出普通 UTF-8 备份：" + str(out_plain))
    update_task_status(project, "fcpsubtitle", "done", msg)
    return 0

if __name__ == "__main__":
    sys.exit(main())
