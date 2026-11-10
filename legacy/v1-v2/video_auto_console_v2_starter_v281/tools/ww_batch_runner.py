#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from pathlib import Path
from datetime import datetime
import subprocess, time, re, sys, shlex, os, json, shutil

AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".aac", ".flac"}
SUB_EXTS = {".srt", ".vtt"}
WW_OUTPUT_EXTS = {".srt", ".vtt", ".tsv", ".txt", ".json"}



def looks_like_srt_text(txt):
    try:
        sample = str(txt)[:5000]
        return "-->" in sample and bool(re.search(r"\d{1,2}:\d{2}:\d{2}[\.,]\d{1,3}", sample))
    except Exception:
        return False

def looks_like_srt(path):
    try:
        txt = Path(path).read_text(encoding="utf-8", errors="ignore")[:2000]
        return "-->" in txt and bool(re.search(r"\d{1,2}:\d{2}:\d{2}[\.,]\d{1,3}", txt))
    except Exception:
        return False

def looks_like_json_text(path):
    try:
        txt = Path(path).read_text(encoding="utf-8", errors="ignore").lstrip()[:20]
        return txt.startswith("{") or txt.startswith("[")
    except Exception:
        return False

def json_text_to_basic_srt(src_path, dst_path, duration=8.0):
    try:
        raw = Path(src_path).read_text(encoding="utf-8", errors="ignore").strip()
        data = json.loads(raw)
        text = ""
        if isinstance(data, dict):
            text = data.get("text", "") or ""
            if not text and isinstance(data.get("segments"), list):
                text = " ".join([x.get("text","") for x in data["segments"] if isinstance(x, dict)])
        elif isinstance(data, list):
            text = " ".join([x.get("text","") for x in data if isinstance(x, dict)])
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            return False
        parts = re.split(r"(?<=[。！？!?])", text)
        chunks = []
        for p in parts:
            p = p.strip()
            if not p:
                continue
            while len(p) > 32:
                chunks.append(p[:32])
                p = p[32:]
            if p:
                chunks.append(p)
        if not chunks:
            chunks = [text]
        per = max(1.2, duration / len(chunks))
        def fmt(sec):
            ms_total = max(0, int(round(sec * 1000)))
            ms = ms_total % 1000
            total = ms_total // 1000
            s = total % 60
            total //= 60
            m = total % 60
            h = total // 60
            return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
        lines = []
        t = 0.0
        for i, body in enumerate(chunks, 1):
            lines += [str(i), fmt(t) + " --> " + fmt(t + per), body, ""]
            t += per
        Path(dst_path).write_text("\n".join(lines), encoding="utf-8")
        return True
    except Exception:
        return False

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

def snapshot_desktop(desktop):
    data = {}
    if desktop.exists():
        for f in desktop.iterdir():
            if f.is_file() and f.suffix.lower() in WW_OUTPUT_EXTS:
                try:
                    data[str(f)] = f.stat().st_mtime
                except Exception:
                    pass
    return data

def newest_changed_subtitle(desktop, before):
    after = snapshot_desktop(desktop)
    candidates = []
    for path_s, mt in after.items():
        if path_s not in before or mt > before.get(path_s, 0):
            candidates.append(Path(path_s))
    candidates.sort(key=lambda x: x.stat().st_mtime if x.exists() else 0, reverse=True)
    return candidates[0] if candidates else None

def changed_outputs(desktop, before):
    after = snapshot_desktop(desktop)
    candidates = []
    for path_s, mt in after.items():
        if path_s not in before or mt > before.get(path_s, 0):
            candidates.append(Path(path_s))
    candidates.sort(key=lambda x: x.stat().st_mtime if x.exists() else 0, reverse=True)
    return candidates

def archive_ww_outputs(project, desktop, before, audio_stem, log_path):
    """失败时也把 ww 留在桌面的副产物移走，避免桌面越堆越乱。"""
    candidates = changed_outputs(desktop, before)
    for ext in WW_OUTPUT_EXTS:
        guess = desktop / (audio_stem + ext)
        if guess.exists() and guess not in candidates:
            candidates.append(guess)
    if not candidates:
        return
    target = project / "99-临时文件" / "whisper" / (datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + audio_stem)
    target.mkdir(parents=True, exist_ok=True)
    moved = 0
    for f in candidates:
        try:
            if not f.exists() or f.parent != desktop or f.suffix.lower() not in WW_OUTPUT_EXTS:
                continue
            dst = target / f.name
            if dst.exists():
                dst = target / (f.stem + "-" + datetime.now().strftime("%H%M%S") + f.suffix)
            shutil.move(str(f), str(dst))
            moved += 1
        except Exception as e:
            log_write(log_path, "转移桌面临时文件失败：" + str(f) + " / " + str(e))
    if moved:
        log_write(log_path, "已把失败时的桌面临时文件转移到：" + str(target))

def cleanup_ww_outputs(desktop, before, audio_stem, keep_path, log_path):
    candidates = changed_outputs(desktop, before)
    for ext in WW_OUTPUT_EXTS:
        guess = desktop / (audio_stem + ext)
        if guess.exists() and guess not in candidates:
            candidates.append(guess)

    seen = set()
    cleaned = 0
    for f in candidates:
        try:
            if not f.exists():
                continue
            if str(f) in seen:
                continue
            seen.add(str(f))
            if keep_path is not None and f.resolve() == keep_path.resolve():
                continue
            if f.parent != desktop:
                continue
            if f.suffix.lower() not in WW_OUTPUT_EXTS:
                continue
            # 只清理本次音频相关文件，或本次 ww 新生成的字幕副产物
            if f.stem != audio_stem and f not in changed_outputs(desktop, before):
                continue
            f.unlink()
            cleaned += 1
            log_write(log_path, "已清理桌面临时文件：" + str(f))
        except Exception as e:
            log_write(log_path, "清理桌面临时文件失败：" + str(f) + " / " + str(e))
    if cleaned == 0:
        log_write(log_path, "没有需要清理的桌面临时文件。")

def convert_vtt_to_srt(text):
    lines = []
    for line in text.splitlines():
        if line.strip().upper() == "WEBVTT":
            continue
        if "-->" in line:
            line = line.replace(".", ",")
        lines.append(line)
    return "\n".join(lines).strip() + "\n"

def clean_chinese_punctuation(text):
    protected = {}
    def protect(m):
        key = "__PROTECT_" + str(len(protected)) + "__"
        protected[key] = m.group(0)
        return key

    patterns = [
        r'https?://[^\s]+',
        r'\b\d+\.\d+\.\d+\.\d+\b',
        r'\b\d+\.\d+\b',
        r'\b\w+\.(mp4|mov|srt|wav|mp3|m4a|png|jpg|jpeg)\b',
        r'\b(FCP|PWA|GPT|Codex|ChatGPT|Final Cut Pro|B站|小红书)\b',
    ]
    for pat in patterns:
        text = re.sub(pat, protect, text, flags=re.I)

    text = text.replace(",", "，").replace("?", "？").replace("!", "！").replace(";", "；")
    text = re.sub(r'(?<!\d)\.(?!\d)', '。', text)
    text = text.replace(":", "：")

    text = re.sub(
        r'(\d{2})：(\d{2})：(\d{2})，(\d{3}) --> (\d{2})：(\d{2})：(\d{2})，(\d{3})',
        r'\1:\2:\3,\4 --> \5:\6:\7,\8',
        text
    )

    for k, v in protected.items():
        text = text.replace(k, v)
    return text

def main():
    project = None
    success_count = 0
    error_count = 0

    try:
        if len(sys.argv) < 2:
            print("缺少项目路径")
            return 1

        project = Path(sys.argv[1]).expanduser()
        control = project / "00-总控表"
        voice_dir = project / "04-配音"
        subtitle_dir = project / "05-字幕"
        log_dir = control / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        subtitle_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "subtitle-log.md"

        log_write(log_path, "\n## " + datetime.now().strftime("%Y-%m-%d %H:%M:%S") + " 批量生成字幕")
        log_write(log_path, "项目：" + str(project))
        update_task_status(project, "subtitle", "running", "正在生成字幕……")
        log_write(log_path, "配音目录：" + str(voice_dir))
        log_write(log_path, "字幕目录：" + str(subtitle_dir))

        if not voice_dir.exists():
            msg = "没有找到 04-配音 文件夹。"
            log_write(log_path, msg)
            update_task_status(project, "subtitle", "error", msg)
            return 2

        audio_files = sorted([p for p in voice_dir.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXTS])
        if not audio_files:
            msg = "没有找到配音文件，字幕未生成。"
            log_write(log_path, msg)
            update_task_status(project, "subtitle", "error", msg)
            return 2

        desktop = Path.home() / "Desktop"
        per_file_timeout = int(os.environ.get("VIDEO_CONSOLE_WW_TIMEOUT", "900"))
        log_write(log_path, "单个配音最大等待：" + str(per_file_timeout) + " 秒。")

        for audio in audio_files:
            log_write(log_path, "\n开始处理：" + audio.name)
            before = snapshot_desktop(desktop)

            # 通过 zsh 登录式环境读取用户的 ww alias/function/path。
            shell_cmd = "source ~/.zshrc 2>/dev/null; ww " + shlex.quote(str(audio))
            log_write(log_path, "执行命令：/bin/zsh -lc " + shell_cmd)

            try:
                r = subprocess.run(["/bin/zsh", "-lc", shell_cmd], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=per_file_timeout)
            except subprocess.TimeoutExpired as e:
                log_write(log_path, "执行 ww 超时，已停止等待：" + str(per_file_timeout) + " 秒。")
                if getattr(e, "stdout", None):
                    try:
                        log_write(log_path, str(e.stdout).strip())
                    except Exception:
                        pass
                archive_ww_outputs(project, desktop, before, audio.stem, log_path)
                error_count += 1
                continue
            except Exception as e:
                log_write(log_path, "执行 ww 出错：" + str(e))
                archive_ww_outputs(project, desktop, before, audio.stem, log_path)
                error_count += 1
                continue

            if r.stdout:
                log_write(log_path, r.stdout.strip())

            if r.returncode != 0:
                log_write(log_path, "ww 返回错误码：" + str(r.returncode))
                log_write(log_path, "如果仍提示找不到 ww，请在 iTerm2 输入：type ww，把结果发给 ChatGPT。")
                archive_ww_outputs(project, desktop, before, audio.stem, log_path)
                error_count += 1
                continue

            all_outputs = changed_outputs(desktop, before)
            for ext in WW_OUTPUT_EXTS:
                p = desktop / (audio.stem + ext)
                if p.exists() and p not in all_outputs:
                    all_outputs.append(p)

            subtitle_candidates = [p for p in all_outputs if p.suffix.lower() in SUB_EXTS]
            valid_subtitles = [p for p in subtitle_candidates if looks_like_srt(p)]

            produced = None
            mode = "real_srt"
            if valid_subtitles:
                valid_subtitles.sort(key=lambda x: x.stat().st_mtime if x.exists() else 0, reverse=True)
                produced = valid_subtitles[0]
            else:
                json_candidates = [p for p in all_outputs if p.suffix.lower() == ".json" or looks_like_json_text(p)]
                json_candidates.sort(key=lambda x: x.stat().st_mtime if x.exists() else 0, reverse=True)
                if json_candidates:
                    produced = json_candidates[0]
                    mode = "json_fallback"

            if produced is None:
                log_write(log_path, "未发现可用字幕。桌面新文件：" + " / ".join([x.name for x in all_outputs]))
                archive_ww_outputs(project, desktop, before, audio.stem, log_path)
                error_count += 1
                continue

            expected = subtitle_dir / (audio.stem + ".srt")
            log_write(log_path, "发现字幕源：" + str(produced) + "，模式：" + mode)

            try:
                if mode == "json_fallback":
                    ok = json_text_to_basic_srt(produced, expected, duration=8.0)
                    if not ok:
                        raise RuntimeError("JSON/text 兜底转 SRT 失败")
                    log_write(log_path, "没有发现真实 SRT/VTT，已用 JSON/text 兜底生成基础 SRT：" + str(expected))
                else:
                    if produced.suffix.lower() == ".vtt":
                        text = convert_vtt_to_srt(produced.read_text(encoding="utf-8", errors="ignore"))
                    else:
                        text = produced.read_text(encoding="utf-8", errors="ignore")
                    text = clean_chinese_punctuation(text)
                    if not looks_like_srt_text(text):
                        raise RuntimeError("候选文件没有有效时间轴，拒绝保存为正式 SRT")
                    expected.write_text(text, encoding="utf-8")
                    log_write(log_path, "已保存真实时间轴字幕：" + str(expected))
                success_count += 1
                cleanup_ww_outputs(desktop, before, audio.stem, expected, log_path)
            except Exception as e:
                log_write(log_path, "处理字幕文件失败：" + str(e))
                archive_ww_outputs(project, desktop, before, audio.stem, log_path)
                error_count += 1
                continue

        final_state = "done" if error_count == 0 else "error"
        final_msg = "字幕完成：成功 " + str(success_count) + " 个，失败 " + str(error_count) + " 个。"
        update_task_status(project, "subtitle", final_state, final_msg)
        log_write(log_path, "\n" + final_msg)
        log_write(log_path, "字幕任务完成。")
        return 0 if error_count == 0 else 5

    except Exception as e:
        # 最后一层兜底，防止顶部永远卡在运行中。
        if project is not None:
            try:
                control = project / "00-总控表"
                log_dir = control / "logs"
                log_dir.mkdir(parents=True, exist_ok=True)
                log_path = log_dir / "subtitle-log.md"
                log_write(log_path, "字幕任务异常：" + str(e))
                update_task_status(project, "subtitle", "error", "字幕任务异常：" + str(e))
            except Exception:
                pass
        else:
            print("字幕任务异常：" + str(e))
        return 9

if __name__ == "__main__":
    sys.exit(main())
