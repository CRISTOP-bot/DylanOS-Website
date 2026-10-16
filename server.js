const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5502;
const GITHUB_OWNER = 'dylanneymarmontalvo2014-lgtm';
const GITHUB_REPOSITORY = 'DylanOS-Website';
const GITHUB_CACHE_TTL = 60 * 1000;
let githubCache = null;

/* ========================= Asistente Ai DylanOS ========================= */
const ASSISTANT_DIR = path.join(__dirname, 'asistente ai');
const ASSISTANT_MAX_MESSAGES = 20;
const ASSISTANT_MAX_CONTENT = 2000;
const ASSISTANT_RATE_LIMIT = 15;          // peticiones por minuto por IP
const ASSISTANT_TIMEOUT = 60 * 1000;
const assistantRateMap = new Map();       // ip -> [timestamps]

function loadEnvFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(ASSISTANT_DIR, '.env'));

function readAssistantFile(name) {
  try {
    return fs.readFileSync(path.join(ASSISTANT_DIR, name), 'utf8').trim();
  } catch (error) {
    console.error(`No se pudo leer ${name} del asistente:`, error.message);
    return '';
  }
}

const assistantSystemPrompt = [
  readAssistantFile('system_prompt.md'),
  'BASE DE CONOCIMIENTO:\n' + readAssistantFile('memory_context.txt')
].join('\n\n');

function assistantRateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 60 * 1000;
  const hits = (assistantRateMap.get(ip) || []).filter(t => t > windowStart);
  if (hits.length >= ASSISTANT_RATE_LIMIT) {
    assistantRateMap.set(ip, hits);
    return true;
  }
  hits.push(now);
  assistantRateMap.set(ip, hits);
  return false;
}

function validateAssistantMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 ||
      messages.length > ASSISTANT_MAX_MESSAGES) {
    return null;
  }
  const sanitized = [];
  for (const message of messages) {
    if (!message || typeof message.content !== 'string' ||
        !['user', 'assistant'].includes(message.role)) {
      return null;
    }
    const content = message.content.trim();
    if (!content || content.length > ASSISTANT_MAX_CONTENT) return null;
    sanitized.push({ role: message.role, content });
  }
  if (sanitized[sanitized.length - 1].role !== 'user') return null;
  return sanitized;
}

function askAssistant(messages) {
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = (process.env.AI_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
  const model = process.env.AI_MODEL || 'meta/llama-3.2-11b-vision-instruct';

  if (!apiKey || apiKey === 'PEGAR_TU_API_KEY_AQUI') {
    return Promise.reject(Object.assign(
      new Error('El asistente no tiene configurada su API key.'),
      { statusCode: 503 }
    ));
  }
  if (!assistantSystemPrompt) {
    return Promise.reject(Object.assign(
      new Error('Falta la configuración del asistente (prompt/memoria).'),
      { statusCode: 503 }
    ));
  }

  const endpoint = new URL(`${baseUrl}/chat/completions`);
  const transport = endpoint.protocol === 'http:' ? http : https;
  const payload = JSON.stringify({
    model,
    messages: [{ role: 'system', content: assistantSystemPrompt }, ...messages],
    temperature: 0.4,
    max_tokens: 300,
    stream: false
  });

  return new Promise((resolve, reject) => {
    const request = transport.request({
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === 'http:' ? 80 : 443),
      path: endpoint.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'DylanOS-Website'
      },
      timeout: ASSISTANT_TIMEOUT
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(Object.assign(
            new Error(`La API de IA respondió ${response.statusCode}`),
            { statusCode: 502 }
          ));
          return;
        }
        try {
          const parsed = JSON.parse(body);
          const reply = parsed.choices &&
            parsed.choices[0] &&
            parsed.choices[0].message &&
            parsed.choices[0].message.content;
          if (!reply) throw new Error('Respuesta de IA vacía');
          resolve(reply.trim());
        } catch (error) {
          reject(Object.assign(error, { statusCode: 502 }));
        }
      });
    });
    request.on('timeout', () => {
      request.destroy(Object.assign(new Error('La API de IA tardó demasiado.'), { statusCode: 504 }));
    });
    request.on('error', error => {
      reject(Object.assign(error, { statusCode: error.statusCode || 502 }));
    });
    request.write(payload);
    request.end();
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(Object.assign(new Error('Cuerpo demasiado grande'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error('JSON inválido'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendAssistantReply(req, res) {
  const ip = req.socket.remoteAddress || 'desconocida';
  if (assistantRateLimited(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Demasiadas preguntas seguidas. Espera un momento e inténtalo de nuevo.' }));
    return;
  }

  readJsonBody(req).then(body => {
    const messages = validateAssistantMessages(body && body.messages);
    if (!messages) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Formato de mensajes inválido.' }));
      return null;
    }
    return askAssistant(messages).then(reply => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ reply }));
    });
  }).catch(error => {
    console.error('Error en /api/asistente:', error.message);
    const statusCode = error.statusCode || 500;
    const publicMessage = statusCode >= 400 && statusCode < 500 && statusCode !== 503
      ? error.message
      : statusCode === 503
        ? 'El asistente no está configurado todavía. Revisa el archivo .env.'
        : 'El asistente no pudo responder. Inténtalo de nuevo en unos segundos.';
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: publicMessage }));
  });
}
/* ====================== Fin Asistente Ai DylanOS ====================== */

function githubRequest(endpoint) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: 'api.github.com',
      path: endpoint,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'DylanOS-Website',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
      }
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GitHub API respondió ${response.statusCode}`));
          return;
        }
        try {
          resolve({ data: JSON.parse(body), headers: response.headers });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function getLastPage(linkHeader) {
  const lastPage = linkHeader && linkHeader.match(/[?&]page=(\d+)>; rel="last"/);
  return lastPage ? Number(lastPage[1]) : 1;
}

function getCollectionCount(result) {
  return result.data.length === 0 ? 0 : getLastPage(result.headers.link);
}

async function getGithubStats() {
  if (githubCache && Date.now() - githubCache.timestamp < GITHUB_CACHE_TTL) {
    return githubCache.data;
  }

  const repositoryPath = `/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}`;
  const [repository, commits, contributors, releases] = await Promise.all([
    githubRequest(repositoryPath),
    githubRequest(`${repositoryPath}/commits?per_page=1`),
    githubRequest(`${repositoryPath}/contributors?per_page=1&anon=true`),
    githubRequest(`${repositoryPath}/releases?per_page=1`)
  ]);
  const data = {
    commits: getCollectionCount(commits),
    stars: repository.data.stargazers_count,
    contributors: getCollectionCount(contributors),
    releases: getCollectionCount(releases)
  };
  githubCache = { data, timestamp: Date.now() };
  return data;
}

function sendGithubStats(res) {
  getGithubStats().then(data => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }).catch(error => {
    console.error('No se pudieron obtener las estadísticas de GitHub:', error.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No se pudieron obtener las estadísticas de GitHub' }));
  });
}

// Extensiones estáticas que deben servirse directamente
const staticExtensions = ['.js', '.css', '.json', '.xml', '.txt', '.png', '.webp', '.jpg', '.ico', '.svg', '.woff', '.woff2'];

function handleRequest(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }

  if (pathname === '/api/github-stats') {
    sendGithubStats(res);
    return;
  }

  if (pathname === '/api/asistente') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Método no permitido. Usa POST.' }));
      return;
    }
    sendAssistantReply(req, res);
    return;
  }

  // Resolución segura de rutas estáticas: normaliza, impide salir del
  // directorio raíz y bloquea archivos ocultos (.env, .git) y todo lo
  // que esté en "asistente ai/" fuera de su subcarpeta pública widget/.
  const requestedPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(__dirname, requestedPath));
  const isInsideRoot = filePath.startsWith(__dirname + path.sep);
  const hasHiddenSegment = requestedPath.split('/').some(segment => segment.startsWith('.'));
  const assistantRelative = path.relative(ASSISTANT_DIR, filePath);
  const isAssistantPrivate = !assistantRelative.startsWith('..') &&
    !assistantRelative.startsWith('widget' + path.sep) &&
    assistantRelative !== '';

  if (!isInsideRoot || hasHiddenSegment || isAssistantPrivate) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      const isStatic = staticExtensions.some(ext => filePath.endsWith(ext));
      if (isStatic) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
        return;
      }

      fs.readFile(path.join(__dirname, '404.html'), (notFoundErr, notFoundContent) => {
        if (notFoundErr) {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!DOCTYPE html><html><body><h1>404 Not Found</h1></body></html>');
          return;
        }

        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(notFoundContent);
      });
      return;
    } else {
      const contentTypes = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.xml': 'application/xml; charset=utf-8',
        '.txt': 'text/plain; charset=utf-8',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.jpg': 'image/jpeg',
        '.ico': 'image/x-icon',
        '.svg': 'image/svg+xml',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2'
      };
      const contentType = contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff' });
      res.end(content);
    }
  });
}

if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`Servidor ejecutándose en http://127.0.0.1:${PORT}`);
  });
}

module.exports = { handleRequest };
