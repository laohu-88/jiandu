const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const PROTOCOL_SCHEME = 'video-cut-planner';
const PROTOCOL_PREFIX = `${PROTOCOL_SCHEME}://`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertTaskId(taskId) {
  const value = String(taskId || '');
  if (!UUID_PATTERN.test(value)) {
    throw Object.assign(new Error('回流 task ID 必须是合法 UUID。'), {
      code: 'INVALID_RETURN_TASK_ID',
    });
  }
  return value.toLowerCase();
}

function buildReturnUrl(taskId) {
  return `${PROTOCOL_PREFIX}handoff/${assertTaskId(taskId)}`;
}

function parseReturnUrl(rawUrl) {
  const value = String(rawUrl || '');
  if (!value.startsWith(PROTOCOL_PREFIX) || value.length > 2048) {
    throw Object.assign(new Error('回流 URL 协议或长度无效。'), {
      code: 'INVALID_RETURN_URL',
    });
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw Object.assign(new Error('回流 URL 无法解析。'), { code: 'INVALID_RETURN_URL' });
  }
  if (parsed.protocol !== `${PROTOCOL_SCHEME}:`
    || parsed.hostname !== 'handoff'
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.search
    || parsed.hash) {
    throw Object.assign(new Error('回流 URL 路由无效。'), { code: 'INVALID_RETURN_URL' });
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) {
    throw Object.assign(new Error('回流 URL 路径无效。'), { code: 'INVALID_RETURN_URL' });
  }
  const taskId = assertTaskId(segments[0]);
  if (value !== buildReturnUrl(taskId)) {
    throw Object.assign(new Error('回流 URL 不是规范路由。'), { code: 'INVALID_RETURN_URL' });
  }
  return Object.freeze({ taskId, url: value });
}

function protocolUrlFromArgv(argv = []) {
  for (const argument of argv) {
    if (String(argument).startsWith(PROTOCOL_PREFIX)) return String(argument);
  }
  return null;
}

class ProtocolQueue {
  constructor() {
    this.pending = [];
    this.queued = new Set();
  }

  enqueue(rawUrl) {
    const parsed = parseReturnUrl(rawUrl);
    if (this.queued.has(parsed.taskId)) return { ...parsed, duplicate: true };
    this.queued.add(parsed.taskId);
    this.pending.push(parsed);
    return { ...parsed, duplicate: false };
  }

  async drain(handler) {
    while (this.pending.length) {
      const entry = this.pending.shift();
      try {
        await handler(entry);
      } finally {
        this.queued.delete(entry.taskId);
      }
    }
  }
}

async function openReturnUrl(taskId, options = {}) {
  const run = options.execFileImpl || execFileAsync;
  const url = buildReturnUrl(taskId);
  if (process.platform !== 'darwin' && !options.allowNonDarwin) {
    return { opened: false, url, reason: 'unsupported-platform' };
  }
  await run('/usr/bin/open', [url], { timeout: 30_000 });
  return { opened: true, url };
}

module.exports = {
  PROTOCOL_PREFIX,
  PROTOCOL_SCHEME,
  ProtocolQueue,
  assertTaskId,
  buildReturnUrl,
  openReturnUrl,
  parseReturnUrl,
  protocolUrlFromArgv,
};
