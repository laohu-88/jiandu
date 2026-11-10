# Codex 视频分析协议

## Contents

1. Output contract
2. Field rules
3. Minimal example

## 1. Output contract

Write UTF-8 JSON matching `schemas/codex-video-analysis.schema.json`. The runtime validator also checks cross-file facts: every manifest asset needs one analysis record, asset IDs and types must match the manifest, video ranges/shots cannot exceed probed duration, rejected assets cannot appear in shots, recommended title must be a candidate, shot duration must equal `outSec - inSec`, and markers must sit inside the final timeline.

The JSON is Codex's semantic decision record. Do not add source paths: identify source media only by stable `assetId` from the manifest.

## 2. Field rules

- `theme`: actual theme, evidence, confidence, and folder/content conflict flag.
- `titles`: 2–6 candidates, one exact candidate as `recommended`, and evidence-based rationale.
- `assets[].semanticLabels`: internal semantic labels, not filenames.
- `assets[].contentSummary`: what is visibly present.
- `assets[].suggestedUse`: short possible roles.
- `assets[].status`: `adopt`, `candidate`, or `reject`.
- `assets[].reason`: why it is adopted/candidate/rejected.
- `assets[].ranges`: useful video intervals; use an empty list for still images or no reliable interval.
- `confidence`: number from 0 to 1. Use lower values and `reviewRequired: true` for sparse evidence.
- `timeline.orientation`: `horizontal` or `vertical`, based on the actual adopted media and dominant video rather than the folder name, first image, or preview size.
- `timeline.width`, `height`, `fps`: intended production sequence. Horizontal defaults to 1920×1080, vertical defaults to 1080×1920, and an unreliable or unavailable source frame rate defaults to 30 fps. Use even dimensions. The rough-cut preview is a separate lightweight artifact and does not set these values.
- `shots`: ordered no-voiceover visual timeline. For still images, encode display length as `inSec: 0`, `outSec: <duration>`, `durationSec: <duration>`.
- `fitMode`: `contain` or `cover`.
- `audioMode`: `keep` or `mute`; keep useful original audio when appropriate.
- `markers`: zero or a few brief explanatory suggestions, not full subtitles. Existing
  `{timeSec, text}` markers remain valid. When the user explicitly requests editable
  light subtitles for a release project, a marker may additionally provide `id`, `type`,
  and `subtitle` with `enabled`, one-line `text`, positive `durationSec`, `position`
  (`bottom-safe`, `top-safe`, or `center`), `purpose`, and `renderAsFcpTitle`.

## 3. Minimal example

```json
{
  "schemaVersion": 1,
  "theme": {
    "summary": "从界面调整到测试通过的开发过程",
    "rationale": "录屏展示了设置修改和测试成功，截图展示最终页面。",
    "confidence": 0.9,
    "folderNameConflict": true
  },
  "titles": {
    "candidates": ["把设置页真正跑通", "从界面修改到测试通过"],
    "recommended": "从界面修改到测试通过",
    "rationale": "对应录屏中的修改过程和截图中的最终结果。"
  },
  "assets": [
    {
      "assetId": "media_example_video",
      "type": "video",
      "semanticLabels": ["设置页", "测试通过"],
      "contentSummary": "录屏展示设置修改并运行测试。",
      "suggestedUse": ["关键操作过程", "成功证据"],
      "status": "adopt",
      "reason": "同时包含过程和可见结果。",
      "ranges": [
        { "startSec": 1.2, "endSec": 8.4, "confidence": 0.82, "reviewRequired": false }
      ],
      "confidence": 0.86
    },
    {
      "assetId": "media_example_image",
      "type": "image",
      "semanticLabels": ["最终页面"],
      "contentSummary": "截图显示调整完成后的页面。",
      "suggestedUse": ["结果展示"],
      "status": "adopt",
      "reason": "适合收尾确认最终状态。",
      "ranges": [],
      "confidence": 0.95
    }
  ],
  "timeline": {
    "orientation": "horizontal",
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "shots": [
      {
        "id": "shot-001",
        "assetId": "media_example_video",
        "inSec": 1.2,
        "outSec": 6.2,
        "durationSec": 5,
        "fitMode": "contain",
        "audioMode": "keep",
        "purpose": "展示关键设置修改",
        "confidence": 0.82,
        "reviewRequired": false
      },
      {
        "id": "shot-002",
        "assetId": "media_example_image",
        "inSec": 0,
        "outSec": 2.5,
        "durationSec": 2.5,
        "fitMode": "contain",
        "audioMode": "mute",
        "purpose": "停留确认最终页面",
        "confidence": 0.95,
        "reviewRequired": false
      }
    ],
    "markers": [
      { "timeSec": 0.5, "text": "调整设置" },
      { "timeSec": 5.5, "text": "测试通过" }
    ]
  }
}
```
