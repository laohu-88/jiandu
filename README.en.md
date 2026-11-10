# Jiandu (剪渡)

[中文](README.md) · [Installation](docs/INSTALL.md) · [Validation](docs/ACCEPTANCE.md)

Jiandu is a local macOS video-analysis and editable Final Cut Pro FCPXML toolkit. It includes an Electron interface, a deterministic CLI, and a Codex Skill. An agent reviews actual media and plans edits; the CLI probes media, validates structured analysis, builds projects, and verifies references. The source includes the September 18, 2026 implementation; the existing package version is `3.1.0-stage1`.

## Quick start

Requirements: macOS, Node.js 22+, npm, FFmpeg and FFprobe. Final Cut Pro is needed for manual timeline import, and a configured Codex installation for the agent workflow. No private footage, credentials, or commercial applications are bundled.

```bash
git clone https://github.com/laohu-88/jiandu.git
cd jiandu
npm ci
npm run check
npm test
node bin/jiandu.js help
npm start
```

Put FFmpeg/FFprobe on PATH, `/opt/homebrew/bin`, or `/usr/local/bin`. You can install FFmpeg using your existing package manager. Dependency versions are locked by `package-lock.json`; see `docs/PROJECT.md`.

## Skill and CLI

```bash
export JIANDU_HOME="$PWD"
node scripts/install-video-skill.js
node scripts/install-video-skill.js --check
node bin/jiandu.js prepare --source "/absolute/path/to/media" --json
```

Open a new Codex chat, invoke `$jiandu`, and provide the media folder and the absolute `JIANDU_HOME` path. The agent must review real images/video frames before writing analysis according to `schemas/codex-video-analysis.schema.json` and the Skill protocol.

```bash
node bin/jiandu.js validate-analysis --manifest "/path/to/manifest.json" --analysis "/path/to/analysis.json" --json
node bin/jiandu.js build --manifest "/path/to/manifest.json" --analysis "/path/to/analysis.json" --project-root "/path/to/projects" --project-name "Demo" --json
node bin/jiandu.js verify --project "/path/to/projects/Demo" --json
```

Defaults are `~/Desktop/视频待处理` for inputs and `~/Desktop/视频素材库` for projects. Internal state, caches, revisions and task records live in `~/Library/Application Support/剪渡`. Sources remain in place. FCPXML can reference source footage and derived media in the internal state directory; preserve those files with the timeline. MP4 previews are optional, not the default deliverable.

## Desktop packaging

Run `npm run package:mac` and `npm run verify:package`. The output is an Apple Silicon, ad-hoc signed local App at `dist/mac-arm64/剪渡.app`, not a notarized public binary. Run `npm run install:mac:local` only when you want to install it. HyperFrames is optional and is not needed for basic use.

## Validation and licensing

`npm run check` checks JavaScript; `npm test` covers the CLI, media, FCPXML, captions, handoffs and path safety. Actual results and untested boundaries are recorded in `docs/ACCEPTANCE.md`. Automated checks do not establish manual Final Cut Pro import or subjective audiovisual quality.

Original source is MIT licensed. Dependencies and input media retain their respective licenses. Published Git history has personal paths and commit identities sanitized, so commit hashes differ from the private originals. See `docs/PRIVACY.md`. Historical predecessor code, when included under `legacy/`, is archival and is not a runtime dependency.
