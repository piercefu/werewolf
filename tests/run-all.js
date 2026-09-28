// One-command test runner: starts the server itself (with WW_FAST_TIMERS=1
// on a scratch port so it never collides with a real dev server you might
// have running), runs every tests/*.test.js file against it in sequence,
// tears the server down, and prints one overall summary.
//
// Usage: npm test
//   or:  node tests/run-all.js
//   or:  node tests/run-all.js --include-browser   (also runs browser.test.js;
//        requires `npm install playwright` first — see tests/README.md)
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.TEST_PORT || 3987;
const BASE_URL = `http://localhost:${PORT}`;
const includeBrowser = process.argv.includes('--include-browser');

function waitForServer(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function attempt() {
      fetch(url + '/healthz').then((r) => {
        if (r.ok) return resolve();
        retry();
      }).catch(retry);
      function retry() {
        if (Date.now() > deadline) return reject(new Error('server did not become ready in time'));
        setTimeout(attempt, 150);
      }
    })();
  });
}

function runTestFile(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      cwd: ROOT,
      env: { ...process.env, BASE_URL },
      stdio: 'pipe',
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ file, code, out }));
  });
}

(async () => {
  console.log(`Starting server on port ${PORT} with WW_FAST_TIMERS=1...`);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), WW_FAST_TIMERS: '1' },
    stdio: 'pipe',
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  let overallOk = true;
  try {
    await waitForServer(BASE_URL);
    console.log('Server ready.\n');

    const files = fs.readdirSync(__dirname)
      .filter((f) => f.endsWith('.test.js'))
      .filter((f) => includeBrowser || !f.startsWith('browser'))
      .sort()
      .map((f) => path.join(__dirname, f));

    for (const file of files) {
      const name = path.basename(file);
      console.log(`=== ${name} ===`);
      const { code, out } = await runTestFile(file);
      process.stdout.write(out.endsWith('\n') ? out : out + '\n');
      if (code !== 0) overallOk = false;
    }
  } catch (e) {
    console.error('Test run aborted:', e.message);
    console.error('--- server output ---\n' + serverLog);
    overallOk = false;
  } finally {
    server.kill('SIGKILL');
  }

  console.log(overallOk ? '\n=== ALL TEST FILES PASSED ===' : '\n=== SOME TEST FILES FAILED ===');
  process.exit(overallOk ? 0 : 1);
})();
