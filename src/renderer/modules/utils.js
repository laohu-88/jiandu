(function createPlannerUtils(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PlannerUtils = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN');
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds - minutes * 60;
    return `${String(minutes).padStart(2, '0')}:${remaining.toFixed(2).padStart(5, '0')}`;
  }

  function createTextElement(tag, text, className = '') {
    if (typeof document === 'undefined') {
      return { tagName: String(tag).toUpperCase(), textContent: text, className };
    }
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function getUserErrorMessage(error) {
    const raw = error?.message || String(error);
    return raw
      .replace(/^Error invoking remote method '[^']+':\s*/i, '')
      .replace(/^Error:\s*/i, '')
      .split('\n')[0]
      || '操作失败，请查看项目总控中的日志文件。';
  }

  function createToastHelper(toastElement, options = {}) {
    let timer = null;
    const hideDelayMs = Number(options.hideDelayMs) || 5000;
    return function showToast(message, isError = false) {
      if (!toastElement) return;
      if (timer) clearTimeout(timer);
      toastElement.textContent = message;
      if (toastElement.classList) {
        toastElement.classList.toggle('error', Boolean(isError));
        toastElement.classList.remove('hidden');
        timer = setTimeout(() => toastElement.classList.add('hidden'), hideDelayMs);
      }
    };
  }

  async function withBusy(button, action, busyText = '处理中…', showToast) {
    if (!button) return action();
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
    try {
      return await action();
    } catch (error) {
      if (typeof showToast === 'function') {
        showToast(getUserErrorMessage(error), true);
      }
      return null;
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  return {
    formatDateTime,
    formatDuration,
    createTextElement,
    getUserErrorMessage,
    createToastHelper,
    withBusy,
  };
}));
