const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createProject } = require('../src/services/project-service');
const {
  buildFinalRoughcutPlan,
  createFinalStatusPayload,
  writeFinalStatus,
  generateFcpHandoff,
} = require('../src/services/stage5-service');

async function makeProject(name = 'Stage5测试') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-stage5-'));
  const { project } = await createProject(root, name);
  await fs.mkdir(path.join(project.projectPath, '04-分段粗剪'), { recursive: true });
  return project;
}

async function writeJson(projectPath, relativePath, value) {
  await fs.writeFile(
    path.join(projectPath, relativePath),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  );
}

const segmentsPayload = {
  segments: [
    {
      id: '01',
      index: 1,
      title: '开头钩子',
      voiceoverText: '先抓住注意力。',
      durationSec: 1.2,
    },
    {
      id: '02',
      index: 2,
      title: '问题出现',
      voiceoverText: '然后指出问题。',
      durationSec: 1.5,
    },
  ],
};

test('缺少某段分段粗剪时不允许生成总粗剪并返回明确错误', async () => {
  const project = await makeProject();
  await writeJson(project.projectPath, '00-项目总控/segments.json', segmentsPayload);
  await fs.writeFile(
    path.join(project.projectPath, '04-分段粗剪', '01-开头钩子.mp4'),
    'fake',
  );
  await writeJson(project.projectPath, '00-项目总控/roughcut-status.json', {
    segments: [{
      segmentId: '01',
      status: 'success',
      outputFile: '04-分段粗剪/01-开头钩子.mp4',
      durationSec: 1.2,
    }],
  });

  await assert.rejects(
    () => buildFinalRoughcutPlan(project.projectPath),
    /第 2 段缺少分段粗剪，无法生成总粗剪/,
  );
});

test('所有分段粗剪存在时可以生成 concat 列表', async () => {
  const project = await makeProject();
  await writeJson(project.projectPath, '00-项目总控/segments.json', segmentsPayload);
  await fs.writeFile(path.join(project.projectPath, '04-分段粗剪', '01-开头钩子.mp4'), 'fake1');
  await fs.writeFile(path.join(project.projectPath, '04-分段粗剪', '02-问题出现.mp4'), 'fake2');
  await writeJson(project.projectPath, '00-项目总控/roughcut-status.json', {
    segments: [
      {
        segmentId: '01',
        status: 'success',
        outputFile: '04-分段粗剪/01-开头钩子.mp4',
        durationSec: 1.2,
      },
      {
        segmentId: '02',
        status: 'success',
        outputFile: '04-分段粗剪/02-问题出现.mp4',
        durationSec: 1.5,
      },
    ],
  });

  const plan = await buildFinalRoughcutPlan(project.projectPath);
  assert.equal(plan.inputs.length, 2);
  assert.match(plan.concatListContent, /01-开头钩子\.mp4/);
  assert.match(plan.concatListContent, /02-问题出现\.mp4/);
  assert.equal(plan.outputFile, path.join('05-总粗剪', 'full-roughcut.mp4'));
});

test('生成成功后写入 final-roughcut-status.json', async () => {
  const project = await makeProject();
  const status = await writeFinalStatus(
    project.projectPath,
    createFinalStatusPayload(project.projectPath, {
      status: 'success',
      outputFile: path.join('05-总粗剪', 'full-roughcut.mp4'),
      durationSec: 2.7,
      segmentCount: 2,
      generatedAt: '2026-06-26T00:00:00.000Z',
      error: null,
    }),
  );

  assert.equal(status.version, 'v3.1.0-stage1');
  assert.equal(status.status, 'success');
  const saved = JSON.parse(
    await fs.readFile(path.join(project.projectPath, '00-项目总控', 'final-roughcut-status.json'), 'utf8'),
  );
  assert.equal(saved.outputFile, path.join('05-总粗剪', 'full-roughcut.mp4'));
  assert.equal(saved.segmentCount, 2);
});

test('FCP交接清单.md 能生成并包含路径、口播、素材和中文模式', async () => {
  const project = await makeProject('交接清单测试');
  await writeJson(project.projectPath, '00-项目总控/segments.json', segmentsPayload);
  await writeJson(project.projectPath, '00-项目总控/segment-assignments.json', {
    segments: [
      {
        segmentId: '01',
        items: [{
          assetId: 'A001',
          filename: 'A001-后台截图.png',
          durationSec: 1.2,
          fitMode: 'push_in',
          audioMode: 'none',
          order: 1,
        }],
      },
      {
        segmentId: '02',
        items: [{
          assetId: 'A002',
          filename: 'A002-操作录屏.mp4',
          durationSec: 1.5,
          fitMode: 'contain',
          audioMode: 'smart_duck',
          order: 1,
        }],
      },
    ],
  });
  await writeJson(project.projectPath, '00-项目总控/roughcut-status.json', {
    segments: [
      {
        segmentId: '01',
        status: 'success',
        outputFile: '04-分段粗剪/01-开头钩子.mp4',
        durationSec: 1.2,
      },
      {
        segmentId: '02',
        status: 'success',
        outputFile: '04-分段粗剪/02-问题出现.mp4',
        durationSec: 1.5,
      },
    ],
  });
  await writeJson(project.projectPath, '00-项目总控/final-roughcut-status.json', {
    status: 'success',
    outputFile: '05-总粗剪/full-roughcut.mp4',
    durationSec: 2.7,
    segmentCount: 2,
  });

  const result = await generateFcpHandoff(project.projectPath);
  assert.equal(result.outputPath, '00-项目总控/FCP交接清单.md');
  const markdown = await fs.readFile(
    path.join(project.projectPath, '00-项目总控', 'FCP交接清单.md'),
    'utf8',
  );
  assert.match(markdown, /04-分段粗剪\/01-开头钩子\.mp4/);
  assert.match(markdown, /先抓住注意力。/);
  assert.match(markdown, /A001-后台截图\.png｜1\.20 秒｜轻微推近｜无原声/);
  assert.match(markdown, /A002-操作录屏\.mp4｜1\.50 秒｜完整显示｜智能压低原声/);
  assert.match(markdown, /05-总粗剪\/full-roughcut\.mp4/);
});
