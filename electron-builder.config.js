const path = require('node:path');
const { removeUnusedMacPermissionDescriptions } = require('./scripts/after-pack');

module.exports = {
  appId: 'com.laohu.video-cut-planner-v3',
  productName: '视频剪辑编排器 v3',
  electronDist: path.join(__dirname, 'node_modules', 'electron', 'dist'),
  asar: true,
  directories: {
    output: 'dist',
  },
  files: [
    'package.json',
    'src/**/*.js',
    'src/renderer/**/*.html',
    'src/renderer/**/*.css',
    'schemas/*.json',
    '!**/*.test.js',
    '!test{,/**}',
    '!coverage{,/**}',
    '!dist{,/**}',
  ],
  afterPack: removeUnusedMacPermissionDescriptions,
  mac: {
    target: [{
      target: 'dir',
      arch: ['arm64'],
    }],
    category: 'public.app-category.video',
    icon: 'build/app-icon.icns',
    identity: '-',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      CFBundleDisplayName: '视频剪辑编排器 v3',
      CFBundleName: '视频剪辑编排器 v3',
    },
    protocols: [{
      name: '视频剪辑编排器 v3 交接回流',
      schemes: ['video-cut-planner'],
    }],
  },
};
