const os = require('node:os');
const path = require('node:path');
const { version: PACKAGE_VERSION } = require('../package.json');

const APP_NAME = '剪渡';
const APP_VERSION = `v${PACKAGE_VERSION}`;
const APP_ID = 'com.laohu.video-cut-planner-v3';
const USER_DATA_DIRNAME = APP_NAME;
const LEGACY_USER_DATA_DIRNAME = '视频剪辑编排器 v3';
// 工作区根目录跟随仓库实际位置，目录改名后不再失效。
const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_PROJECT_ROOT = path.join(os.homedir(), 'Desktop', '视频素材库');
const DEFAULT_PENDING_ROOT = path.join(os.homedir(), 'Desktop', '视频待处理');
const APPLICATION_SUPPORT_ROOT = path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
const INTERNAL_PROJECTS_DIR = 'projects';

function internalProjectRoot(projectPath) {
  return path.join(APPLICATION_SUPPORT_ROOT, INTERNAL_PROJECTS_DIR, path.basename(path.resolve(projectPath)));
}

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
// Agent-neutral 数据文件名（v3.2 起写入新名，读取兼容旧 Codex 前缀名）。
const VIDEO_MANIFEST_FILE = path.join(CONTROL_DIR, '视频素材清单.json');
const VIDEO_ANALYSIS_FILE = path.join(CONTROL_DIR, '视频分析.json');
const VIDEO_STATUS_FILE = path.join(CONTROL_DIR, '视频状态.json');
const VIDEO_SUMMARY_FILE = path.join(CONTROL_DIR, '视频项目摘要.md');
const VIDEO_HYPERFRAMES_DIR = path.join(CONTROL_DIR, 'HyperFrames');
// 一次性兼容：旧版本写入的 Codex 前缀文件名。
const LEGACY_VIDEO_MANIFEST_FILENAME = 'Codex视频素材清单.json';
const LEGACY_VIDEO_ANALYSIS_FILENAME = 'Codex视频分析.json';
const LEGACY_VIDEO_STATUS_FILENAME = 'Codex视频状态.json';
const LEGACY_VIDEO_SUMMARY_FILENAME = 'Codex视频项目摘要.md';
const EDITORIAL_REVIEW_FILE = path.join(CONTROL_DIR, 'editorial-review.json');
const PLATFORM_VARIANTS_FILE = path.join(CONTROL_DIR, 'platform-variants.json');
const PLATFORM_VARIANTS_DIR = path.join(EXPORT_DIR, '平台变体');
const DOUYIN_PLATFORM_PROFILE_FILE = path.join('config', 'platforms', 'douyin.json');
// New projects keep only user-facing deliverables in the project root. These
// names remain as relative legacy paths so old projects can still be read.
const VIDEO_FCPXML_DIR = '.';
const VIDEO_PREVIEW_DIR = '.';
// New projects keep machine state outside the visible project directory. The
// legacy relative constants above remain readable by old-project adapters.
const INTERNAL_PROJECT_FILE = 'project.json';
const INTERNAL_ASSETS_FILE = 'assets.json';
const INTERNAL_VIDEO_MANIFEST_FILE = '视频素材清单.json';
const INTERNAL_VIDEO_ANALYSIS_FILE = '视频分析.json';
const INTERNAL_VIDEO_STATUS_FILE = '视频状态.json';
const INTERNAL_VIDEO_SUMMARY_FILE = '视频项目摘要.md';
// 内部目录旧文件名的兼容读取入口。
const LEGACY_INTERNAL_VIDEO_MANIFEST_FILE = 'Codex视频素材清单.json';
const LEGACY_INTERNAL_VIDEO_ANALYSIS_FILE = 'Codex视频分析.json';
const LEGACY_INTERNAL_VIDEO_STATUS_FILE = 'Codex视频状态.json';
const LEGACY_INTERNAL_VIDEO_SUMMARY_FILE = 'Codex视频项目摘要.md';
const INTERNAL_EDITORIAL_REVIEW_FILE = 'editorial-review.json';
const INTERNAL_PLATFORM_VARIANTS_FILE = 'platform-variants.json';
const INTERNAL_ARTIFACT_DIRS = Object.freeze({
  cache: 'cache',
  logs: 'logs',
  revisions: 'revisions',
  previews: 'cache/previews',
  variants: 'variants',
});
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
  APP_VERSION,
  APP_ID,
  PACKAGE_VERSION,
  USER_DATA_DIRNAME,
  LEGACY_USER_DATA_DIRNAME,
  WORKSPACE_ROOT,
  DEFAULT_PROJECT_ROOT,
  DEFAULT_PENDING_ROOT,
  APPLICATION_SUPPORT_ROOT,
  INTERNAL_PROJECTS_DIR,
  internalProjectRoot,
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
  VIDEO_MANIFEST_FILE,
  LEGACY_VIDEO_MANIFEST_FILENAME,
  VIDEO_ANALYSIS_FILE,
  LEGACY_VIDEO_ANALYSIS_FILENAME,
  VIDEO_STATUS_FILE,
  LEGACY_VIDEO_STATUS_FILENAME,
  VIDEO_SUMMARY_FILE,
  LEGACY_VIDEO_SUMMARY_FILENAME,
  VIDEO_HYPERFRAMES_DIR,
  EDITORIAL_REVIEW_FILE,
  PLATFORM_VARIANTS_FILE,
  PLATFORM_VARIANTS_DIR,
  DOUYIN_PLATFORM_PROFILE_FILE,
  VIDEO_FCPXML_DIR,
  VIDEO_PREVIEW_DIR,
  INTERNAL_PROJECT_FILE,
  INTERNAL_ASSETS_FILE,
  INTERNAL_VIDEO_MANIFEST_FILE,
  LEGACY_INTERNAL_VIDEO_MANIFEST_FILE,
  INTERNAL_VIDEO_ANALYSIS_FILE,
  LEGACY_INTERNAL_VIDEO_ANALYSIS_FILE,
  INTERNAL_VIDEO_STATUS_FILE,
  LEGACY_INTERNAL_VIDEO_STATUS_FILE,
  INTERNAL_VIDEO_SUMMARY_FILE,
  LEGACY_INTERNAL_VIDEO_SUMMARY_FILE,
  INTERNAL_EDITORIAL_REVIEW_FILE,
  INTERNAL_PLATFORM_VARIANTS_FILE,
  INTERNAL_ARTIFACT_DIRS,
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
