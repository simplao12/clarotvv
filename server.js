// server.js - Proxy com múltiplos resolvedores DNS
// Fallback: 1.1.1.1 → 8.8.8.8 → 9.9.9.9 → IP direto

const http = require('http');
const https = require('https');
const dns = require('dns').promises;

const PORT = process.env.PORT || 3000;
const TARGET_PORT = 80;
const TARGET_HOST = 'apsy.homes';
const FALLBACK_IP = '38.99.238.132'; // IP direto caso DNS falhe

// Resolvedores DNS alternativos
const DNS_RESOLVERS = [
  { name: 'Cloudflare', host: 'cloudflare-dns.com', path: (h) => `/dns-query?name=${h}&type=A` },
  { name: 'Google', host: 'dns.google', path: (h) => `/resolve?name=${h}&type=A` },
  { name: 'Quad9', host: 'dns.quad9.net', path: (h) => `/dns-query?name=${h}&type=A` },
];

let cachedIP = null;
let lastResolve = 0;
const CACHE_TIME = 300000; // 5 min

// Tentar resolver com DoH
async function resolveDoH(resolver, hostname) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: resolver.host,
      port: 443,
      path: resolver.path(hostname),
      method: 'GET',
      headers: { 'Accept': 'application/dns-json' },
      timeout: 5000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          
          // Cloudflare/Quad9 format
          if (json.Answer && json.Answer.length > 0) {
            resolve(json.Answer[0].data);
          }
          // Google format
          else if (json.Answer && json.Answer[0] && json.Answer[0].data) {
            resolve(json.Answer[0].data);
          }
          else {
            reject(new Error('Sem resposta DNS'));
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    
    req.end();
  });
}

// Resolver com fallback entre todos os resolvedores
async function resolveDNS(hostname) {
  const now = Date.now();
  
  // Cache válido
  if (cachedIP && (now - lastResolve) < CACHE_TIME) {
    return cachedIP;
  }

  console.log(`  → Resolvendo DNS: ${hostname}`);

  // Tentar cada resolvedor em ordem
  for (const resolver of DNS_RESOLVERS) {
    try {
      console.log(`  → Tentando ${resolver.name}...`);
      const ip = await resolveDoH(resolver, hostname);
      console.log(`  ✓ ${resolver.name}: ${hostname} → ${ip}`);
      
      cachedIP = ip;
      lastResolve = now;
      return ip;
    } catch (err) {
      console.log(`  ✗ ${resolver.name} falhou: ${err.message}`);
      continue;
    }
  }

  // Fallback: DNS nativo do sistema
  try {
    console.log(`  → Tentando DNS nativo...`);
    const addresses = await dns.resolve4(hostname);
    if (addresses && addresses.length > 0) {
      const ip = addresses[0];
      console.log(`  ✓ DNS nativo: ${hostname} → ${ip}`);
      cachedIP = ip;
      lastResolve = now;
      return ip;
    }
  } catch (err) {
    console.log(`  ✗ DNS nativo falhou: ${err.message}`);
  }

  // Último recurso: IP hardcoded
  console.log(`  → Usando IP fallback: ${FALLBACK_IP}`);
  cachedIP = FALLBACK_IP;
  lastResolve = now;
  return FALLBACK_IP;
}

const USER_AGENTS = [
  'ExoPlayerLib/2.18.1 (Linux;Android 11)',
  'VLC/3.0.16 LibVLC/3.0.16',
  'AppleCoreMedia/1.0.0.19A346',
  'Lavf/58.76.100',
];

const server = http.createServer(async (req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.url === '/ping' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok',
      cached_ip: cachedIP,
      resolvers: DNS_RESOLVERS.map(r => r.name),
      fallback_ip: FALLBACK_IP,
    }));
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // M3U endpoint
  if (req.url.startsWith('/get-m3u')) {
    const urlParams = new URL(req.url, `http://localhost`);
    const username = urlParams.searchParams.get('username');
    const password = urlParams.searchParams.get('password');

    if (!username || !password) {
      res.writeHead(400);
      res.end('Erro: username e password obrigatórios');
      return;
    }

    try {
      const ip = await resolveDNS(TARGET_HOST);
      const m3uUrl = `http://${ip}:${TARGET_PORT}/get.php?username=${username}&password=${password}&type=m3u_plus&output=ts`;
      
      const proxyReq = http.request(m3uUrl, {
        headers: { 'Host': TARGET_HOST, 'User-Agent': USER_AGENTS[0] },
        timeout: 60000,
      }, (proxyRes) => {
        let m3uContent = '';
        proxyRes.on('data', (c) => { m3uContent += c.toString(); });
        proxyRes.on('end', () => {
          const myUrl = req.headers.host;
          const protocol = req.headers['x-forwarded-proto'] || 'https';
          const converted = m3uContent.replace(
            new RegExp(`http://${TARGET_HOST}:${TARGET_PORT}`, 'g'),
            `${protocol}://${myUrl}`
          );
          res.writeHead(200, { 
            'Content-Type': 'application/x-mpegURL',
            'Content-Disposition': `attachment; filename="${username}.m3u"`
          });
          res.end(converted);
        });
      });
      proxyReq.on('error', (err) => {
        res.writeHead(500);
        res.end(`Erro: ${err.message}`);
      });
      proxyReq.end();
    } catch (err) {
      res.writeHead(500);
      res.end(`Erro DNS: ${err.message}`);
    }
    return;
  }

  // Stream proxy
  try {
    const ip = await resolveDNS(TARGET_HOST);
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

    const proxyReq = http.request({
      hostname: ip,
      port: TARGET_PORT,
      path: req.url,
      method: req.method,
      headers: {
        'Host': TARGET_HOST,
        'User-Agent': ua,
        'Accept': '*/*',
        'Connection': 'keep-alive',
        'Range': req.headers['range'] || '',
      },
      timeout: 60000,
    }, (proxyRes) => {
      const headers = { ...proxyRes.headers };
      headers['Access-Control-Allow-Origin'] = '*';
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end(`Erro: ${err.message}`);
      }
    });

    req.pipe(proxyReq);
  } catch (err) {
    res.writeHead(500);
    res.end(`Erro DNS: ${err.message}`);
  }
});

server.timeout = 300000;

server.listen(PORT, '0.0.0.0', () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 Proxy IPTV - Multi DNS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📡 Porta: ${PORT}`);
  console.log(`🌐 Target: ${TARGET_HOST}`);
  console.log(`🔒 Resolvedores:`);
  DNS_RESOLVERS.forEach(r => console.log(`   • ${r.name} (${r.host})`));
  console.log(`💾 Fallback: ${FALLBACK_IP}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  resolveDNS(TARGET_HOST).then(ip => {
    console.log(`✓ DNS resolvido: ${ip}\n`);
  });
});
