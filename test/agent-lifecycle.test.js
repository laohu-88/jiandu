'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  LIFECYCLE,
  createAttempt,
  evaluateLiveness,
  lifecycleOf,
  processingViewModel,
  recoveryActions,
} = require('../src/services/agent-lifecycle-service');
const { matchesEngine } = require('../src/services/agent-runtime-service');

test('Codex 是唯一 provider 且生命周期文案不暴露内部阶段', () => {
  const task = {
    taskId: 'task',
    engine: 'codex',
    status: 'analyzing_media',
    stage: 'analyzing_media',
    currentAttempt: createAttempt({ engine: 'codex', status: LIFECYCLE.running }),
  };
  assert.equal(lifecycleOf(task), LIFECYCLE.running);
  assert.match(processingViewModel(task).title, /Codex/);
  assert.deepEqual(recoveryActions({ status: 'agent_disconnected' }).map((item) => item.label), ['继续使用 Codex', '取消任务']);
});

test('Codex 运行时只按进程和心跳判断，不支持窗口注入', () => {
  assert.equal(matchesEngine('/Applications/Codex.app/Contents/MacOS/Codex', 'codex'), true);
  const task = {
    taskId: 'task',
    engine: 'codex',
    status: 'analyzing_media',
    stage: 'analyzing_media',
    currentAttempt: createAttempt({ engine: 'codex', status: LIFECYCLE.running }),
  };
  const live = evaluateLiveness(task, { processExists: true, sessionExists: true }, Date.now());
  assert.equal(live.live, true);
  assert.equal(live.disconnected, false);
});
