import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { migrate } from './db.js';
import { startCleanup } from './cleanup.js';
import { dropsRouter } from './routes/drops.js';
import { pairRouter } from './routes/pair.js';
import { downloadRouter } from './routes/download.js';

const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    "worker-src 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // Share links carry the token in the path; never leak it via Referer.
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), interest-cohort=()',
};

app.use((req, res, next) => {
  res.set(SECURITY_HEADERS);
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/drops', dropsRouter);
app.use('/api/d', downloadRouter);
app.use('/api/pair', pairRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Не найдено' }));

// PWA Share Target: normally handled by the service worker; this is the fallback when it isn't active yet.
app.get('/share-target', (_req, res) => res.redirect(303, '/upload'));
app.post('/share-target', (req, res) => {
  req.resume();
  res.redirect(303, '/upload');
});

if (fs.existsSync(config.staticDir)) {
  const indexHtml = path.join(config.staticDir, 'index.html');
  app.get('/', (_req, res) => res.redirect(302, '/home'));
  app.use('/assets', express.static(path.join(config.staticDir, 'assets'), { immutable: true, maxAge: '1y' }));
  app.use(
    express.static(config.staticDir, {
      index: false,
      setHeaders(res, file) {
        // The service worker and manifest must be revalidated so updates reach users promptly.
        if (file.endsWith('sw.js') || file.endsWith('.webmanifest')) res.set('Cache-Control', 'no-cache');
      },
    }),
  );
  // Public pages listed in sitemap.xml. Share links and unknown paths stay out of the index.
  const INDEXABLE = new Set(['/home', '/upload', '/receive', '/offline', '/offline/send', '/offline/receive', '/policy']);
  app.get('*', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    const pathname = req.path.replace(/\/+$/, '') || '/';
    if (!INDEXABLE.has(pathname)) res.set('X-Robots-Tag', 'noindex');
    res.sendFile(indexHtml);
  });
}

const CLIENT_ABORT_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE']);

app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500 && !CLIENT_ABORT_CODES.has(err.code)) console.error(err);
  if (res.headersSent) return res.destroy();
  res.status(status).json({ error: status < 500 && err.message ? err.message : 'Внутренняя ошибка сервера' });
});

await migrate();
startCleanup();

app.listen(config.port, config.host, () => {
  console.log(`Vetrimus Drop listening on http://${config.host}:${config.port}`);
});
