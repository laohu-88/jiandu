---
name: video-cut-planner
description: Analyze a folder of screen recordings, screenshots, images, and project-result media with Codex vision; create a formal 视频剪辑编排器 v3 project; register selected source assets; generate an editable independent-clip FCPXML timeline, restrained marker suggestions, a rough-cut MP4 preview, and an integrity report. Use when the user says “使用视频 Skill，处理这期素材”, “把这个素材文件夹整理成 v3 项目”, “分析这些录屏并生成 FCP 粗剪”, “用视频剪辑编排器处理本期素材”, or otherwise asks to turn one no-voiceover material folder into a v3/FCP rough cut.
---

# Video Cut Planner

Use Codex's current-session image understanding for semantic decisions and the v3 CLI for deterministic media and project work. Do not call an external model API or the Electron-local AI models for this workflow.

## Core paths

- CLI: `/Users/example/Projects/video-cut-planner-v3/bin/video-skill.js`
- Default pending root: `/Users/example/Desktop/视频待处理/`
- Default v3 project root: `/Users/example/Desktop/视频素材库/`
- Protocol: [references/analysis-protocol.md](references/analysis-protocol.md)

If the CLI path is missing, stop and report that the v3 repository is unavailable. Do not recreate the project system inside the Skill.

## Workflow

1. Resolve one explicit issue folder. If only the pending root is given and multiple subfolders exist, list them and ask which issue to process. Never rename, move, delete, overwrite, or edit source files.
2. Run:

   ```bash
   node /Users/example/Projects/video-cut-planner-v3/bin/video-skill.js prepare --source "<一期素材目录>" --json
   ```

3. Read `analysisRequestPath` and `manifestPath`. View every image preview and every available video storyboard with `view_image`. Use individual scene/timed frames when the storyboard is unclear. Do not infer content from filenames alone.
4. For an important or low-confidence video interval, request denser frames:

   ```bash
   node /Users/example/Projects/video-cut-planner-v3/bin/video-skill.js inspect-range --manifest "<manifest.json>" --asset-id "<assetId>" --start <秒> --end <秒> --interval 0.5 --json
   ```

5. Produce one analysis JSON following the protocol reference. Base decisions on this priority:

   1. actual video, screenshot, and image content;
   2. common theme, operation order, and visible before/after results;
   3. clearly available project documents, run results, or Git context;
   4. optional `本期重点.txt`;
   5. individual filenames;
   6. folder name.

6. If the folder name clearly conflicts with the media, set `folderNameConflict` to `true` and include this exact sentence in the user-facing reasoning: `文件夹名称与素材实际内容存在差异，本次主题以素材内容为准。`
7. Design a visual story from the material itself. Favor meaningful result/change, necessary context, key operations, comparison, success evidence, final result, and a brief ending only when supported by the material. Do not force a fixed section count.
8. Avoid obvious dead time, black frames, repeated operations, irrelevant desktop waits, wrong windows, and failures with no narrative value. Sparse frames cannot prove frame-accurate boundaries: lower confidence, use conservative cuts, and set `reviewRequired` when uncertain.
9. Generate 2–6 truthful title candidates and one recommended title. Do not copy the folder name as the title, exaggerate unfinished work, or claim “一键全自动”.
10. Determine the main timeline orientation from the actual adopted media and the dominant video, not the folder name, first image, or preview size. Write `timeline.orientation`, `width`, `height`, and `fps` into the analysis. Use 1920×1080 for horizontal work and 1080×1920 for vertical work unless the material or user explicitly requires another production format. Prefer a reliable standard frame rate from the main video; otherwise use 30 fps. Keep screenshot-heavy shots on `contain` unless intentional cropping is justified.
11. Use zero or a few short markers. Do not create a voiceover script, narration, full subtitles, or title layers.
12. Validate before building:

    ```bash
    node /Users/example/Projects/video-cut-planner-v3/bin/video-skill.js validate-analysis --manifest "<manifest.json>" --analysis "<analysis.json>" --json
    ```

13. Fix every validation error. Then create the formal v3 project:

    ```bash
    node /Users/example/Projects/video-cut-planner-v3/bin/video-skill.js build --manifest "<manifest.json>" --analysis "<analysis.json>" --project-root "/Users/example/Desktop/视频素材库" --project-name "<项目名>" --json
    ```

14. When the user explicitly requests HyperFrames, first run
    `hyperframes-doctor --json`. Only add `--hyperframes` when Node.js, FFmpeg,
    FFprobe, and Chrome are available. HyperFrames remains optional and disabled by
    default. Without a flow input it creates one independent title-card MP4. When
    the requested animation must explain a proven process, pass
    `--hyperframes-flow <流程 JSON>` containing 3–6 short `nodes`, a truthful
    `reason`, and `insertAfterShotId`. For a restrained product-flow demonstration,
    `visuals` may additionally name four already-adopted image asset IDs:
    `drawInterface`, `drawResult`, `comfyInterface`, and `comfyResult`; use only
    screenshots whose visible content supports the stated relationship. The generated
    MP4 is inserted at that exact narrative boundary and only later markers move. In
    either mode, register it as an independent v3 asset and FCPXML clip. Do not treat missing Docker,
    transcription, TTS, or BGM tools as a local-render failure.
15. Do not pass `--open-fcpxml` unless the user explicitly asks to open it. Building already runs full verification. For a later recheck, run `verify --project "<v3 项目目录>" --json`.

## Completion rules

- Require a real v3 project, registered/copied independent assets, valid FCPXML, readable preview MP4, project summary, and passing integrity verification.
- Confirm source file collection, hashes, sizes, and mtimes are unchanged.
- When HyperFrames is enabled, report its pinned version, check result, independent
  MP4 path/hash/metadata, v3 registration, and FCPXML clip count.
- Treat the preview as a review artifact only; FCPXML must reference independent managed source assets.
- Treat timeline and preview formats independently: the formal FCPXML uses the production timeline format from the analysis, while the rough-cut preview defaults to 640×360.
- Report theme, title candidates/recommendation, adopted/rejected assets, video ranges and confidence, shot order, markers, artifact paths, and verification result.
- Distinguish generated/xmllint-validated FCPXML from an actual manual Final Cut Pro import. Never claim FCP import success unless it was performed.

## Failure handling

- For an empty, damaged, or undecodable video, preserve its manifest record and report the CLI degradation warning. Do not invent its contents.
- If ffmpeg/ffprobe is unavailable, report the environment failure; do not install another copy without user approval.
- If source verification fails, stop before building or mark the partial project failed. Never “repair” the source folder.
- If the analysis schema fails, edit only the analysis JSON and revalidate; do not hand-edit v3 internal project files.
