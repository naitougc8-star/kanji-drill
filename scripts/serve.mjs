// 開発用の静的サーバー(依存なし)。LAN 内の iPad からもアクセスできるよう 0.0.0.0 で待ち受ける。
//   node scripts/serve.mjs [--port 8080] [--host 0.0.0.0]
// .gz は Content-Encoding を付けずに、そのままのバイト列で返す(GitHub Pages と同じ)。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};
// 公開しないディレクトリ
const DENY = ['node_modules', '.git', 'tests', 'test-results', 'playwright-report'];

function handle(req, res) {
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  const rel = path.relative(ROOT, file);
  if (rel.startsWith('..') || path.isAbsolute(rel) || DENY.includes(rel.split(path.sep)[0])) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
}

/** サーバーを起動する(Playwright のテストからも使う)。戻り値は http.Server */
export function startServer({ port = 8080, host = '0.0.0.0' } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handle);
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
  };
  const PORT = Number(opt('--port', process.env.PORT || 8080));
  const HOST = opt('--host', '0.0.0.0');
  await startServer({ port: PORT, host: HOST });
  console.log(`http://localhost:${PORT}/`);
  if (HOST === '0.0.0.0') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`LAN: http://${a.address}:${PORT}/`);
    }
  }
}
