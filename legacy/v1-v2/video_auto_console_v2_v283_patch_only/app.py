#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse, quote, unquote
from pathlib import Path
from datetime import datetime
import json, csv, shutil, html, subprocess, re, shlex

PORT = 8765
APP_DIR = Path(__file__).resolve().parent
TOOL_VERSION = "v2.8.3"
CONFIG_PATH = APP_DIR / "config.json"

DEFAULT_SEGMENTS = [
    ("01", "开头钩子"), ("02", "背景说明"), ("03", "过程推进"),
    ("04", "遇到问题"), ("05", "结果展示"), ("06", "结尾引导"),
    ("07", "补充展示"), ("08", "结尾补充"),
]
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".heic"}
AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".aac", ".flac"}
FIT_OPTIONS = [
    ("fill", "铺满裁切"), ("contain", "完整显示"), ("zoom_in", "轻微放大"),
    ("slow_zoom_in", "慢速推进"), ("slow_zoom_out", "慢速拉远"),
    ("pan_left_to_right", "左到右平移"), ("pan_right_to_left", "右到左平移"),
    ("pan_top_to_bottom", "上到下平移"), ("pan_bottom_to_top", "下到上平移"),
]
PROJECT_FOLDERS = [
    "00-总控表/logs", "01-原始素材/截图", "01-原始素材/录屏", "01-原始素材/其他",
    "02-精选素材", "03-分段素材包", "04-配音", "05-字幕", "06-粗剪输出",
    "07-FCP工程", "08-最终导出", "09-封面",
    "10-发布包/B站/v1", "10-发布包/小红书/v1",
    "11-复盘数据/01-数据截图",
    "99-临时文件/whisper", "99-临时文件/roughcut-cache",
    "99-临时文件/fcpxml-cache", "99-临时文件/backup",
]

def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def h(x):
    return html.escape(str(x))

def load_config():
    default_base = str(Path.home() / "Desktop" / "视频素材库")
    if CONFIG_PATH.exists():
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        base = str(cfg.get("base_dir", ""))
        # 修复旧包里误写入的打包环境路径 /home/oai 或 /mnt/data
        changed = False
        if (not base) or base.startswith("/home/oai") or base.startswith("/mnt/data"):
            cfg["base_dir"] = default_base
            changed = True
        last_project = str(cfg.get("last_project", ""))
        if last_project.startswith("/home/oai") or last_project.startswith("/mnt/data"):
            cfg["last_project"] = ""
            changed = True
        if changed:
            CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        return cfg
    cfg = {"base_dir": default_base, "last_project": "", "prefer_terminal": "iTerm2"}
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return cfg

def save_config(cfg):
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

def read_json(path, default):
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return default

def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

def safe_name(name):
    name = name.strip().replace("/", "-").replace("\\", "-")
    return name or "未命名视频-" + datetime.now().strftime("%Y%m%d-%H%M%S")

def paths(root):
    root = Path(root)
    return {
        "root": root, "control": root / "00-总控表", "selected": root / "02-精选素材",
        "pack": root / "03-分段素材包", "voice": root / "04-配音", "subtitle": root / "05-字幕",
        "rough": root / "06-粗剪输出", "fcp": root / "07-FCP工程", "final": root / "08-最终导出",
        "publish": root / "10-发布包", "review": root / "11-复盘数据", "tmp": root / "99-临时文件",
    }

def default_segments(count):
    count = max(4, min(8, int(count)))
    out = []
    for sid, name in DEFAULT_SEGMENTS[:count]:
        out.append({"id": sid, "name": name, "voice": sid + "-" + name + ".wav", "subtitle": sid + "-" + name + ".srt", "roughcut": sid + "-" + name + ".mp4", "script": ""})
    return out

def segment_key(seg):
    return seg["id"] + "-" + seg["name"]

def log(root, action, message):
    p = paths(root)
    f = p["control"] / "logs" / "app-log.md"
    f.parent.mkdir(parents=True, exist_ok=True)
    with f.open("a", encoding="utf-8") as fp:
        fp.write("\n## " + now() + " - " + action + "\n\n" + message + "\n")

def create_project(project_name, count, base_dir):
    root = Path(base_dir).expanduser() / safe_name(project_name)
    for folder in PROJECT_FOLDERS:
        (root / folder).mkdir(parents=True, exist_ok=True)
    segs = default_segments(count)
    for s in segs:
        (root / "03-分段素材包" / segment_key(s)).mkdir(parents=True, exist_ok=True)
    p = paths(root)
    project = {"project_name": root.name, "created_at": now(), "project_path": str(root), "segment_count": len(segs), "platforms": ["B站", "小红书"], "prefer_terminal": "iTerm2"}
    write_json(p["control"] / "project.json", project)
    write_json(p["control"] / "segments.json", {"segments": segs})
    write_json(p["control"] / "segment-assets.json", {segment_key(s): [] for s in segs})
    write_json(p["control"] / "publish.json", {"B站": {"versions": {}}, "小红书": {"versions": {}}})
    write_json(p["review"] / "复盘数据.json", {"B站": {}, "小红书": {}})
    with (p["control"] / "segments.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["编号", "段落名称", "口播文件", "字幕文件", "粗剪文件", "口播文案"])
        for s in segs:
            w.writerow([s["id"], s["name"], s["voice"], s["subtitle"], s["roughcut"], ""])
    (p["control"] / "video-plan.md").write_text("# " + root.name + "\n\n请在控制台导入 ChatGPT 视频方案。\n", encoding="utf-8")
    (p["control"] / "publish-plan.md").write_text("# 发布方案\n\n", encoding="utf-8")
    (p["control"] / "final-checklist.md").write_text("# 最终检查清单\n\n- [ ] 配音\n- [ ] 字幕\n- [ ] 分段素材包\n- [ ] 粗剪\n- [ ] FCPXML\n- [ ] final.mov\n- [ ] final.mp4\n- [ ] 发布包\n- [ ] 复盘\n", encoding="utf-8")
    log(root, "create_project", "创建项目：" + str(root))
    return root

def list_projects(base_dir):
    b = Path(base_dir).expanduser()
    if not b.exists():
        return []
    return [x for x in sorted(b.iterdir(), key=lambda y: y.stat().st_mtime, reverse=True) if x.is_dir() and (x / "00-总控表" / "project.json").exists()]

def get_segments(root):
    return read_json(paths(root)["control"] / "segments.json", {"segments": default_segments(6)}).get("segments", [])

def load_segment_assets(root):
    return read_json(paths(root)["control"] / "segment-assets.json", {})

def save_segment_assets(root, data):
    write_json(paths(root)["control"] / "segment-assets.json", data)
    log(root, "save_segment_assets", "保存素材顺序")

def scan_assets(root):
    p = paths(root)
    assets = []
    files = [f for f in sorted(p["selected"].iterdir()) if f.is_file() and not f.name.startswith(".")] if p["selected"].exists() else []

    # v2.8.3 保留修复：以前未按 A001/A002 命名的素材会显示成“未编号”，但下拉框实际 value 为空，
    # 所以点“添加到本段末尾”没有任何效果。现在扫描时自动给所有未编号/重复编号素材分配稳定可用的 Axxx。
    used = set()
    next_auto = 1
    for f in files:
        m = re.match(r"^(A\d{3,})[-_ ]?", f.name, re.I)
        original_aid = m.group(1).upper() if m else ""
        aid = original_aid
        if (not aid) or (aid in used):
            while True:
                candidate = "A" + str(next_auto).zfill(3)
                next_auto += 1
                if candidate not in used:
                    aid = candidate
                    break
        used.add(aid)
        ext = f.suffix.lower()
        typ = "图片" if ext in IMAGE_EXTS else "视频" if ext in VIDEO_EXTS else "音频" if ext in AUDIO_EXTS else "其他"
        assets.append({"id": aid, "filename": f.name, "path": str(f), "type": typ, "numbered": bool(original_aid), "autoId": not bool(original_aid)})

    write_json(p["control"] / "assets.json", {"assets": assets})
    with (p["control"] / "assets.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["素材ID", "类型", "文件名", "路径", "是否原始编号", "是否自动编号"])
        for a in assets:
            w.writerow([a["id"], a["type"], a["filename"], a["path"], "是" if a["numbered"] else "否", "是" if a.get("autoId") else "否"])
    log(root, "scan_assets", "扫描精选素材：" + str(len(assets)) + "；未编号素材已自动分配 Axxx")
    return assets

def load_assets(root):
    return read_json(paths(root)["control"] / "assets.json", {"assets": []}).get("assets", [])

def backup(root, action):
    p = paths(root)
    d = p["tmp"] / "backup" / (datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + action)
    d.mkdir(parents=True, exist_ok=True)
    for rel in ["00-总控表", "03-分段素材包", "10-发布包", "11-复盘数据"]:
        src = p["root"] / rel
        if src.exists():
            shutil.copytree(src, d / rel, dirs_exist_ok=True)
    log(root, "backup", "备份到：" + str(d))

def generate_packs(root, dry=False):
    p = paths(root)
    assets = {a["id"]: a for a in load_assets(root) if a.get("id")}
    seg_assets = load_segment_assets(root)
    lines = []
    if not dry:
        backup(root, "generate-segment-packs")
    for key, items in seg_assets.items():
        target = p["pack"] / key
        if not dry:
            target.mkdir(parents=True, exist_ok=True)
            for old in target.iterdir():
                if old.is_file():
                    old.unlink()
        for i, item in enumerate(items, 1):
            aid = item.get("assetId")
            a = assets.get(aid)
            if not a:
                lines.append("[跳过] " + key + " 找不到 " + str(aid))
                continue
            src = Path(a["path"])
            dstname = str(i).zfill(3) + "-" + src.name
            lines.append(src.name + " -> " + key + "/" + dstname)
            if not dry:
                shutil.copy2(src, target / dstname)
    log(root, "generate_packs", "dry" if dry else "done")
    return "\n".join(lines) or "没有可生成内容"


def voice_exists_for_segment(voice_dir, expected_voice_name):
    expected = voice_dir / expected_voice_name
    if expected.exists():
        return True
    stem = Path(expected_voice_name).stem
    for ext in AUDIO_EXTS:
        if (voice_dir / (stem + ext)).exists():
            return True
    return False

def calc_status(root):
    p = paths(root)
    chosen = load_segment_assets(root)
    rows = []
    for s in get_segments(root):
        key = segment_key(s)
        items = chosen.get(key, [])
        pack = p["pack"] / key
        missing = []
        if not items: missing.append("未选择素材")
        if not voice_exists_for_segment(p["voice"], s["voice"]): missing.append("缺配音 " + Path(s["voice"]).stem + ".wav/mp3/m4a")
        if not ((p["subtitle"] / s["subtitle"]).exists()): missing.append("缺字幕 " + s["subtitle"])
        if not (pack.exists() and any(pack.iterdir())): missing.append("分段素材包未生成")
        if not ((p["rough"] / s["roughcut"]).exists()): missing.append("缺粗剪 " + s["roughcut"])
        rows.append({"seg": s, "key": key, "items": items, "missing": missing,
                     "voice": voice_exists_for_segment(p["voice"], s["voice"]),
                     "subtitle": (p["subtitle"] / s["subtitle"]).exists(),
                     "pack": pack.exists() and any(pack.iterdir()),
                     "rough": (p["rough"] / s["roughcut"]).exists()})
    return rows

def open_path(path):
    try:
        subprocess.Popen(["open", str(path)])
        return "已打开"
    except Exception as e:
        return "打开失败：" + str(e)


def project_url(root, seg=None):
    url = "/project?path=" + quote(str(root))
    if seg:
        url += "#seg-" + quote(str(seg))
    return url

def save_publish(root, data):
    p = paths(root)
    backup(root, "save-publish")
    content = {
        "B站": {"标题": data.get("b_title",""), "简介": data.get("b_desc",""), "标签": data.get("b_tags",""), "封面文案": data.get("b_cover","")},
        "小红书": {"标题": data.get("x_title",""), "正文": data.get("x_body",""), "标签": data.get("x_tags",""), "封面文案": data.get("x_cover","")}
    }
    for platform, fields in content.items():
        d = p["publish"] / platform / "v1"
        d.mkdir(parents=True, exist_ok=True)
        for k, v in fields.items():
            (d / (k + ".txt")).write_text(v, encoding="utf-8")
    write_json(p["control"] / "publish.json", {"v1": content})
    return "发布包已生成"

def save_review(root, data):
    p = paths(root)
    backup(root, "save-review")
    review = {
        "saved_at": now(),
        "B站": {"播放量": data.get("b_views",""), "点赞": data.get("b_likes",""), "评论": data.get("b_comments",""), "收藏": data.get("b_favorites",""), "投币": data.get("b_coins",""), "新增关注": data.get("b_followers",""), "备注": data.get("b_notes","")},
        "小红书": {"观看量": data.get("x_views",""), "点赞": data.get("x_likes",""), "收藏": data.get("x_favorites",""), "评论": data.get("x_comments",""), "新增关注": data.get("x_followers",""), "备注": data.get("x_notes","")}
    }
    write_json(p["review"] / "复盘数据.json", review)
    (p["review"] / "B站数据.md").write_text("# B站数据\n\n" + "\n".join(["- " + k + "：" + str(v) for k,v in review["B站"].items()]), encoding="utf-8")
    (p["review"] / "小红书数据.md").write_text("# 小红书数据\n\n" + "\n".join(["- " + k + "：" + str(v) for k,v in review["小红书"].items()]), encoding="utf-8")
    return "复盘数据已保存"


def run_in_iterm(command, cwd):
    def esc(s):
        return str(s).replace("\\", "\\\\").replace('"', '\\"')
    cwd_s = esc(cwd)
    cmd_s = esc(command)
    script = f"""
tell application "iTerm2"
    activate
    set newWindow to (create window with default profile)
    tell current session of newWindow
        write text "cd \\"{cwd_s}\\""
        write text "{cmd_s}"
    end tell
end tell
"""
    try:
        subprocess.Popen(["osascript", "-e", script])
        return "已在 iTerm2 中启动任务。"
    except Exception as e:
        return "iTerm2 启动失败：" + str(e)






def build_chatgpt_plan_prompt(root):
    segs = get_segments(root)
    seg_lines = []
    for s in segs:
        seg_lines.append(s["id"] + "-" + s["name"])
    segments_text = "\n".join(["- " + x for x in seg_lines])
    return """请你按下面固定格式，为我的这条视频生成完整视频方案和发布方案。必须保留这些一级标题，方便我的本地视频控制台解析。

项目名：
""" + root.name + """

视频定位：
这是我的个人副业/项目开发记录视频，风格真实、口语化、不鸡血、不像教程。主要发布到 B站 和 小红书。

分段结构：
""" + segments_text + """

请输出以下内容：

# 标题
给我 3 个标题候选，选一个最推荐的放在第一行。

# 简介
写一段适合 B站/小红书通用的视频简介。

# 标签
给 8-12 个标签，用 # 开头。

# 视频结构
按分段结构输出。每段必须包含：
- 段落名
- 这一段要讲什么
- 口播文案
- 需要哪些素材
- 画面节奏建议

# B站
## 标题
写 1 个适合 B站的标题。

## 正文
写 B站简介，偏完整说明，可以稍微长一点。

## 标签
写适合 B站的标签。

# 小红书
## 标题
写 1 个适合小红书的标题。

## 正文
写小红书正文，偏真实记录、口语化，别太营销。

## 标签
写适合小红书的标签。

# 发布检查
列出发布前需要检查的事项。

# 复盘指标
列出发布后我需要记录哪些数据。
"""



def build_demo_video_plan(root):
    return """# 标题
测试视频：我正在搭一个自己的半自动剪辑控制台
做视频最麻烦的不是剪辑，是每一步都散在不同地方
从素材到发布，我想把流程先串起来

# 简介
这是一条用于测试本地视频控制台流程的视频方案。它不是正式发布内容，只用来验证：方案导入后，控制台能不能把每段口播、素材需求和画面节奏正确显示到分段素材编辑区。

# 标签
#视频剪辑 #自媒体工具 #AI工作流 #FinalCutPro #B站创作 #小红书创作 #副业记录 #本地工具 #Mac效率

# 视频结构

## 01-开头钩子
- 这一段要讲什么：用一句话说明为什么要做这个控制台：不是为了炫技，而是为了少重复劳动。
- 口播文案：我发现我做视频最卡的地方，不是不会剪，而是每次都要重新整理素材、配音、字幕、发布包。于是我干脆先搭一个自己的视频控制台。
- 需要哪些素材：控制台首页截图；项目文件夹截图；之前视频成片截图。
- 画面节奏建议：开头节奏快一点，2-3 个画面快速切换，先抛出问题。

## 02-背景说明
- 这一段要讲什么：说明为什么普通剪辑流程对新手很散，素材、字幕、粗剪、发布都分开。
- 口播文案：以前我每做一条视频，都要在文件夹、剪辑软件、字幕工具、发布平台之间来回跳。东西不是做不了，是太散了，很容易漏。
- 需要哪些素材：桌面文件夹截图；FCP 工程截图；字幕文件截图。
- 画面节奏建议：画面可以慢一点，展示“散”的感觉。

## 03-过程推进
- 这一段要讲什么：展示控制台已经能完成的流程：素材扫描、分段选择、生成字幕、运行粗剪。
- 口播文案：现在这个控制台已经能做几件事：扫描精选素材，按分段选择素材，生成分段素材包，再生成字幕和粗剪。
- 需要哪些素材：素材扫描界面；分段素材选择界面；字幕生成结果；粗剪输出文件夹。
- 画面节奏建议：按步骤推进，每一步停留 2-4 秒。

## 04-遇到问题
- 这一段要讲什么：说明开发过程中遇到的问题，比如状态显示不清楚、iTerm2 开太多、没有配音也生成粗剪。
- 口播文案：中间也不是一下就顺了。比如一开始每跑一次任务就开一个 iTerm2，后来改成后台运行；还有没有配音也生成粗剪，这个也改掉了。
- 需要哪些素材：iTerm2 多窗口截图；顶部任务提醒截图；粗剪跳过日志截图。
- 画面节奏建议：可以用截图配合口播，突出“边用边改”。

## 05-结果展示
- 这一段要讲什么：展示现在完整主链路已经跑通到 FCPXML、mov 转 mp4、发布包。
- 口播文案：到现在为止，主链路基本串起来了：素材、字幕、粗剪、FCPXML、转码、发布包，都能从一个控制台里往下走。
- 需要哪些素材：FCPXML 文件夹；FCP 导入界面；最终 mp4；发布包文件夹。
- 画面节奏建议：展示成果，画面要干净，少放无关内容。

## 06-结尾引导
- 这一段要讲什么：说明这还不是最终产品，只是把自己的创作流程慢慢工具化。
- 口播文案：这不是一个多厉害的软件，更像是我把自己做视频的流程一点点固定下来。后面我会继续把字幕、方案解析和复盘也补完整。
- 需要哪些素材：控制台总览；下一步计划截图；最终项目文件夹截图。
- 画面节奏建议：节奏放慢，收束到“持续迭代”。

# B站
## 标题
我给自己做了一个视频剪辑控制台，终于不用每次从零整理素材了

## 正文
这条视频是一个流程测试记录。核心不是讲教程，而是记录我怎么把做视频时重复的步骤，慢慢整理成一个本地控制台：素材扫描、分段素材包、字幕、粗剪、FCPXML、转码和发布包。现在还不是最终版，但主链路已经跑通了。

## 标签
#视频剪辑 #FinalCutPro #自媒体工具 #AI工作流 #Mac效率 #副业记录

# 小红书
## 标题
我开始给自己做一个视频剪辑控制台了

## 正文
每次做视频最烦的不是剪，而是整理素材、配音、字幕、发布包这些小步骤太散。  
所以我先做了一个自己的本地视频控制台，把这些流程串起来。  
现在已经能跑到粗剪、FCPXML、转码和发布包了，后面继续慢慢补完整。

## 标签
#视频剪辑 #自媒体工具 #Mac效率 #AI工作流 #普通人做副业 #FinalCutPro

# 发布检查
- 确认视频没有暴露路径、账号、隐私信息
- 确认封面清晰
- 确认标题和正文没有错字
- 确认 B站 和 小红书 文案分开检查
- 发布后保存数据截图

# 复盘指标
- 播放量
- 完播率
- 点赞
- 收藏
- 评论
- 转发
- 新增关注
- B站和小红书数据差异
"""

def split_plan_sections(text):
    sections = {}
    current = None
    buf = []
    for line in text.splitlines():
        m = re.match(r"^\s*#\s+(.+?)\s*$", line)
        if m:
            if current:
                sections[current] = "\n".join(buf).strip()
            current = m.group(1).strip()
            buf = []
        else:
            if current:
                buf.append(line)
    if current:
        sections[current] = "\n".join(buf).strip()
    return sections

def segment_block_from_plan(text, seg_id, seg_name):
    # 优先从“视频结构”大段中找 01-开头钩子；找不到再全局找。
    # v2.8.3 保留修复：兼容“01-开头钩子 / 1. 开头钩子 / 第1段：开头钩子 / 开头钩子”。
    sections = split_plan_sections(text)
    scope = sections.get("视频结构", text)
    sid_num = str(int(seg_id)) if str(seg_id).isdigit() else str(seg_id).lstrip("0")
    sid_pat = r"(?:" + re.escape(seg_id) + r"|0?" + re.escape(sid_num) + r")"
    next_seg_pat = r"^\s*(?:#{2,6}\s*)?(?:第\s*)?(?:\d{1,2})(?:\s*段)?\s*[-_— .、：:]"
    patterns = [
        r"(?ms)^\s*(?:#{2,6}\s*)?(?:第\s*)?" + sid_pat + r"(?:\s*段)?\s*[-_— .、：:]\s*" + re.escape(seg_name) + r".*?(?=" + next_seg_pat + r"|\Z)",
        r"(?ms)^\s*(?:#{2,6}\s*)?" + re.escape(seg_name) + r".*?(?=" + next_seg_pat + r"|\Z)",
    ]
    for pat in patterns:
        m = re.search(pat, scope)
        if m:
            return m.group(0).strip()
    return ""

def extract_field_from_block(block, labels):
    if not block:
        return ""
    lines = block.splitlines()
    for i, line in enumerate(lines):
        raw = line.strip()
        for label in labels:
            # - 口播文案：xxx
            m = re.match(r"^\s*(?:[-*]\s*)?" + re.escape(label) + r"\s*[：:]\s*(.*)$", raw)
            if m:
                first = m.group(1).strip()
                collected = []
                if first:
                    collected.append(first)
                # 收集后续缩进行/列表，直到遇到下一个字段
                for j in range(i + 1, len(lines)):
                    nxt = lines[j].rstrip()
                    nxt_raw = nxt.strip()
                    if not nxt_raw:
                        if collected:
                            break
                        continue
                    if re.match(r"^\s*(?:[-*]\s*)?(段落名|这一段要讲什么|口播文案|需要哪些素材|素材需求|画面节奏建议|节奏建议)\s*[：:]", nxt_raw):
                        break
                    # 如果是下一段标题，也停止
                    if re.match(r"^\s*(?:#{2,6}\s*)?\d{2}\s*[-_— ]", nxt_raw):
                        break
                    collected.append(clean_plan_line(nxt_raw))
                return "\n".join([x for x in collected if x]).strip()
    return ""

def parse_plan_segments(text, segments):
    parsed = {}
    for s in segments:
        sid = s.get("id", "")
        name = s.get("name", "")
        block = segment_block_from_plan(text, sid, name)
        parsed[sid + "-" + name] = {
            "goal": extract_field_from_block(block, ["这一段要讲什么", "要讲什么", "内容目标", "目标"]),
            "script": extract_field_from_block(block, ["口播文案", "口播", "文案"]),
            "assetNeeds": extract_field_from_block(block, ["需要哪些素材", "素材需求", "需要素材", "素材"]),
            "visualNotes": extract_field_from_block(block, ["画面节奏建议", "节奏建议", "画面建议", "画面节奏"]),
            "raw": block
        }
    return parsed

def enrich_segments_with_plan(root, plan_text):
    p = paths(root)
    seg_data = read_json(p["control"] / "segments.json", {"segments": default_segments(6)})
    segs = seg_data.get("segments", [])
    parsed = parse_plan_segments(plan_text, segs)
    for s in segs:
        key = s.get("id", "") + "-" + s.get("name", "")
        info = parsed.get(key, {})
        s["goal"] = info.get("goal", "")
        s["script"] = info.get("script", "")
        s["assetNeeds"] = info.get("assetNeeds", "")
        s["visualNotes"] = info.get("visualNotes", "")
        s["planRaw"] = info.get("raw", "")
    write_json(p["control"] / "segments.json", {"segments": segs})

    # 同步 csv，方便后续外部看
    with (p["control"] / "segments.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["编号", "段落名称", "口播文件", "字幕文件", "粗剪文件", "这一段要讲什么", "口播文案", "需要素材", "画面节奏建议"])
        for s in segs:
            w.writerow([s.get("id",""), s.get("name",""), s.get("voice",""), s.get("subtitle",""), s.get("roughcut",""), s.get("goal",""), s.get("script",""), s.get("assetNeeds",""), s.get("visualNotes","")])

def clean_plan_line(s):
    return re.sub(r"^[\s#\-*：:0-9.、]+", "", s.strip()).strip()

def find_plan_label(text, labels):
    lines = text.splitlines()
    for i, line in enumerate(lines):
        raw = line.strip()
        for label in labels:
            m = re.match(r"^\s*#{0,6}\s*" + re.escape(label) + r"\s*[：:]\s*(.+?)\s*$", raw)
            if m:
                return m.group(1).strip()
            if re.match(r"^\s*#{0,6}\s*" + re.escape(label) + r"\s*$", raw):
                for j in range(i + 1, min(i + 8, len(lines))):
                    val = lines[j].strip()
                    if val and not val.startswith("#"):
                        return clean_plan_line(val)
    return ""

def plan_section(text, start_labels, stop_labels):
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
        if raw.startswith("#") or re.match(r"^\s*\d+[.、]\s*", raw):
            for stop in stop_labels:
                if re.search(re.escape(stop), raw, re.I):
                    end = j
                    break
        if end != len(lines):
            break
    return "\n".join(lines[start:end]).strip()

def parse_plan_to_publish(text, project_name):
    title = find_plan_label(text, ["标题", "视频标题", "主标题", "题目"]) or project_name
    desc = find_plan_label(text, ["简介", "正文", "发布正文", "视频简介", "描述"]) or ""
    tags = []
    for t in re.findall(r"#([\w\u4e00-\u9fff\-]+)", text):
        if t and t not in tags:
            tags.append(t)
    tag_line = find_plan_label(text, ["标签", "话题", "关键词", "Tags", "tags"])
    if tag_line:
        for p in re.split(r"[，,、\s]+", tag_line):
            p = p.strip().lstrip("#")
            if p and p not in tags:
                tags.append(p)
    tags = tags[:12]

    def platform_data(platform):
        starts = [platform + "发布", platform + "文案", platform]
        stops = ["B站", "小红书", "抖音", "视频结构", "分段", "素材", "复盘", "发布检查"]
        sec = plan_section(text, starts, [x for x in stops if x != platform])
        p_title = find_plan_label(sec, ["标题", "题目"]) or title
        p_desc = find_plan_label(sec, ["正文", "简介", "文案", "描述"])
        if not p_desc and sec:
            lines = []
            for line in sec.splitlines():
                raw = line.strip()
                if not raw or raw.startswith("#") or any(k in raw for k in ["标题", "标签", "话题"]):
                    continue
                lines.append(raw)
            p_desc = "\n".join(lines[:12]).strip()
        return {"title": p_title, "desc": p_desc or desc, "tags": tags}

    return {
        "title": title,
        "desc": desc,
        "tags": tags,
        "B站": platform_data("B站"),
        "小红书": platform_data("小红书"),
        "parser_note": "由 v2.5.1 从 ChatGPT 方案自动提取；如果不准，可在控制台发布区手动改。"
    }

def task_status_path(root):
    return paths(root)["control"] / "task-status.json"

def read_task_status(root):
    default = {
        "subtitle": {"state": "idle", "message": "字幕任务未运行", "updated_at": ""},
        "roughcut": {"state": "idle", "message": "粗剪任务未运行", "updated_at": ""},
        "fcpxml": {"state": "idle", "message": "FCPXML 未生成", "updated_at": ""},
        "convert": {"state": "idle", "message": "mov 转 mp4 未运行", "updated_at": ""},
        "publish": {"state": "idle", "message": "发布包未生成", "updated_at": ""},
        "fcpsubtitle": {"state": "idle", "message": "FCP 字幕 SRT 未生成", "updated_at": ""}
    }
    try:
        p = task_status_path(root)
        if p.exists():
            data = json.loads(p.read_text(encoding="utf-8"))
            for k, v in default.items():
                data.setdefault(k, v)
            return data
    except Exception:
        pass
    return default

def status_badge(item):
    state = item.get("state", "idle")
    if state == "running":
        return "<span class='warn'>运行中</span>"
    if state == "done":
        return "<span class='ok'>已完成</span>"
    if state == "error":
        return "<span class='bad'>有错误</span>"
    return "<span class='small'>未运行</span>"

def render_task_banner(root):
    data = read_task_status(root)
    sub = data.get("subtitle", {})
    rough = data.get("roughcut", {})
    fcp = data.get("fcpxml", {})
    conv = data.get("convert", {})
    pub = data.get("publish", {})
    fcpsub = data.get("fcpsubtitle", {})
    items = [
        ("字幕", sub),
        ("粗剪", rough),
        ("FCPXML", fcp),
        ("FCP字幕", fcpsub),
        ("转码", conv),
        ("发布包", pub),
    ]
    body = "<div class='card compact-status'>"
    body += "<div class='status-head'><b>当前任务</b> <a class='btn' href='/project?path=" + quote(str(root)) + "'>刷新</a> <a class='btn btn2' href='#logs'>日志</a></div>"
    body += "<div class='status-grid'>"
    for name, item in items:
        msg = item.get("message", "")
        updated = item.get("updated_at", "")
        short_msg = msg if len(msg) <= 38 else msg[:38] + "…"
        title = (msg + ("｜" + updated if updated else "")).strip()
        body += "<div class='status-item' title='" + h(title) + "'><b>" + h(name) + "：</b>" + status_badge(item) + "<span class='small'> " + h(short_msg) + "</span></div>"
    body += "</div></div>"
    return body

def read_tail(path, max_chars=6000):
    try:
        p = Path(path)
        if not p.exists():
            return "暂无日志。"
        text = p.read_text(encoding="utf-8", errors="ignore")
        if len(text) > max_chars:
            text = text[-max_chars:]
        return text
    except Exception as e:
        return "读取日志失败：" + str(e)

def render_log_block(root):
    p = paths(root)
    subtitle_log = p["control"] / "logs" / "subtitle-log.md"
    roughcut_log = p["control"] / "logs" / "roughcut-log.md"
    app_log = p["control"] / "logs" / "app-log.md"
    fcpxml_log = p["control"] / "logs" / "fcpxml-log.md"
    convert_log = p["control"] / "logs" / "convert-log.md"
    publish_log = p["control"] / "logs" / "publish-log.md"
    fcpsub_log = p["control"] / "logs" / "fcp-subtitle-log.md"
    body = "<div class='card' id='logs'><h2>任务日志</h2>"
    body += "<p class='small'>详细日志仅用于排查；平时看顶部“当前任务提醒”即可。</p>"
    body += "<details><summary>最近粗剪日志</summary><pre>" + h(read_tail(roughcut_log)) + "</pre></details>"
    body += "<details><summary>最近字幕日志</summary><pre>" + h(read_tail(subtitle_log)) + "</pre></details>"
    body += "<details><summary>最近 FCPXML 日志</summary><pre>" + h(read_tail(fcpxml_log)) + "</pre></details>"
    body += "<details><summary>最近转码日志</summary><pre>" + h(read_tail(convert_log)) + "</pre></details>"
    body += "<details><summary>最近发布包日志</summary><pre>" + h(read_tail(publish_log)) + "</pre></details>"
    body += "<details><summary>最近 FCP 字幕日志</summary><pre>" + h(read_tail(fcpsub_log)) + "</pre></details>"
    body += "<details><summary>控制台操作日志</summary><pre>" + h(read_tail(app_log)) + "</pre></details>"
    body += "<p><a class='btn' href='/open?path=" + quote(str(p["control"] / "logs")) + "'>打开日志文件夹</a>"
    body += "<a class='btn' href='/open?path=" + quote(str(p["tmp"] / "backup")) + "'>打开备份文件夹</a></p>"
    body += "</div>"
    return body


def run_background(command, cwd, log_file):
    try:
        log_path = Path(log_file)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as f:
            f.write("\n## " + now() + " 后台任务启动\n\n")
            f.write("工作目录：" + str(cwd) + "\n")
            f.write("命令：" + " ".join([str(x) for x in command]) + "\n\n")
        subprocess.Popen(command, cwd=str(cwd), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return "后台任务已启动。运行日志会写入：" + str(log_path)
    except Exception as e:
        return "后台任务启动失败：" + str(e)


def tool_root_path():
    try:
        return str(Path(__file__).resolve().parent)
    except Exception:
        return ""

def page(title, body, refresh=False):
    meta = "<meta http-equiv='refresh' content='3'>" if refresh else ""
    css = "<style>body{font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;margin:24px;background:#f7f7f8} .card{background:white;border:1px solid #ddd;border-radius:12px;padding:16px;margin:14px 0} input,textarea,select{width:100%;box-sizing:border-box;padding:8px;margin:4px 0} button,.btn{display:inline-block;background:#222;color:#fff;border:0;border-radius:8px;padding:8px 12px;margin:4px;text-decoration:none}.btn2{background:#666}.ok{color:green}.bad{color:#b3261e}.warn{color:#b26a00;font-weight:700}.small{color:#666;font-size:13px}.seg{border:1px solid #eee;border-radius:10px;padding:10px;margin:10px 0} pre{white-space:pre-wrap;background:#eee;padding:10px}.compact-status{padding:10px 14px}.status-head{display:flex;align-items:center;gap:6px}.status-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 16px}.status-item{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style>"
    return "<!doctype html><html><head><meta charset='utf-8'>" + meta + "<title>" + h(title) + "</title>" + css + "</head><body><h1>" + h(title) + "</h1>" + body + "</body></html>"

class Handler(BaseHTTPRequestHandler):
    def send(self, title, body, refresh=False):
        data = page(title, body, refresh).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, url):
        self.send_response(303)
        self.send_header("Location", url)
        self.end_headers()

    def post(self):
        n = int(self.headers.get("Content-Length", 0))
        data = parse_qs(self.rfile.read(n).decode("utf-8"))
        return {k: v[0] if v else "" for k,v in data.items()}

    def do_GET(self):
        cfg = load_config()
        u = urlparse(self.path)
        if u.path == "/":
            rows = ""
            for p in list_projects(cfg["base_dir"]):
                rows += "<li><a href='/project?path=" + quote(str(p)) + "'>" + h(p.name) + "</a><br><span class='small'>" + h(p) + "</span></li>"
            body = "<div class='card'><p class='small'><b>当前工具版本：</b>" + h(TOOL_VERSION) + "</p><p class='small'><b>当前工具路径：</b>" + h(tool_root_path()) + "</p><h2>创建新视频项目</h2><form method='post' action='/create'>项目名<input name='project_name' placeholder='第4条-盲盒PWA初稿完成'>分段数量<input name='segment_count' value='6'>项目总目录<input name='base_dir' value='" + h(cfg["base_dir"]) + "'><button>创建项目</button></form></div><div class='card'><h2>已有项目</h2><ul>" + (rows or "<li>还没有</li>") + "</ul></div>"
            self.send("视频剪辑自动化控制台 v2", body); return
        if u.path == "/project":
            q = parse_qs(u.query)
            root = Path(unquote(q.get("path", [""])[0]))
            notice = unquote(q.get("notice", [""])[0])
            if not root.exists():
                self.send("错误", "项目不存在"); return
            cfg["last_project"] = str(root); save_config(cfg)
            self.render_project(root, notice); return
        if u.path == "/open":
            target = Path(unquote(parse_qs(u.query).get("path", [""])[0]))
            msg = open_path(target)
            self.send("打开", "<p>" + h(msg) + "</p><p><a href='javascript:history.back()'>返回</a></p>"); return
        self.send("404", "Not found")

    def render_project(self, root, notice=""):
        p = paths(root)
        assets = load_assets(root)
        # 进入项目页时，如果 02-精选素材 已经有文件但还没扫描，自动补扫一次，避免“下拉有问题/选择不了”。
        if not assets and p["selected"].exists():
            try:
                has_files = any(x.is_file() and not x.name.startswith(".") for x in p["selected"].iterdir())
                if has_files:
                    assets = scan_assets(root)
            except Exception:
                pass
        st = calc_status(root)
        total = len(st)
        voice_ok = sum(1 for r in st if r["voice"])
        sub_ok = sum(1 for r in st if r["subtitle"])
        mat_ok = sum(1 for r in st if r["items"])
        pack_ok = sum(1 for r in st if r["pack"])
        rough_ok = sum(1 for r in st if r["rough"])
        next_step = "请把可用素材放入 02-精选素材，然后扫描。"
        if assets and voice_ok < total: next_step = "请放入分段配音。"
        elif assets and sub_ok < total: next_step = "请生成字幕。"
        elif assets and mat_ok < total: next_step = "请给每段选择素材、排序、设置时长和适配方式。"
        elif assets and pack_ok < total: next_step = "请生成分段素材包。"
        notice_html = ("<div class='card' style='border-color:#9ccf9c;background:#f6fff6'><b>操作结果：</b>" + h(notice) + "</div>") if notice else ""
        body = "<p><a href='/'>← 返回首页</a></p>" + notice_html + "<div class='card'><h2>" + h(root.name) + "</h2><p class='small'>" + h(root) + "</p><p class='small'><b>当前工具版本：</b>" + h(TOOL_VERSION) + "</p><p class='small'><b>当前工具路径：</b>" + h(tool_root_path()) + "</p><p><b>当前建议：</b>" + h(next_step) + "</p><p>素材 " + str(len(assets)) + "｜选择 " + str(mat_ok) + "/" + str(total) + "｜配音 " + str(voice_ok) + "/" + str(total) + "｜字幕 " + str(sub_ok) + "/" + str(total) + "｜素材包 " + str(pack_ok) + "/" + str(total) + "｜粗剪 " + str(rough_ok) + "/" + str(total) + "</p></div>" + render_task_banner(root) + "<div class='card'><h2>常用操作</h2><form method=\'post\' action=\'/generate_subtitles\' style=\'display:inline\'><input type=\'hidden\' name=\'project\' value=\'" + h(root) + "\'><button>批量生成字幕</button></form><form method='post' action='/generate_material_brief' style='display:inline'><input type='hidden' name='project' value='" + h(root) + "'><button>生成素材简报</button></form><form method='post' action='/run_roughcut' style='display:inline'>输出比例 <select name='preset' style='width:150px;display:inline-block'><option value='landscape' selected>横屏 1920×1080</option><option value='portrait'>竖屏 1080×1920</option><option value='square'>方屏 1080×1080</option></select><input type='hidden' name='project' value='" + h(root) + "'><button>运行粗剪</button></form><form method=\'post\' action=\'/generate_fcpxml\' style=\'display:inline\'><input type=\'hidden\' name=\'project\' value=\'" + h(root) + "\'><button>生成 FCPXML</button></form><form method='post' action='/generate_fcp_subtitle' style='display:inline'><input type='hidden' name='project' value='" + h(root) + "'><button>生成 FCP 字幕 SRT</button></form><form method=\'post\' action=\'/convert_mov\' style=\'display:inline\'><input type=\'hidden\' name=\'project\' value=\'" + h(root) + "\'><button>mov 转 mp4</button></form></div>"
        body += "<div class='card'><a class='btn' href='/project?path=" + quote(str(root)) + "'>刷新状态</a><a class='btn' href='/open?path=" + quote(str(root)) + "'>打开项目文件夹</a><a class='btn' href='/open?path=" + quote(str(p["selected"])) + "'>打开精选素材</a><a class='btn' href='/open?path=" + quote(str(p["pack"])) + "'>打开分段素材包</a><a class='btn' href='/open?path=" + quote(str(p["voice"])) + "'>打开配音</a><a class='btn' href='/open?path=" + quote(str(p["subtitle"])) + "'>打开字幕</a><form method='post' action='/scan_assets' style='display:inline'><input type='hidden' name='project' value='" + h(root) + "'><button>扫描精选素材</button></form><form method='post' action='/preview_packs' style='display:inline'><input type='hidden' name='project' value='" + h(root) + "'><button class='btn2'>试运行分段素材包</button></form><form method='post' action='/generate_packs' style='display:inline'><input type='hidden' name='project' value='" + h(root) + "'><button>生成分段素材包</button></form></div>"
        plan_text = (p["control"] / "video-plan.md").read_text(encoding="utf-8", errors="ignore") if (p["control"] / "video-plan.md").exists() else ""
        pub_json = read_json(p["control"] / "publish.json", {})
        pub_summary = "<p class='small'>当前提取：标题=" + h(pub_json.get("title", "未提取")) + "｜标签=" + h(" ".join(pub_json.get("tags", [])) if isinstance(pub_json.get("tags", []), list) else str(pub_json.get("tags", ""))) + "</p>"
        body += "<div class='card'><h2>导入 ChatGPT 方案</h2>" + pub_summary + "<form method='post' action='/import_plan'><input type='hidden' name='project' value='" + h(root) + "'><textarea name='plan' rows='12' placeholder='正式做视频时，把我给你的完整视频方案粘贴到这里。导入后，控制台会解析每段口播、素材需求、画面节奏，并显示到下面的分段素材编辑区。'>" + h(plan_text) + "</textarea><button>导入并解析方案</button></form><form method='post' action='/import_demo_plan' style='display:inline'><input type='hidden' name='project' value='" + h(root) + "'><button class='btn2'>填入测试方案并解析</button></form><p class='small'>现在建控制台阶段，没有真实方案也可以用“测试方案”验证解析功能；正式视频时不用测试方案。</p></div>"
        asset_options = "".join(["<option value='" + h(a.get("id","")) + "'>" + h(a.get("id","") + ("（自动）" if a.get("autoId") else "") + " - " + a["filename"]) + "</option>" for a in assets])
        fit_options = "".join(["<option value='" + k + "'>" + v + "</option>" for k,v in FIT_OPTIONS])
        chosen = load_segment_assets(root)
        body += "<div class='card'><h2>分段素材选择</h2>"
        for r in st:
            key = r["key"]
            body += "<div class='seg' id='seg-" + h(key) + "'><h3>" + h(key) + "</h3>"
            seg_obj = next((s for s in get_segments(root) if segment_key(s) == key), {})
            if seg_obj.get("script") or seg_obj.get("goal") or seg_obj.get("assetNeeds") or seg_obj.get("visualNotes"):
                body += "<div class='card' style='background:#fafafa'><h4>本段方案</h4>"
                if seg_obj.get("goal"):
                    body += "<p><b>这一段要讲什么：</b><br>" + h(seg_obj.get("goal","")).replace("\n","<br>") + "</p>"
                if seg_obj.get("script"):
                    body += "<p><b>本段口播：</b><br>" + h(seg_obj.get("script","")).replace("\n","<br>") + "</p>"
                if seg_obj.get("assetNeeds"):
                    body += "<p><b>需要素材：</b><br>" + h(seg_obj.get("assetNeeds","")).replace("\n","<br>") + "</p>"
                if seg_obj.get("visualNotes"):
                    body += "<p><b>画面节奏建议：</b><br>" + h(seg_obj.get("visualNotes","")).replace("\n","<br>") + "</p>"
                body += "</div>"
            else:
                body += "<p class='small'>本段还没有从导入方案中解析到口播/素材需求。导入我给你的标准视频方案后，这里会显示。</p>"
            body += "<p>"
            body += "素材：" + ("<span class='ok'>✅</span>" if r["items"] else "<span class='bad'>❌</span>") + "　"
            body += "配音：" + ("<span class='ok'>✅</span>" if r["voice"] else "<span class='bad'>❌</span>") + "　"
            body += "字幕：" + ("<span class='ok'>✅</span>" if r["subtitle"] else "<span class='bad'>❌</span>") + "　"
            body += "素材包：" + ("<span class='ok'>✅</span>" if r["pack"] else "<span class='bad'>❌</span>") + "　"
            body += "粗剪：" + ("<span class='ok'>✅</span>" if r["rough"] else "<span class='bad'>❌</span>")
            body += "</p>"
            body += "<p class='small'>缺失原因：<br>" + ("<br>".join([h(x) for x in r["missing"]]) or "无") + "</p>"
            body += "<h4>已选素材顺序</h4>"
            items = chosen.get(key, [])
            if not items: body += "<p class='small'>未选择</p>"
            for i, item in enumerate(items):
                body += "<div style='border:1px solid #eee;border-radius:8px;padding:8px;margin:6px 0;background:#fafafa'>"
                body += "<form method='post' action='/update_asset' style='display:inline'>"
                body += "<input type='hidden' name='project' value='" + h(root) + "'>"
                body += "<input type='hidden' name='segment' value='" + h(key) + "'>"
                body += "<input type='hidden' name='index' value='" + str(i) + "'>"
                body += "<b>" + str(i+1) + ". " + h(item.get("assetId","")) + "</b> "
                body += "时长（秒）<input name='duration' value='" + h(item.get("duration","")) + "' style='width:80px;display:inline-block'> "
                body += "适配 <select name='fit' style='width:150px;display:inline-block'>"
                for fk, fv in FIT_OPTIONS:
                    selected_attr = " selected" if item.get("fit") == fk else ""
                    body += "<option value='" + h(fk) + "'" + selected_attr + ">" + h(fv) + "</option>"
                body += "</select> <button>保存</button></form> "
                body += "<form method='post' action='/move_asset' style='display:inline'>"
                body += "<input type='hidden' name='project' value='" + h(root) + "'>"
                body += "<input type='hidden' name='segment' value='" + h(key) + "'>"
                body += "<input type='hidden' name='index' value='" + str(i) + "'>"
                body += "<button class='btn2' name='direction' value='up'>↑</button>"
                body += "<button class='btn2' name='direction' value='down'>↓</button>"
                body += "<button class='btn2' name='direction' value='delete'>删除</button></form></div>"
            body += "<form method='post' action='/add_asset'><input type='hidden' name='project' value='" + h(root) + "'><input type='hidden' name='segment' value='" + h(key) + "'>素材<select name='asset_id'>" + asset_options + "</select>显示时长（秒）<input name='duration'>适配方式<select name='fit'>" + fit_options + "</select><button>添加到本段末尾</button></form></div>"
        body += "</div>"
        body += "" + render_log_block(root) + "<div class='card'><h2>发布包</h2><form method='post' action='/generate_publish_pack' style='display:inline'><input type='hidden' name='project' value='" + h(root) + "'><button>生成发布包</button></form><form method='post' action='/save_publish'><input type='hidden' name='project' value='" + h(root) + "'><h3>B站</h3>标题<input name='b_title'>简介<textarea name='b_desc'></textarea>标签<input name='b_tags'>封面文案<input name='b_cover'><h3>小红书</h3>标题<input name='x_title'>正文<textarea name='x_body'></textarea>标签<input name='x_tags'>封面文案<input name='x_cover'><button>生成发布包 v1</button></form></div>"
        body += "<div class='card'><h2>复盘数据</h2><p class='small'>截图放入 11-复盘数据/01-数据截图</p><form method='post' action='/save_review'><input type='hidden' name='project' value='" + h(root) + "'><h3>B站</h3>播放量<input name='b_views'>点赞<input name='b_likes'>评论<input name='b_comments'>收藏<input name='b_favorites'>投币<input name='b_coins'>新增关注<input name='b_followers'>备注<textarea name='b_notes'></textarea><h3>小红书</h3>观看量<input name='x_views'>点赞<input name='x_likes'>收藏<input name='x_favorites'>评论<input name='x_comments'>新增关注<input name='x_followers'>备注<textarea name='x_notes'></textarea><button>保存复盘数据</button></form></div>"
        
        self.send("视频剪辑自动化控制台 v2", body, refresh=False)

    def do_POST(self):
        data = self.post(); path = urlparse(self.path).path
        if path == "/create":
            root = create_project(data.get("project_name",""), data.get("segment_count","6"), data.get("base_dir",""))
            cfg = load_config(); cfg["base_dir"] = data.get("base_dir", cfg["base_dir"]); cfg["last_project"] = str(root); save_config(cfg)
            self.redirect("/project?path=" + quote(str(root))); return
        if path == "/scan_assets":
            root = Path(data["project"]); scan_assets(root); self.redirect("/project?path=" + quote(str(root))); return
        if path == "/import_plan":
            root = Path(data["project"])
            plan_text = data.get("plan", "").strip()
            if not plan_text:
                self.redirect("/project?path=" + quote(str(root)) + "&notice=" + quote("方案框是空的，没有导入。")); return
            backup(root, "import-plan")
            p = paths(root)
            (p["control"] / "video-plan.md").write_text(plan_text, encoding="utf-8")
            publish_data = parse_plan_to_publish(plan_text, root.name)
            write_json(p["control"] / "publish.json", publish_data)
            enrich_segments_with_plan(root, plan_text)
            (p["control"] / "publish-plan.md").write_text("# 发布方案（自动提取）\n\n```json\n" + json.dumps(publish_data, ensure_ascii=False, indent=2) + "\n```\n", encoding="utf-8")
            segs = get_segments(root)
            parsed_count = sum(1 for s in segs if s.get("script") or s.get("goal") or s.get("assetNeeds") or s.get("visualNotes"))
            msg = "方案已导入，字数 " + str(len(plan_text)) + "，已解析分段 " + str(parsed_count) + "/" + str(len(segs)) + "。"
            log(root, "import_plan", msg)
            self.redirect("/project?path=" + quote(str(root)) + "&notice=" + quote(msg)); return
        if path == "/import_demo_plan":
            root = Path(data["project"])
            backup(root, "import-demo-plan")
            plan_text = build_demo_video_plan(root)
            p = paths(root)
            (p["control"] / "video-plan.md").write_text(plan_text, encoding="utf-8")
            publish_data = parse_plan_to_publish(plan_text, root.name)
            write_json(p["control"] / "publish.json", publish_data)
            enrich_segments_with_plan(root, plan_text)
            (p["control"] / "publish-plan.md").write_text("# 发布方案（测试方案自动提取）\n\n```json\n" + json.dumps(publish_data, ensure_ascii=False, indent=2) + "\n```\n", encoding="utf-8")
            msg = "测试方案已导入并解析。"
            log(root, "import_demo_plan", msg)
            self.redirect("/project?path=" + quote(str(root)) + "&notice=" + quote(msg)); return
        if path == "/add_asset":
            root = Path(data["project"]); seg = data["segment"]; aid = data.get("asset_id","")
            if aid:
                chosen = load_segment_assets(root); items = chosen.setdefault(seg, [])
                fit = data.get("fit","fill"); item = {"assetId": aid, "fit": fit, "fitLabel": dict(FIT_OPTIONS).get(fit, fit)}
                if data.get("duration","").strip(): item["duration"] = data.get("duration","").strip()
                items.append(item); save_segment_assets(root, chosen)
            self.redirect(project_url(root, seg)); return
        if path == "/update_asset":
            root = Path(data["project"]); seg = data["segment"]; idx = int(data["index"])
            chosen = load_segment_assets(root); items = chosen.get(seg, [])
            if 0 <= idx < len(items):
                fit = data.get("fit", items[idx].get("fit", "fill"))
                items[idx]["fit"] = fit
                items[idx]["fitLabel"] = dict(FIT_OPTIONS).get(fit, fit)
                duration = data.get("duration", "").strip()
                if duration:
                    items[idx]["duration"] = duration
                else:
                    items[idx].pop("duration", None)
                chosen[seg] = items
                save_segment_assets(root, chosen)
            self.redirect(project_url(root, seg)); return
        if path == "/move_asset":
            root = Path(data["project"]); seg = data["segment"]; idx = int(data["index"]); d = data["direction"]; chosen = load_segment_assets(root); items = chosen.get(seg, [])
            if 0 <= idx < len(items):
                if d == "up" and idx > 0: items[idx-1], items[idx] = items[idx], items[idx-1]
                elif d == "down" and idx < len(items)-1: items[idx+1], items[idx] = items[idx], items[idx+1]
                elif d == "delete": items.pop(idx)
                chosen[seg] = items; save_segment_assets(root, chosen)
            self.redirect(project_url(root, seg)); return
        if path == "/preview_packs":
            root = Path(data["project"]); msg = generate_packs(root, dry=True); self.send("试运行", "<pre>" + h(msg) + "</pre><p><a href='/project?path=" + quote(str(root)) + "'>返回</a></p>"); return
        if path == "/generate_packs":
            root = Path(data["project"]); msg = generate_packs(root, dry=False); self.send("生成完成", "<pre>" + h(msg) + "</pre><p><a href='/project?path=" + quote(str(root)) + "'>返回</a></p>"); return
        if path == "/generate_material_brief":
            root = Path(data["project"])
            runner = Path(__file__).resolve().parent / "tools" / "material_brief_runner.py"
            log_file = paths(root)["control"] / "logs" / "material-brief-log.md"
            msg = run_background(["python3", str(runner), str(root)], root, log_file)
            self.send("素材简报任务已后台启动", "<p>" + h(msg) + "</p><p>回控制台点顶部“刷新任务状态”，完成后到 00-总控表 查看 给ChatGPT的素材简报.md、素材清单.csv 和 素材预览.html。</p><p><a href='/project?path=" + quote(str(root)) + "'>返回控制台</a></p>"); return
        if path == "/generate_subtitles":
            root = Path(data["project"])
            runner = Path(__file__).resolve().parent / "tools" / "ww_batch_runner.py"
            log_file = paths(root)["control"] / "logs" / "subtitle-log.md"
            msg = run_background(["python3", str(runner), str(root)], root, log_file)
            self.send("字幕任务已后台启动", "<p>" + h(msg) + "</p><p>不用再看 iTerm2，回控制台点“刷新状态”查看任务日志。</p><p><a href='/project?path=" + quote(str(root)) + "'>返回控制台</a></p>"); return
        if path == "/run_roughcut":
            root = Path(data["project"])
            preset = data.get("preset", "landscape")
            runner = Path(__file__).resolve().parent / "tools" / "roughcut_runner.py"
            log_file = paths(root)["control"] / "logs" / "roughcut-log.md"
            msg = run_background(["python3", str(runner), str(root), str(preset)], root, log_file)
            self.send("粗剪任务已后台启动", "<p>" + h(msg) + "</p><p>不用再看 iTerm2，回控制台点“刷新状态”查看任务日志。</p><p><a href='/project?path=" + quote(str(root)) + "'>返回控制台</a></p>"); return
        if path == "/generate_fcpxml":
            root = Path(data["project"])
            runner = Path(__file__).resolve().parent / "tools" / "fcpxml_runner.py"
            log_file = paths(root)["control"] / "logs" / "fcpxml-log.md"
            msg = run_background(["python3", str(runner), str(root)], root, log_file)
            self.send("FCPXML 任务已后台启动", "<p>" + h(msg) + "</p><p>回控制台点顶部“刷新任务状态”，完成后到 07-FCP工程 查看 .fcpxml 文件。</p><p><a href='/project?path=" + quote(str(root)) + "'>返回控制台</a></p>"); return
        if path == "/generate_fcp_subtitle":
            root = Path(data["project"])
            runner = Path(__file__).resolve().parent / "tools" / "fcp_subtitle_runner.py"
            log_file = paths(root)["control"] / "logs" / "fcp-subtitle-log.md"
            msg = run_background(["python3", str(runner), str(root)], root, log_file)
            self.send("FCP 字幕 SRT 任务已后台启动", "<p>" + h(msg) + "</p><p>回控制台点顶部“刷新任务状态”，完成后到 07-FCP工程 查看 .srt 文件。这个字幕文件可以导入 FCP 后继续修改。</p><p><a href='/project?path=" + quote(str(root)) + "'>返回控制台</a></p>"); return
        if path == "/convert_mov":
            root = Path(data["project"])
            runner = Path(__file__).resolve().parent / "tools" / "mov_to_mp4_runner.py"
            log_file = paths(root)["control"] / "logs" / "convert-log.md"
            msg = run_background(["python3", str(runner), str(root)], root, log_file)
            self.send("mov 转 mp4 已后台启动", "<p>" + h(msg) + "</p><p>回控制台点顶部“刷新任务状态”，完成后到 08-最终导出 查看 mp4。</p><p><a href='/project?path=" + quote(str(root)) + "'>返回控制台</a></p>"); return
        if path == "/generate_publish_pack":
            root = Path(data["project"])
            runner = Path(__file__).resolve().parent / "tools" / "publish_pack_runner.py"
            log_file = paths(root)["control"] / "logs" / "publish-log.md"
            msg = run_background(["python3", str(runner), str(root)], root, log_file)
            self.send("发布包任务已后台启动", "<p>" + h(msg) + "</p><p>回控制台点顶部“刷新任务状态”，完成后到 10-发布包 查看 B站/小红书发布目录。</p><p><a href='/project?path=" + quote(str(root)) + "'>返回控制台</a></p>"); return
        if path == "/save_publish":
            root = Path(data["project"]); msg = save_publish(root, data); self.send("发布包", "<p>" + h(msg) + "</p><p><a href='/project?path=" + quote(str(root)) + "'>返回</a></p>"); return
        if path == "/save_review":
            root = Path(data["project"]); msg = save_review(root, data); self.send("复盘", "<p>" + h(msg) + "</p><p><a href='/project?path=" + quote(str(root)) + "'>返回</a></p>"); return
        self.send("404", "Not found")

def main():
    cfg = load_config()
    Path(cfg["base_dir"]).expanduser().mkdir(parents=True, exist_ok=True)
    print("视频剪辑自动化控制台 v2 已启动：http://127.0.0.1:" + str(PORT))
    print("默认项目目录：" + cfg["base_dir"])
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

if __name__ == "__main__":
    main()
