#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const context = require('./context');

function main(args, env = process.env) {
  const [operation, ...rest] = args;
  const root = path.resolve(__dirname, '../..');
  if (!env.COPILOT_SESSION_ID) throw new Error('Use this helper inside the bound Copilot session; COPILOT_SESSION_ID is missing');
  if (!env.ZENSU_BOUND_SESSION_ID || env.COPILOT_SESSION_ID !== env.ZENSU_BOUND_SESSION_ID) {
    throw new Error('Copilot session binding mismatch; run this helper through the bound native bash tool without overriding session selectors');
  }
  const bound = context.resolveContext({ sessionId: env.COPILOT_SESSION_ID, cwd: env.COPILOT_PROJECT_DIR || process.cwd() }, env, root);
  if (operation === 'ai-work') {
    const capture = require('./ai-work');
    if (env.ZENSU_CAPTURE_MAIN !== '1' || env.ZENSU_CAPTURE_NATIVE_SESSION_ID !== bound.sessionId) throw new Error('AI work capture requires the native main session');
    bound.captureMain = true;
    try { process.stdout.write(JSON.stringify(capture.run(bound, rest[0], rest.slice(1))) + '\n'); }
    catch { throw new Error(capture.INCOMPLETE); }
    return 0;
  }
  const childEnv = context.nativeEnv(bound, env);
  if (operation !== 'runtime' || !rest[0] || !/^[a-z0-9-]+\.sh$/.test(rest[0])) throw new Error('Usage: helper.js runtime <helper.sh> [args]. Plan approval is handled only by the native human-response hook.');
  const script = path.join(root, 'hooks/lib', rest.shift());
  const result = spawnSync('bash', [script, ...rest], { env: childEnv, cwd: bound.cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) { console.error(`Zensu: ${error.message}`); process.exitCode = 1; }
}
module.exports = { main };
