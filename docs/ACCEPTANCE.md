# Validation / 验收

Date: 2026-11-10 (Asia/Shanghai), macOS arm64.

Pre-publication isolated checkout:

- `npm ci --no-audit --no-fund`: success, 320 packages installed from lockfile.
- `npm run check`: 111 JavaScript files passed.
- `npm test`: 241 tests, 240 passed, 1 skipped, 0 failures.
- `node bin/jiandu.js help`: success; current CLI commands available.
- `npm run package:mac`: success, arm64 App Bundle generated.
- Skill installation and package verification are recorded during release validation.

The skipped optional integration is not reported as passed. The predecessor sources are archival and have not been independently runtime-certified. No production media, personal footage, credential or app-state files are needed for the test suite. Historical media fixtures are synthetic placeholders.

A fresh public GitHub clone will be installed and verified after the initial push, and its results recorded in a follow-up commit. Manual Final Cut Pro import, real-user subjective editing quality and optional HyperFrames live rendering are outside this basic validation; they are not claimed as passed.
