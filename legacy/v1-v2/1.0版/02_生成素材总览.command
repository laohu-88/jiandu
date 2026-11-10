#!/bin/zsh

python3 - <<'PY'
from pathlib import Path
import subprocess
import shutil
import html

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
source = project / "01_精选素材"
out_dir = project / "99_过程文件" / "素材总览"
thumb_dir = out_dir / "网页缩略图"
temp_dir = out_dir / "临时缩略图"

if not source.exists():
    print("没找到 01_精选素材：", source)
    print("请确认你选择的是视频项目总文件夹。")
    raise SystemExit

out_dir.mkdir(parents=True, exist_ok=True)
thumb_dir.mkdir(parents=True, exist_ok=True)
temp_dir.mkdir(parents=True, exist_ok=True)

# 清理旧缩略图
for d in [thumb_dir, temp_dir]:
    for x in d.iterdir():
        if x.is_file():
            x.unlink()

files = [p for p in source.iterdir() if p.is_file() and p.name != ".DS_Store"]
files.sort(key=lambda p: p.name)

if not files:
    print("01_精选素材 里没有文件。")
    print("请先把可能用进视频的素材复制到 01_精选素材。")
    raise SystemExit

def file_kind(p):
    ext = p.suffix.lower()
    if ext in [".png", ".jpg", ".jpeg", ".heic", ".webp"]:
        return "图片/截图"
    if ext in [".mov", ".mp4", ".m4v"]:
        return "视频/录屏"
    if ext in [".mp3", ".wav", ".m4a", ".aac"]:
        return "音频"
    return "其他"

# QuickLook 生成缩略图
for i, p in enumerate(files, 1):
    for x in temp_dir.iterdir():
        if x.is_file():
            x.unlink()

    subprocess.run(
        ["qlmanage", "-t", "-s", "600", "-o", str(temp_dir), str(p)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )

    pngs = list(temp_dir.glob("*.png"))
    if pngs:
        shutil.copy(pngs[0], thumb_dir / f"{i:02d}.png")

# 编号清单
list_path = out_dir / "素材编号清单.txt"
with list_path.open("w", encoding="utf-8") as f:
    for i, p in enumerate(files, 1):
        f.write(f"{i:02d}. {p.name}｜{file_kind(p)}｜{p.stat().st_size/1024/1024:.1f}MB\n")

# 生成 HTML
html_path = out_dir / "素材总览.html"

cards = []
for i, p in enumerate(files, 1):
    thumb = thumb_dir / f"{i:02d}.png"
    name = html.escape(p.name)
    kind = html.escape(file_kind(p))
    size = f"{p.stat().st_size/1024/1024:.1f}MB"

    if thumb.exists():
        img_src = thumb.resolve().as_uri()
        preview = f'<img src="{img_src}" />'
    else:
        preview = '<div class="no-thumb">无缩略图</div>'

    cards.append(f'''
    <div class="card">
      <div class="num">{i:02d}</div>
      <div class="thumb">{preview}</div>
      <div class="name">{name}</div>
      <div class="meta">{kind}｜{size}</div>
    </div>
    ''')

html_text = f'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>{html.escape(project.name)}｜素材总览</title>
<style>
body {{
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
  margin: 32px;
  background: #f5f5f5;
  color: #111;
}}
h1 {{
  font-size: 28px;
  margin-bottom: 8px;
}}
p {{
  color: #555;
  margin-bottom: 24px;
}}
.grid {{
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 18px;
}}
.card {{
  background: white;
  border-radius: 14px;
  padding: 12px;
  box-shadow: 0 1px 8px rgba(0,0,0,0.08);
  position: relative;
  min-height: 260px;
}}
.num {{
  position: absolute;
  left: 12px;
  top: 12px;
  background: black;
  color: white;
  font-weight: 700;
  padding: 4px 8px;
  border-radius: 8px;
  z-index: 2;
}}
.thumb {{
  height: 175px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #eee;
  border-radius: 10px;
  overflow: hidden;
  margin-bottom: 10px;
}}
.thumb img {{
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}}
.no-thumb {{
  color: #999;
}}
.name {{
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
  word-break: break-all;
}}
.meta {{
  font-size: 12px;
  color: #666;
  margin-top: 6px;
}}
</style>
</head>
<body>
<h1>{html.escape(project.name)}｜素材总览</h1>
<p>共 {len(files)} 个素材。请把这个网页分屏截图发给 ChatGPT，用编号讨论素材。</p>
<div class="grid">
{''.join(cards)}
</div>
</body>
</html>
'''

html_path.write_text(html_text, encoding="utf-8")

print("完成。")
print(f"项目：{project}")
print(f"共生成素材总览：{len(files)} 个素材")
print("输出位置：", out_dir)
subprocess.run(["open", str(html_path)])
PY

echo "可以关闭这个窗口。"
