const path = require('node:path');
const { version: PACKAGE_VERSION } = require('../package.json');

const APP_NAME = '视频剪辑编排器 v3';
const INTERNAL_APP_NAME = 'Video Cut Planner V3';
const APP_VERSION = `v${PACKAGE_VERSION}`;
const APP_ID = 'com.laohu.video-cut-planner-v3';
const USER_DATA_DIRNAME = APP_NAME;
const CODEX_WORKSPACE_ROOT = '/Users/example/Projects/video-cut-planner-v3';
const DEFAULT_PROJECT_ROOT = '/Users/example/Desktop/视频素材库';

const PROJECT_DIRS = [
  '00-项目总控',
  '01-精选素材',
  '02-配音字幕',
  '03-导出',
];

const LEGACY_PROJECT_DIRS = [
  '00-项目总控',
  '01-精选素材',
  '02-配音',
  '03-分段素材包',
  '04-分段粗剪',
  '05-总粗剪',
  '06-FCP导出',
  '07-字幕',
];

const CONTROL_DIR = PROJECT_DIRS[0];
const BACKUPS_DIR = path.join(CONTROL_DIR, 'backups');
const ASSETS_DIR = PROJECT_DIRS[1];
const VOICE_SUBTITLE_DIR = PROJECT_DIRS[2];
const EXPORT_DIR = PROJECT_DIRS[3];
const VOICE_DIR = LEGACY_PROJECT_DIRS[2];
const SEGMENT_PACKAGES_DIR = LEGACY_PROJECT_DIRS[3];
const ROUGHCUT_DIR = LEGACY_PROJECT_DIRS[4];
const FINAL_ROUGHCUT_DIR = LEGACY_PROJECT_DIRS[5];
const FCP_EXPORT_DIR = LEGACY_PROJECT_DIRS[6];
const SUBTITLE_DIR = LEGACY_PROJECT_DIRS[7];

const PROJECT_FILE = path.join(CONTROL_DIR, 'project.json');
const ASSETS_FILE = path.join(CONTROL_DIR, 'assets.json');
const AI_ANALYSIS_FILE = path.join(CONTROL_DIR, 'ai-analysis.json');
const AI_MATERIAL_REPORT_FILE = path.join(CONTROL_DIR, 'ai素材报告.md');
const AI_EDIT_SUGGESTION_FILE = path.join(CONTROL_DIR, '剪辑建议.md');
const CODEX_VIDEO_MANIFEST_FILE = path.join(CONTROL_DIR, 'Codex视频素材清单.json');
const CODEX_VIDEO_ANALYSIS_FILE = path.join(CONTROL_DIR, 'Codex视频分析.json');
const CODEX_VIDEO_STATUS_FILE = path.join(CONTROL_DIR, 'Codex视频状态.json');
const CODEX_VIDEO_SUMMARY_FILE = path.join(CONTROL_DIR, 'Codex视频项目摘要.md');
const CODEX_VIDEO_HYPERFRAMES_DIR = path.join(CONTROL_DIR, 'HyperFrames');
const CODEX_VIDEO_FCPXML_DIR = path.join(EXPORT_DIR, 'FCPXML');
const CODEX_VIDEO_PREVIEW_DIR = path.join(EXPORT_DIR, '粗剪预览');
const BRIEF_FILE = path.join(CONTROL_DIR, '素材简报.md');
const VIDEO_PLAN_FILE = path.join(CONTROL_DIR, 'video-plan.md');
const SEGMENTS_FILE = path.join(CONTROL_DIR, 'segments.json');
const ASSIGNMENTS_FILE = path.join(CONTROL_DIR, 'segment-assignments.json');
const ROUGHCUT_STATUS_FILE = path.join(CONTROL_DIR, 'roughcut-status.json');
const ROUGHCUT_ERROR_FILE = path.join(CONTROL_DIR, 'roughcut-errors.log');
const ROUGHCUT_TMP_DIR = path.join(CONTROL_DIR, '.tmp-roughcut');
const FINAL_ROUGHCUT_STATUS_FILE = path.join(CONTROL_DIR, 'final-roughcut-status.json');
const FINAL_ROUGHCUT_ERROR_FILE = path.join(CONTROL_DIR, 'final-roughcut-errors.log');
const FINAL_ROUGHCUT_TMP_DIR = path.join(CONTROL_DIR, '.tmp-final-roughcut');
const FCP_HANDOFF_FILE = path.join(CONTROL_DIR, 'FCP交接清单.md');
const FINAL_ROUGHCUT_FILE = path.join(FINAL_ROUGHCUT_DIR, 'full-roughcut.mp4');
const SUBTITLE_CONFIG_FILE = path.join(CONTROL_DIR, 'subtitle-config.json');
const SUBTITLE_STATUS_FILE = path.join(CONTROL_DIR, 'subtitle-status.json');
const SUBTITLE_ERROR_FILE = path.join(CONTROL_DIR, 'subtitle-errors.log');
const RAW_SRT_FILE = path.join(SUBTITLE_DIR, 'raw.srt');
const RAW_TXT_FILE = path.join(SUBTITLE_DIR, 'raw.txt');
const FINAL_CN_SRT_FILE = path.join(SUBTITLE_DIR, 'final-cn.srt');
const FINAL_CN_TXT_FILE = path.join(SUBTITLE_DIR, 'final-cn.txt');
const SUBTITLE_REPORT_FILE = path.join(SUBTITLE_DIR, 'subtitle-report.md');

module.exports = {
  APP_NAME,
  INTERNAL_APP_NAME,
  APP_VERSION,
  APP_ID,
  PACKAGE_VERSION,
  USER_DATA_DIRNAME,
  CODEX_WORKSPACE_ROOT,
  DEFAULT_PROJECT_ROOT,
  PROJECT_DIRS,
  LEGACY_PROJECT_DIRS,
  CONTROL_DIR,
  BACKUPS_DIR,
  ASSETS_DIR,
  VOICE_SUBTITLE_DIR,
  EXPORT_DIR,
  VOICE_DIR,
  SEGMENT_PACKAGES_DIR,
  ROUGHCUT_DIR,
  FINAL_ROUGHCUT_DIR,
  FCP_EXPORT_DIR,
  SUBTITLE_DIR,
  PROJECT_FILE,
  ASSETS_FILE,
  AI_ANALYSIS_FILE,
  AI_MATERIAL_REPORT_FILE,
  AI_EDIT_SUGGESTION_FILE,
  CODEX_VIDEO_MANIFEST_FILE,
  CODEX_VIDEO_ANALYSIS_FILE,
  CODEX_VIDEO_STATUS_FILE,
  CODEX_VIDEO_SUMMARY_FILE,
  CODEX_VIDEO_HYPERFRAMES_DIR,
  CODEX_VIDEO_FCPXML_DIR,
  CODEX_VIDEO_PREVIEW_DIR,
  BRIEF_FILE,
  VIDEO_PLAN_FILE,
  SEGMENTS_FILE,
  ASSIGNMENTS_FILE,
  ROUGHCUT_STATUS_FILE,
  ROUGHCUT_ERROR_FILE,
  ROUGHCUT_TMP_DIR,
  FINAL_ROUGHCUT_STATUS_FILE,
  FINAL_ROUGHCUT_ERROR_FILE,
  FINAL_ROUGHCUT_TMP_DIR,
  FCP_HANDOFF_FILE,
  FINAL_ROUGHCUT_FILE,
  SUBTITLE_CONFIG_FILE,
  SUBTITLE_STATUS_FILE,
  SUBTITLE_ERROR_FILE,
  RAW_SRT_FILE,
  RAW_TXT_FILE,
  FINAL_CN_SRT_FILE,
  FINAL_CN_TXT_FILE,
  SUBTITLE_REPORT_FILE,
};
