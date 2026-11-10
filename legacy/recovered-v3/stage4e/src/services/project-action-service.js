const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const FINAL_CUT_BUNDLE_ID = 'com.apple.FinalCutApp';
const FINAL_CUT_APP_PATH = '/Applications/Final Cut Pro Creator Studio.app';

async function openInFinalCut(fcpxmlPath, options = {}) {
  const run = options.execFileImpl || promisify(execFile);
  try {
    await run('/usr/bin/open', ['-b', FINAL_CUT_BUNDLE_ID, fcpxmlPath], {
      timeout: 30_000,
    });
    return { opened: true, strategy: 'bundle-id', fcpxmlPath };
  } catch (bundleError) {
    try {
      await run('/usr/bin/open', ['-a', FINAL_CUT_APP_PATH, fcpxmlPath], {
        timeout: 30_000,
      });
      return { opened: true, strategy: 'application-path', fcpxmlPath };
    } catch (pathError) {
      throw Object.assign(new Error(`Final Cut Pro 打开失败：${pathError.message}`), {
        code: 'FINAL_CUT_OPEN_FAILED',
        bundleError,
        cause: pathError,
      });
    }
  }
}

module.exports = { FINAL_CUT_APP_PATH, FINAL_CUT_BUNDLE_ID, openInFinalCut };
