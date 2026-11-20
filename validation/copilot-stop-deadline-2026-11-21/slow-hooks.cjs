'use strict';
const fs = require('node:fs');
const path = require('node:path');

try {
  const config = JSON.parse(fs.readFileSync(process.env.STOP_PROBE_CONFIG, 'utf8'));
  const evaluated = process._eval !== undefined;
  const script = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
  const inPlugin = script.startsWith(config.pluginRoot + path.sep);
  const dispatcher = script === path.join(config.pluginRoot, 'hooks/native/dispatcher.js');
  if ((inPlugin && !dispatcher) || evaluated) {
    const armed = fs.existsSync(config.flag);
    const delayMs = armed ? config.delayMs : 0;
    fs.appendFileSync(config.log, JSON.stringify({
      t: Date.now(), pid: process.pid, ppid: process.ppid,
      script: evaluated ? 'node -e' : path.relative(config.pluginRoot, script), armed, delayMs,
    }) + '\n');
    if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
} catch {}
