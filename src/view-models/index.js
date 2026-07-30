(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerViewModels = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const issueCenter = (typeof require === 'function' ? (() => { try { return require('./issue-center-view-model'); } catch { return null; } })() : null)
    || root.IssueCenterViewModel;
  const douyinWorkflow = (typeof require === 'function' ? (() => { try { return require('./douyin-workflow-view-model'); } catch { return null; } })() : null)
    || root.DouyinWorkflowViewModel;
  const workspace = (typeof require === 'function' ? (() => { try { return require('./workspace-view-model'); } catch { return null; } })() : null)
    || root.WorkspaceViewModel;

  return {
    ...issueCenter,
    ...douyinWorkflow,
    ...workspace,
  };
}));
