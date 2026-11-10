# Project structure and dependencies

- `src/`: Electron main/preload/UI, services, view models.
- `bin/jiandu.js`: current CLI entry point.
- `skills/jiandu/`: Skill, agent metadata and analysis protocol.
- `schemas/`: structured analysis and vertical-platform contracts.
- `config/platforms/`: platform defaults.
- `scripts/`: syntax checking, packaging, Skill and App installation.
- `test/`: unit/integration tests and synthetic fixtures.
- `assets/`, `build/`: original application artwork and packaging inputs.
- `examples/`, `docs/`: portable examples, setup, validation and privacy notes.

## Versions

Validated toolchain preparation: Node.js 22.23.1, npm 10.9.8, FFmpeg/FFprobe 8.1.1 on macOS arm64. Exact npm transitive versions and integrity hashes are in `package-lock.json`.

- electron: `37.10.3` (locked).
- electron-builder: `26.15.3` (locked).

Optional HyperFrames integration was developed against `hyperframes@0.7.63`. It is not a base dependency. The existing audit in `hyperframes-audit.md` records a transitive dependency advisory and limits; optional rendering needs Chrome. Base setup does not install HyperFrames or require external model credentials. Final Cut Pro and Codex are separately installed applications.

Dependency code is not relicensed by this repository's MIT license. Preserve upstream license notices when redistributing bundles. `npm ci` downloads dependencies; source-only distribution does not bundle them.
