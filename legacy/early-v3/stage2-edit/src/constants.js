const path = require('node:path');

const APP_VERSION = 'v3.0.0-stage2';
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

const PROJECT_FILE = path.join(CONTROL_DIR, 'project.json');
const ASSETS_FILE = path.join(CONTROL_DIR, 'assets.json');
const BRIEF_FILE = path.join(CONTROL_DIR, '素材简报.md');
const VIDEO_PLAN_FILE = path.join(CONTROL_DIR, 'video-plan.md');
const SEGMENTS_FILE = path.join(CONTROL_DIR, 'segments.json');

module.exports = {
  APP_VERSION,
  DEFAULT_PROJECT_ROOT,
  PROJECT_DIRS,
  CONTROL_DIR,
  ASSETS_DIR,
  VOICE_DIR,
  PROJECT_FILE,
  ASSETS_FILE,
  BRIEF_FILE,
  VIDEO_PLAN_FILE,
  SEGMENTS_FILE,
};
