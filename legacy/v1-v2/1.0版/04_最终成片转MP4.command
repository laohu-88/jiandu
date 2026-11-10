#!/bin/zsh

python3 - <<'PY'
from pathlib import Path
import subprocess
import shutil

if not shutil.which("ffmpeg"):
    print("没找到 ffmpeg。")
    print("请先运行：brew install ffmpeg")
    raise SystemExit

# 直接选择 MOV 文件，不再要求项目文件夹命名
script_file = '''
tell application "Finder"
    set f to choose file with prompt "请选择要转成 MP4 的最终 MOV 文件"
    POSIX path of f
end tell
'''
result = subprocess.run(["osascript", "-e", script_file], capture_output=True, text=True)

if result.returncode != 0:
    print("已取消选择文件。")
    raise SystemExit

src = Path(result.stdout.strip())

if not src.exists():
    print("文件不存在：", src)
    raise SystemExit

if src.suffix.lower() not in [".mov", ".mp4", ".m4v"]:
    print("请选择视频文件，当前文件不是 mov/mp4/m4v：", src)
    raise SystemExit

# 输出到同一个文件夹
out = src.with_name(src.stem + "_发布版.mp4")

cmd = [
    "ffmpeg", "-y",
    "-i", str(src),
    "-c:v", "libx264",
    "-crf", "18",
    "-preset", "medium",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    str(out)
]

print("开始转换 MP4，请稍等...")
print("源文件：", src)
print("输出文件：", out)

r = subprocess.run(cmd)

if r.returncode != 0:
    print("转换失败。")
    raise SystemExit

print("完成：", out)
subprocess.run(["open", str(out.parent)])
PY

echo "可以关闭这个窗口。"
