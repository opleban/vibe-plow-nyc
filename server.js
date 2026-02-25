const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PORT = process.env.PORT || 8080;
const API_TARGET = 'https://plownyc.cityofnewyork.us';
const STATIC_DIR = __dirname;
const MAPBOX_TOKEN = process.env.MAPBOX_ACCESS_TOKEN || '';

// ── Plow tile color remapping ──────────────────────────────────
// Original NYC API colors → refined palette
const COLOR_MAP = [
  // [srcR, srcG, srcB] → [dstR, dstG, dstB]
  { src: [0x00, 0x80, 0x00], dst: [0x34, 0xa8, 0x53] }, // 0-1h:  green → softer green
  { src: [0x00, 0x00, 0xff], dst: [0x42, 0x85, 0xf4] }, // 1-3h:  blue → clear blue
  { src: [0xff, 0xff, 0x00], dst: [0xfb, 0xbc, 0x04] }, // 3-6h:  yellow → warm gold
  { src: [0xff, 0xa5, 0x00], dst: [0xe8, 0x71, 0x0a] }, // 6-12h: orange → burnt orange
  { src: [0x8a, 0x2b, 0xe2], dst: [0x9c, 0x6a, 0xde] }, // 12-24h: violet → soft violet
  { src: [0x3a, 0xe5, 0xee], dst: [0x4e, 0xb8, 0xc4] }, // 24-36h: cyan → muted teal
  { src: [0x4b, 0x3b, 0x30], dst: [0x8a, 0x7b, 0x6e] }, // 36+h:  dark brown → warm taupe
];

// ── Tile cache ──────────────────────────────────────────────────
const TILE_CACHE_MAX = 2000;        // max cached tiles
const TILE_CACHE_TTL = 5 * 60_000;  // 5 minutes

const tileCache = new Map();        // key: url path → { buffer, timestamp }

function getCachedTile(key) {
  const entry = tileCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > TILE_CACHE_TTL) {
    tileCache.delete(key);
    return null;
  }
  // Move to end for LRU behavior (Map preserves insertion order)
  tileCache.delete(key);
  tileCache.set(key, entry);
  return entry.buffer;
}

function setCachedTile(key, buffer) {
  if (tileCache.size >= TILE_CACHE_MAX) {
    // Evict oldest entry (first key in Map)
    const oldest = tileCache.keys().next().value;
    tileCache.delete(oldest);
  }
  tileCache.set(key, { buffer, timestamp: Date.now() });
}

// Designation tile colors (raw from NYC API)
const DESIG_COLORS = [
  [0xbf, 0x40, 0x2e], // Critical
  [0x11, 0x41, 0xaf], // Sector
  [0xa0, 0xcc, 0x17], // Narrow
  [0xff, 0xc2, 0x1e], // Non-DSNY
];

function remapPixels(data, hideSet) {
  // data is a raw RGBA buffer
  const len = data.length;
  for (let i = 0; i < len; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Find closest source color
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let j = 0; j < COLOR_MAP.length; j++) {
      const s = COLOR_MAP[j].src;
      const dr = r - s[0];
      const dg = g - s[1];
      const db = b - s[2];
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = j;
      }
    }

    // Only remap if the pixel is reasonably close to a known color
    // (threshold accounts for anti-aliasing and compression artifacts)
    if (bestDist < 12000) {
      // If this color index is hidden, make pixel transparent
      if (hideSet && hideSet.has(bestIdx)) {
        data[i + 3] = 0;
        continue;
      }

      const d = COLOR_MAP[bestIdx].dst;
      const s = COLOR_MAP[bestIdx].src;

      if (bestDist === 0) {
        // Exact match: direct replacement
        data[i] = d[0];
        data[i + 1] = d[1];
        data[i + 2] = d[2];
      } else {
        // Anti-aliased/blended pixel: interpolate proportionally
        // Calculate how much of the source color is present
        const t = Math.max(0, 1 - Math.sqrt(bestDist) / 110);
        data[i] = Math.round(r + (d[0] - s[0]) * t);
        data[i + 1] = Math.round(g + (d[1] - s[1]) * t);
        data[i + 2] = Math.round(b + (d[2] - s[2]) * t);
      }
    }
  }
  return data;
}

function filterDesigPixels(data, hideSet) {
  const len = data.length;
  for (let i = 0; i < len; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    let bestIdx = -1, bestDist = Infinity;
    for (let j = 0; j < DESIG_COLORS.length; j++) {
      const c = DESIG_COLORS[j];
      const dr = r - c[0], dg = g - c[1], db = b - c[2];
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) { bestDist = dist; bestIdx = j; }
    }
    if (bestDist < 12000 && hideSet.has(bestIdx)) {
      data[i + 3] = 0;
    }
  }
  return data;
}

async function remapTile(inputBuffer, hideSet) {
  const image = sharp(inputBuffer);
  const { width, height } = await image.metadata();
  const raw = await image.ensureAlpha().raw().toBuffer();
  remapPixels(raw, hideSet);
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function filterDesigTile(inputBuffer, hideSet) {
  const image = sharp(inputBuffer);
  const { width, height } = await image.metadata();
  const raw = await image.ensureAlpha().raw().toBuffer();
  filterDesigPixels(raw, hideSet);
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

// ── MIME types ──────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ── Server ──────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Proxy API requests
  if (req.url.startsWith('/api/')) {
    // Parse and strip the `hide` filter param (not forwarded to NYC API)
    const parsed = new URL(req.url, 'http://localhost');
    const hideStr = parsed.searchParams.get('hide') || '';
    const hideSet = hideStr ? new Set(hideStr.split(',').map(Number)) : null;
    parsed.searchParams.delete('hide');
    const cleanUrl = parsed.pathname + parsed.search;

    const targetPath = '/mappingapi' + cleanUrl;
    const targetUrl = API_TARGET + targetPath;

    const isTileReq = targetPath.includes('highlight') && !targetPath.includes('active') && !targetPath.includes('info');
    const isPlowTile = isTileReq && targetPath.includes('VISITED');
    const isDesigTile = isTileReq && !isPlowTile;

    // For tiles: check raw cache (keyed by URL without hide param)
    if (isPlowTile || isDesigTile) {
      const rawCached = getCachedTile(cleanUrl);
      if (rawCached) {
        (async () => {
          try {
            let outputBuf;
            if (isPlowTile) {
              outputBuf = await remapTile(rawCached, hideSet);
            } else if (hideSet && hideSet.size > 0) {
              outputBuf = await filterDesigTile(rawCached, hideSet);
            } else {
              outputBuf = rawCached;
            }
            res.writeHead(200, {
              'Content-Type': 'image/png',
              'Cache-Control': 'public, max-age=300',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(outputBuf);
          } catch {
            res.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' });
            res.end(rawCached);
          }
        })();
        return;
      }
    }

    https.get(targetUrl, (proxyRes) => {
      // For tile requests: if upstream returns 204/empty or non-image content,
      // return 404 so Mapbox GL JS silently skips the tile
      if (isTileReq && (proxyRes.statusCode === 204 || !(proxyRes.headers['content-type'] || '').includes('image'))) {
        proxyRes.resume();
        res.writeHead(404, {
          'Content-Type': 'text/plain',
          'Access-Control-Allow-Origin': '*',
        });
        res.end('');
        return;
      }

      // For tile requests: buffer the response, process, then send
      if ((isPlowTile || isDesigTile) && proxyRes.statusCode === 200) {
        const chunks = [];
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', async () => {
          const inputBuf = Buffer.concat(chunks);
          // Cache the raw tile (before any processing)
          setCachedTile(cleanUrl, inputBuf);
          try {
            let outputBuf;
            if (isPlowTile) {
              outputBuf = await remapTile(inputBuf, hideSet);
            } else if (hideSet && hideSet.size > 0) {
              outputBuf = await filterDesigTile(inputBuf, hideSet);
            } else {
              outputBuf = inputBuf;
            }
            res.writeHead(200, {
              'Content-Type': 'image/png',
              'Cache-Control': 'public, max-age=300',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(outputBuf);
          } catch {
            res.writeHead(200, {
              'Content-Type': proxyRes.headers['content-type'] || 'image/png',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(inputBuf);
          }
        });
        return;
      }

      // Other API responses: pipe directly
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': proxyRes.headers['content-type'] || 'application/octet-stream',
        'Cache-Control': proxyRes.headers['cache-control'] || 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      proxyRes.pipe(res);
    }).on('error', (err) => {
      console.error('Proxy error:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Proxy error' }));
    });
    return;
  }

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // Serve static files
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(STATIC_DIR, filePath);

  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (req.url === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    // Inject Mapbox token into HTML at runtime
    if (ext === '.html' && MAPBOX_TOKEN) {
      const html = data.toString().replace(
        '</head>',
        `<script>window.__MAPBOX_TOKEN__='${MAPBOX_TOKEN}';</script></head>`
      );
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`PlowNYC running at http://localhost:${PORT}`);
  console.log(`API proxy: /api/* -> ${API_TARGET}/mappingapi/api/*`);
  console.log('Plow tile color remapping: enabled');
});
