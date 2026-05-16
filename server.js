// server.js - Proxy IPTV com DNS-over-HTTPS
// Usa 1.1.1.1 Cloudflare DoH para resolver apsy.homes

const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const TARGET_PORT = 80;
const TARGET_HOST = 'apsy.homes';

// Cache de IP resolvido via DoH
let cachedIP = null;
let lastDNSResolve = 0;
const DNS_CACHE_TIME = 300000; // 5 minutos

// Resolver DNS usando Cloudflare DNS-over-HTTPS (1.1.1.1)
async function resolveWithDoH(hostname) {
  const now = Date.now();
  
  // Usar cache se válido
  if (cachedIP && (now - lastDNSResolve) < DNS_CACHE_TIME) {
    console.log(`  → DNS (cached): ${cachedIP}`);
    return cachedIP;
  }

  return new Promise((resolve, reject) => {
    console.log(`  → Resolvendo DNS via DoH (1.1.1.1)...`);
    
    const options = {
      hostname: 'cloudflare-dns.com',
      port: 443,
      path: `/dns-query?name=${hostname}&type=A`,
      method: 'GET',
      headers: {
        'Accept': 'application/dns-json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const dnsResponse = JSON.parse(data);
          
          if (dnsResponse.Answer && dnsResponse.Answer.length > 0) {
            // Pegar primeiro IP da resposta
            const ip = dnsResponse.Answer[0].data;
            console.log(`  ✓ DNS resolvido: ${hostname} → ${ip}`);
            
            // Atualizar cache
            cachedIP = ip;
            lastDNSResolve = now;
            
            resolve(ip);
          } else {
            console.error('  ✗ Sem resposta DNS');
            reject(new Error('DNS sem resposta'));
          }
        } catch (err) {
          console.error('  ✗ Erro ao parsear DNS:', err.message);
          reject(err);
        }
      });
    });

    req.on('error', (err) => {
      console.error('  ✗ Erro DoH:', err.message);
      
      // Fallback: usar IP conhecido
      if (cachedIP) {
        console.log(`  → Usando IP em cache: ${cachedIP}`);
        resolve(cachedIP);
      } else {
        // IP hardcoded como último recurso
        console.log('  → Usando IP hardcoded: 38.99.238.132');
        resolve('38.99.238.132');
      }
    });

    req.end();
  });
}

// Pool de User-Agents
const USER_AGENTS = [
  'ExoPlayerLib/2.18.1 (Linux;Android 11)',
  'AppleCoreMedia/1.0.0.19A346 (iPhone; U; CPU OS 15_0)',
  'VLC/3.0.16 LibVLC/3.0.16',
  'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0)',
  'Lavf/58.76.100',
];

function getUserAgent(url) {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash) + url.charCodeAt(i);
  }
  return USER_AGENTS[Math.abs(hash) % USER_AGENTS.length];
}

const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
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
      target_host: TARGET_HOST,
      cached_ip: cachedIP,
      dns_method: 'DoH (1.1.1.1)',
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

  // Endpoint M3U
  if (req.url.startsWith('/get-m3u')) {
    const urlParams = new URL(req.url, `http://localhost`);
    const username = urlParams.searchParams.get('username');
    const password = urlParams.searchParams.get('password');

    if (!username || !password) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Erro: Parâmetros obrigatórios: username e password');
      return;
    }

    try {
      const targetIP = await resolveWithDoH(TARGET_HOST);
      const m3uUrl = `http://${targetIP}:${TARGET_PORT}/get.php?username=${username}&password=${password}&type=m3u_plus&output=ts`;
      
      const proxyReq = http.request(m3uUrl, {
        method: 'GET',
        headers: {
          'Host': TARGET_HOST,
          'User-Agent': USER_AGENTS[0],
        },
        timeout: 60000,
      }, (proxyRes) => {
        let m3uContent = '';
        proxyRes.on('data', (chunk) => { m3uContent += chunk.toString(); });
        proxyRes.on('end', () => {
          const myUrl = req.headers.host;
          const protocol = req.headers['x-forwarded-proto'] || 'https';
          const convertedM3U = m3uContent.replace(
            new RegExp(`http://${TARGET_HOST}:${TARGET_PORT}`, 'g'),
            `${protocol}://${myUrl}`
          );
          res.writeHead(200, { 
            'Content-Type': 'application/x-mpegURL',
            'Content-Disposition': `attachment; filename="${username}.m3u"`
          });
          res.end(convertedM3U);
        });
      });

      proxyReq.on('error', (err) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Erro: ${err.message}`);
      });

      proxyReq.end();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Erro ao resolver DNS: ${err.message}`);
    }
    
    return;
  }

  // PROXY DE STREAMS com DoH
  try {
    const targetIP = await resolveWithDoH(TARGET_HOST);
    const userAgent = getUserAgent(req.url);

    const options = {
      hostname: targetIP,  // IP resolvido via DoH
      port: TARGET_PORT,
      path: req.url,
      method: req.method,
      headers: {
        'Host': TARGET_HOST,
        'User-Agent': userAgent,
        'Accept': '*/*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Connection': 'keep-alive',
        'Referer': `http://${TARGET_HOST}/`,
      },
      timeout: 60000,
    };

    if (req.headers['range']) {
      options.headers['Range'] = req.headers['range'];
    }

    const proxyReq = http.request(options, (proxyRes) => {
      const duration = Date.now() - startTime;
      console.log(`  ✓ ${proxyRes.statusCode} | ${duration}ms`);

      const responseHeaders = { ...proxyRes.headers };
      responseHeaders['Access-Control-Allow-Origin'] = '*';
      
      res.writeHead(proxyRes.statusCode, responseHeaders);
      
      let bytesTransferred = 0;
      proxyRes.on('data', (chunk) => {
        bytesTransferred += chunk.length;
        res.write(chunk);
      });

      proxyRes.on('end', () => {
        console.log(`  ✓ ${(bytesTransferred/1024/1024).toFixed(2)} MB transferido`);
        res.end();
      });

      proxyRes.on('error', (err) => {
        console.error(`  ✗ Stream error: ${err.message}`);
        res.end();
      });
    });

    proxyReq.on('error', (err) => {
      console.error(`  ✗ ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`Erro: ${err.message}`);
      }
    });

    proxyReq.on('timeout', () => {
      console.error(`  ✗ Timeout`);
      proxyReq.destroy();
    });

    req.pipe(proxyReq);

  } catch (err) {
    console.error(`  ✗ Erro ao resolver DNS: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Erro ao resolver DNS: ${err.message}`);
  }
});

server.timeout = 300000;
server.keepAliveTimeout = 300000;

server.listen(PORT, '0.0.0.0', () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 Proxy IPTV com DNS-over-HTTPS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📡 Porta: ${PORT}`);
  console.log(`🌐 Target: ${TARGET_HOST}:${TARGET_PORT}`);
  console.log(`🔒 DNS: Cloudflare DoH (1.1.1.1)`);
  console.log(`🎭 User-Agents: ${USER_AGENTS.length}`);
  console.log(`💾 Cache DNS: ${DNS_CACHE_TIME/1000}s`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  // Resolver DNS no startup
  resolveWithDoH(TARGET_HOST).then(ip => {
    console.log(`✓ DNS inicial resolvido: ${TARGET_HOST} → ${ip}\n`);
  }).catch(err => {
    console.error(`✗ Erro ao resolver DNS inicial: ${err.message}\n`);
  });
});
