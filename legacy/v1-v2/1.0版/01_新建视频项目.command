#!/bin/zsh

MATERIAL_ROOT="$HOME/Desktop/视频素材库"

mkdir -p "$MATERIAL_ROOT"

PROJECT_NAME=$(osascript <<'APPLESCRIPT'
text returned of (display dialog "请输入视频项目名，例如：002_新项目开始" default answer "" buttons {"取消", "创建"} default button "创建")
APPLESCRIPT
)

if [ -z "$PROJECT_NAME" ]; then
  echo "项目名为空，已取消。"
  exit 1
fi

BASE="$MATERIAL_ROOT/$PROJECT_NAME"

mkdir -p "$BASE/00_原始素材"
mkdir -p "$BASE/01_精选素材"
mkdir -p "$BASE/02_分段素材包"
mkdir -p "$BASE/03_配音"
mkdir -p "$BASE/04_自动粗剪MP4"
mkdir -p "$BASE/05_FCP工程"
mkdir -p "$BASE/06_字幕"
mkdir -p "$BASE/07_导出成片"
mkdir -p "$BASE/99_过程文件"

cat > "$BASE/00_项目说明.txt" <<EOF
项目：$PROJECT_NAME

项目位置：
$BASE

日常只需要管：
1. 00_原始素材：所有截图、录屏、照片先放这里
2. 01_精选素材：真正可能用进视频的复制到这里
3. 07_导出成片：最终视频放这里

其他文件夹由脚本和流程使用：
02_分段素材包：自动分段素材
03_配音：剪映导出的分段配音
04_自动粗剪MP4：脚本生成的粗剪视频
05_FCP工程：FCP工程文件
06_字幕：ww生成的字幕
99_过程文件：总览图、清单、临时文件
EOF

open "$BASE"

echo "已创建视频项目：$BASE"
echo "可以关闭这个窗口。"
