'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function request(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: 'GET'
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    req.setTimeout(1000, () => req.destroy(new Error('request timed out')));
    req.once('error', reject);
    req.end();
  });
}

async function waitForServer(port, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with code ${child.exitCode}`);
    }
    try {
      await request(port, '/');
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error('server did not start within 5 seconds');
}

test('malformed percent-encoded paths return 400 without crashing the server', async t => {
  const port = await getAvailablePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: repositoryRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore'
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  await waitForServer(port, child);
  assert.equal(await request(port, '/%E0%A4%A'), 400);
  assert.equal(await request(port, '/'), 200);
});
