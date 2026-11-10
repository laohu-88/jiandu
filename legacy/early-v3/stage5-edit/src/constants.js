const path = require('node:path');

const APP_VERSION = 'v3.0.0-stage5';
const DEFAULT_PROJECT_ROOT = '/Users/example/Desktop/视频素材库';

const PROJECT_DIRS = [
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
const ASSETS_DIR = PROJECT_DIRS[1];
const VOICE_DIR = PROJECT_DIRS[2];
const SEGMENT_PACKAGES_DIR = PROJECT_DIRS[3];
const ROUGHCUT_DIR = PROJECT_DIRS[4];
const FINAL_ROUGHCUT_DIR = PROJECT_DIRS[5];

const PROJECT_FILE = path.join(CONTROL_DIR, 'project.json');
const ASSETS_FILE = path.join(CONTROL_DIR, 'assets.json');
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

module.exports = {
  APP_VERSION,
  DEFAULT_PROJECT_ROOT,
  PROJECT_DIRS,
  CONTROL_DIR,
  ASSETS_DIR,
  VOICE_DIR,
  SEGMENT_PACKAGES_DIR,
  ROUGHCUT_DIR,
  FINAL_ROUGHCUT_DIR,
  PROJECT_FILE,
  ASSETS_FILE,
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
};
