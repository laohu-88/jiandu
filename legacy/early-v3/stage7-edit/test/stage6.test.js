const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createProject } = require('../src/services/project-service');
const {
  parseSrt,
  processSrtContent,
  renderSrt,
  displayLength,
  organizeSrtFile,
} = require('../src/services/stage6-service');

async function makeProject(name = '字幕测试') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-stage6-'));
  const { project } = await createProject(root, name);
  return project;
}

const longRawSrt = `1
00:00:01,000 --> 00:00:08,000
买MacBook后,折腾了这么久,我的第一个打工猫猫盲盒机,终于能抽了!这不是一个概念图,也不是只停在想法里.现在它真的能用了.

2
00:00:08,000 --> 00:00:10,000
ChatGPT和FCP都准备好了,我们开始吧!
`;

test('英文标点转中文标点，但不修改 SRT 时间码', () => {
  const processed = processSrtContent(`1
00:00:01,000 --> 00:00:03,000
你好,世界.真的吗?Yes!
`);
  const rendered = renderSrt(processed.finalEntries);
  assert.match(rendered, /00:00:01,000 --> 00:00:03,000/);
  assert.doesNotMatch(rendered, /00：00：01，000/);
  assert.match(rendered, /你好，世界。真的吗？Yes！/);
});

test('超长字幕能拆成多条短字幕，且每条最多 2 行', () => {
  const processed = processSrtContent(longRawSrt);
  assert.ok(processed.metrics.finalCount > processed.metrics.rawCount);
  assert.ok(processed.metrics.splitCount >= 1);
  for (const entry of processed.finalEntries) {
    assert.ok(entry.lines.length <= 2);
    assert.ok(displayLength(entry.lines.join('')) <= 36);
  }
});

test('拆分后时间轴连续、不重叠、不倒退', () => {
  const processed = processSrtContent(longRawSrt);
  const firstGroup = processed.finalEntries.filter(
    (entry) => entry.startMs >= 1000 && entry.endMs <= 8000,
  );
  assert.ok(firstGroup.length > 1);
  assert.equal(firstGroup[0].startMs, 1000);
  assert.equal(firstGroup[firstGroup.length - 1].endMs, 8000);
  for (let index = 0; index < firstGroup.length; index += 1) {
    assert.ok(firstGroup[index].endMs > firstGroup[index].startMs);
    if (index > 0) {
      assert.equal(firstGroup[index].startMs, firstGroup[index - 1].endMs);
      assert.ok(firstGroup[index].startMs >= firstGroup[index - 1].startMs);
    }
  }
});

test('final-cn.srt、final-cn.txt、subtitle-report.md 和 subtitle-status.json 能生成', async () => {
  const project = await makeProject();
  const rawPath = path.join(project.projectPath, '07-字幕', 'raw.srt');
  await fs.writeFile(rawPath, longRawSrt, 'utf8');

  const result = await organizeSrtFile(project.projectPath);
  assert.equal(result.status.version, 'v3.0.0-stage7');
  assert.equal(result.status.status, 'success');
  assert.ok(result.status.finalCount > result.status.rawCount);

  const finalSrtPath = path.join(project.projectPath, '07-字幕', 'final-cn.srt');
  const finalTxtPath = path.join(project.projectPath, '07-字幕', 'final-cn.txt');
  const reportPath = path.join(project.projectPath, '07-字幕', 'subtitle-report.md');
  const statusPath = path.join(project.projectPath, '00-项目总控', 'subtitle-status.json');

  const finalSrt = await fs.readFile(finalSrtPath, 'utf8');
  const finalTxt = await fs.readFile(finalTxtPath, 'utf8');
  const report = await fs.readFile(reportPath, 'utf8');
  const status = JSON.parse(await fs.readFile(statusPath, 'utf8'));

  assert.match(finalSrt, /，/);
  assert.match(finalSrt, /。/);
  assert.match(finalTxt, /买MacBook后/);
  assert.match(report, /中文标点转换数量/);
  assert.match(report, /请将 final-cn\.srt 导入 FCP/);
  assert.equal(status.rawSrt, path.join('07-字幕', 'raw.srt'));
  assert.equal(status.finalSrt, path.join('07-字幕', 'final-cn.srt'));
  assert.equal(status.finalTxt, path.join('07-字幕', 'final-cn.txt'));
  assert.equal(status.report, path.join('07-字幕', 'subtitle-report.md'));

  const parsedFinal = parseSrt(finalSrt);
  for (const entry of parsedFinal) {
    assert.ok(displayLength(entry.text.replace(/\n/g, '')) <= 36);
  }
});

test('找不到 raw.srt 时返回明确错误', async () => {
  const project = await makeProject();
  await assert.rejects(
    () => organizeSrtFile(project.projectPath),
    /找不到 raw\.srt/,
  );
});
