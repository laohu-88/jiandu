const path = require('node:path');
const { removeUnusedMacPermissionDescriptions } = require('./scripts/after-pack');

module.exports = {
  appId: 'com.laohu.video-cut-planner-v3',
  productName: '剪渡',
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
    'config/**/*.json',
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
      CFBundleDisplayName: '剪渡',
      // 注意：不得覆写 CFBundleName。Electron 按 <CFBundleName> Helper.app
      // 在 Contents/Frameworks 查找 Helper，必须与 productName 保持一致，
      // 否则打包后的 App 会在 LaunchServices 启动时立即 SIGTRAP 崩溃。
    },
    protocols: [{
      name: '剪渡交接回流',
      schemes: ['video-cut-planner'],
    }],
  },
};
