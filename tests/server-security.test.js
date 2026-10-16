'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { handleRequest } = require('../server');

function dispatch(pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.url = pathname;
    req.method = method;
    req.socket = { remoteAddress: '127.0.0.1' };

    const res = {
      statusCode: null,
      headers: {},
      writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        this.headers = headers;
      },
      end(body = '') {
        resolve({ statusCode: this.statusCode, headers: this.headers, body: String(body) });
      }
    };

    try {
      handleRequest(req, res);
    } catch (error) {
      reject(error);
    }
  });
}

test('malformed percent-encoded paths return 400 without crashing the handler', async () => {
  const response = await dispatch('/%E0%A4%A');
  assert.equal(response.statusCode, 400);
  assert.equal(response.body, '400 Bad Request');
  assert.equal((await dispatch('/')).statusCode, 200);
});

test('Vercel assistant route reuses the server handler and rejects GET', async () => {
  const assistantHandler = require('../api/asistente');
  assert.equal(typeof assistantHandler, 'function');
  assert.equal(typeof require('../api/github-stats'), 'function');

  const response = await dispatch('/api/asistente');
  assert.equal(response.statusCode, 405);
  assert.match(response.headers['Content-Type'], /application\/json/);
});

test('manifest and stylesheet exist and are served with correct MIME types', async () => {
  const manifest = await dispatch('/manifest.json');
  assert.equal(manifest.statusCode, 200);
  assert.match(manifest.headers['Content-Type'], /application\/json/);
  assert.equal(JSON.parse(manifest.body).short_name, 'DylanOS');

  const stylesheet = await dispatch('/styles/css2.css');
  assert.equal(stylesheet.statusCode, 200);
  assert.match(stylesheet.headers['Content-Type'], /text\/css/);

  const page = await dispatch('/');
  assert.match(page.body, /<source srcset="\.\/images\/84654fb6f_Screenshot_6\.webp" type="image\/webp">/);
  assert.equal((await dispatch('/images/84654fb6f_Screenshot_6.webp')).statusCode, 200);
  assert.equal((await dispatch('/images/84654fb6f_Screenshot_6.png')).statusCode, 200);
});
