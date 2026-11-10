# Validation / 验收

Date: 2026-11-10 (Asia/Shanghai), macOS arm64.

Pre-publication isolated checkout:

- `npm ci --no-audit --no-fund`: success, 320 packages installed from lockfile.
- `npm run check`: 111 JavaScript files passed.
- `npm test`: 241 tests, 240 passed, 1 skipped, 0 failures.
- `node bin/jiandu.js help`: success; current CLI commands available.
- `npm run package:mac`: success, arm64 App Bundle generated.
- `npm run verify:package`: passed, arm64, ASAR present, ad-hoc signature valid.
- Skill installation into an isolated directory and `--check`: passed.

The skipped optional integration is not reported as passed. The predecessor sources are archival and have not been independently runtime-certified. No production media, personal footage, credential or app-state files are needed for the test suite. Historical media fixtures are synthetic placeholders.

## Independent public clone

The repository `https://github.com/laohu-88/jiandu` was confirmed Public using GitHub repository metadata. A new clone was made from that GitHub URL into a separate temporary directory, without using the source checkout's object store or node_modules.

- `npm ci --no-audit --no-fund`: passed.
- `npm run check`: 111 files passed.
- `npm test`: 241 tests, 240 passed, 1 skipped, 0 failed.
- CLI help: passed.
- Skill installation and installed-copy digest check in an isolated target: passed.
- 368 tracked files (before this documentation-only follow-up), including source, Skill, bilingual README, MIT license, examples, lockfile and predecessor code, were present.
- Reachable Git objects were inspected for personal home paths, author email addresses and common credential/private-key patterns. No personal home paths or credential-pattern hits remained. Original identities were anonymized; public third-party package-author notices were retained.

The 37 original commits remain represented by the sanitized commit sequence. Source-history SHA values changed due to privacy sanitization. The private original, generated media, app state and working caches were not pushed.

This follow-up changes validation documentation only. Manual Final Cut Pro import, real-user subjective editing quality and optional HyperFrames live rendering are outside this basic validation; they are not claimed as passed.
