#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from pathlib import Path
import re, json, sys

def clean_line(s):
    return re.sub(r"^[\s#\-*：:0-9.、]+", "", s.strip()).strip()

def find_after_labels(text, labels):
    lines = text.splitlines()
    for i, line in enumerate(lines):
        raw = line.strip()
        for label in labels:
            # 标题：xxx / ## 标题
            m = re.match(r"^\s*#{0,6}\s*" + re.escape(label) + r"\s*[：:]\s*(.+?)\s*$", raw)
            if m:
                return m.group(1).strip()
            if re.match(r"^\s*#{0,6}\s*" + re.escape(label) + r"\s*$", raw):
                # 取后面第一个非空行
                for j in range(i + 1, min(i + 8, len(lines))):
                    val = lines[j].strip()
                    if val and not val.startswith("#"):
                        return clean_line(val)
    return ""

def section_between(text, start_labels, stop_labels):
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        raw = line.strip()
        for label in start_labels:
            if re.search(re.escape(label), raw, re.I):
                start = i + 1
                break
        if start is not None:
            break
    if start is None:
        return ""
    end = len(lines)
    for j in range(start, len(lines)):
        raw = lines[j].strip()
        if not raw:
            continue
        # 新的大标题/明显下一节
        if raw.startswith("#"):
            for stop in stop_labels:
                if re.search(re.escape(stop), raw, re.I):
                    end = j
                    break
        else:
            for stop in stop_labels:
                if re.match(r"^\s*(?:\d+[.、]\s*)?" + re.escape(stop) + r"\s*[：:]?\s*$", raw, re.I):
                    end = j
                    break
        if end != len(lines):
            break
    return "\n".join(lines[start:end]).strip()

def parse_tags(text):
    tags = []
    # hashtag
    for t in re.findall(r"#([\w\u4e00-\u9fff\-]+)", text):
        if t and t not in tags:
            tags.append(t)
    # 标签：AI, 剪辑, B站
    tag_line = find_after_labels(text, ["标签", "话题", "关键词", "Tags", "tags"])
    if tag_line:
        parts = re.split(r"[，,、\s]+", tag_line)
        for p in parts:
            p = p.strip().lstrip("#")
            if p and len(p) <= 20 and p not in tags:
                tags.append(p)
    return tags[:12]

def extract_platform(text, platform):
    stops = ["B站", "哔哩哔哩", "小红书", "抖音", "视频结构", "分段", "素材", "发布检查", "复盘", "标题", "标签"]
    if platform == "B站":
        starts = ["B站发布", "B站文案", "B站", "哔哩哔哩"]
    else:
        starts = ["小红书发布", "小红书文案", "小红书"]
    sec = section_between(text, starts, [s for s in stops if s not in starts])
    title = find_after_labels(sec, ["标题", "题目"]) or find_after_labels(text, [platform + "标题"])
    desc = find_after_labels(sec, ["正文", "简介", "文案", "描述"])
    if not desc:
        # 取 section 非标题/标签的正文
        lines = []
        for line in sec.splitlines():
            raw = line.strip()
            if not raw:
                continue
            if any(k in raw for k in ["标题", "标签", "话题"]):
                continue
            if raw.startswith("#"):
                continue
            lines.append(raw)
        desc = "\n".join(lines[:12]).strip()
    return title, desc

def parse_plan(text, project_name):
    title = find_after_labels(text, ["标题", "视频标题", "主标题", "题目"]) or project_name
    desc = find_after_labels(text, ["简介", "正文", "发布正文", "视频简介", "描述"]) or ""
    tags = parse_tags(text)

    b_title, b_desc = extract_platform(text, "B站")
    x_title, x_desc = extract_platform(text, "小红书")

    data = {
        "title": title,
        "desc": desc,
        "tags": tags,
        "B站": {
            "title": b_title or title,
            "desc": b_desc or desc,
            "tags": tags
        },
        "小红书": {
            "title": x_title or title,
            "desc": x_desc or desc,
            "tags": tags
        },
        "parser_note": "由 v2.5.1 从 ChatGPT 方案自动提取；如果不准，可在控制台发布区手动改。"
    }
    return data

def main():
    if len(sys.argv) < 2:
        print("缺少项目路径")
        return 1
    project = Path(sys.argv[1]).expanduser()
    control = project / "00-总控表"
    plan = control / "video-plan.md"
    out = control / "publish.json"
    if not plan.exists():
        print("未找到 video-plan.md")
        return 2
    text = plan.read_text(encoding="utf-8", errors="ignore")
    data = parse_plan(text, project.name)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print("已解析并写入：" + str(out))
    print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0

if __name__ == "__main__":
    sys.exit(main())
