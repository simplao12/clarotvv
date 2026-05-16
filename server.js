// server.js - Proxy IPTV usando IP REAL
// Bypass completo do Cloudflare proxy

const http = require('http');

const PORT = process.env.PORT || 3000;

// IP REAL do servidor (bypass Cloudflare)
const TARGET_IP = '38.99.238.132';
const TARGET_PORT = 80;
const TARGET_HOST = 'apsy.homes'; // Header Host necessário

const server = http.createServer((req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  // Health check
  if (req.url === '/ping' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok',
      target_ip: TARGET_IP,
      target_host: TARGET_HOST,
      bypass: 'cloudflare',
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // OPTIONS
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Fazer requisição DIRETA ao IP real
  const proxyReq = http.request({
    hostname: TARGET_IP,  // IP DIRETO (não passa pelo Cloudflare proxy)
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers: {
      'Host': TARGET_HOST,  // CRÍTICO: Manter host original
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
      'Connection': 'keep-alive',
      'Range': req.headers['range'] || '',
    },
    timeout: 30000,
  }, (proxyRes) => {
    console.log(`  → ${proxyRes.statusCode} | ${(proxyRes.headers['content-length'] || 0) / 1024 / 1024} MB`);

    // Copiar headers
    const responseHeaders = { ...proxyRes.headers };
    responseHeaders['Access-Control-Allow-Origin'] = '*';

    res.writeHead(proxyRes.statusCode, responseHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('  ✗ Error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ 
        error: err.message,
        target_ip: TARGET_IP,
        target_host: TARGET_HOST
      }));
    }
  });

  proxyReq.on('timeout', () => {
    console.error('  ✗ Timeout');
    proxyReq.destroy();
  });

  req.pipe(proxyReq);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 Proxy IPTV - Cloudflare Bypass');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📡 Porta: ${PORT}`);
  console.log(`🎯 IP Real: ${TARGET_IP}:${TARGET_PORT}`);
  console.log(`🌐 Host: ${TARGET_HOST}`);
  console.log(`✅ Bypass: Cloudflare Proxy`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
