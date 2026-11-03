'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const INCOMPLETE = 'Zensu AI work capture incomplete. No acceptance was recorded. Check personal OAuth login, capture prerequisites and connection; retry the same goal.';
function mainPrincipal(raw, root) {
  try {
    const principal = require(path.join(root, 'hooks/lib/copilot-principal-v1.js'));
    return principal.classifyPreToolPayload(raw) === principal.PRINCIPALS.MAIN;
  } catch {
    // Missing capture prerequisites cannot grant reporting authority or prevent
    // the existing policy gates from delivering their own verdict.
    return false;
  }
}
function key(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512 || /[\x00-\x1f\x7f]/.test(sessionId)) throw new Error('Missing native session');
  return 'awcv1_' + crypto.createHash('sha256').update('zensu.ai-work.v1\0copilot\0' + sessionId).digest('hex');
}
function options(context, args = []) {
  if (context.captureMain !== true || context.nativeSessionId !== context.sessionId || context.parentId || context.agentRecord) throw new Error('Capture is restricted to the native main session');
  const workspace = fs.realpathSync(context.record?.cwd || context.cwd);
  if (workspace !== fs.realpathSync(context.cwd)) throw new Error('Capture workspace changed');
  const values = { workspace, session: key(context.sessionId) };
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!['--task', '--title', '--criteria', '--run-kind', '--cross-product-reason', '--feature', '--feature-revision', '--maintenance-reason', '--review-file'].includes(name) || typeof args[i + 1] !== 'string' || Object.hasOwn(values, name.slice(2))) throw new Error('Invalid capture arguments');
    values[name.slice(2)] = args[i + 1];
  }
  return values;
}
function run(context, action, args = [], budgetMs = 20000) {
  if (action === 'checkpoint' && args.some((arg, i) => i % 2 === 0 && arg !== '--review-file')) throw new Error('Checkpoint accepts only a review file');
  if (action !== 'checkpoint' && args.includes('--review-file')) throw new Error('Review details belong to checkpoint');
  const bound = { ...options(context, args), source: 'copilot', sourceVersion: JSON.parse(fs.readFileSync(path.join(context.pluginRoot, 'plugin.json'), 'utf8')).version };
  return require(path.join(context.pluginRoot, 'hooks/lib/ai-work-capture-v1.js')).run(action, bound, budgetMs);
}
function primer(context) {
  if (context.captureMain !== true) return '';
  const preflight = require(path.join(context.pluginRoot, 'hooks/lib/ai-work-preflight-v1.js'));
  const helper = JSON.stringify(path.join(context.pluginRoot, 'hooks/native/helper.js'));
  return `${preflight.instructions()} Zensu AI work capture: For an authorized implementation goal, first require a confirmed repository product binding. Obtain explicit human confirmation before zensu ai-work bind --product <id> --confirm; never infer consent from repository names or config. Without a binding, skip capture and continue coding. For each goal obtain explicit human confirmation of --feature <uuid>, optionally --feature-revision <uuid>; never infer it from a task key or repository. Product maintenance without a feature requires an explicit per-goal --maintenance-reason. Missing goal scope skips capture without blocking coding. Cross-product work requires explicit human intent and a per-goal --cross-product-reason; never use it as a fallback. Use node ${helper} ai-work begin --task <stable-goal-key> --title <agreed-objective> --criteria <criteria-version-or-digest>. Quote each value. Explicit validation/demo/probe tasks must use --run-kind test; normal product work including tests uses --run-kind work. Reuse the same values on retries; use a new key for a changed goal. This applies in direct mode too. Do not begin for startup, greetings or read-only questions. Run node ${helper} ai-work checkpoint --review-file <explicit-review.json> after the final clean commit, with the implemented summary, criteria, evidence and optional artifactUrl within the approved disclosure scope, and include its exact reviewUrl. Personal CLI OAuth is required; capture failures remain visible and do not block coding. Stop retries only already declared goals. A report, commit, merge or green test never accepts a result; human acceptance and revocation remain web-only. No transcripts, code, diffs or token usage are captured. See ${path.join(context.pluginRoot, 'docs/ai-work-capture.md')}.`;
}
module.exports = { mainPrincipal, key, options, run, primer, INCOMPLETE };
