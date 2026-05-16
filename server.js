// server.js - Com rotação de User-Agents e anti-detecção

const http = require('http');

const PORT = process.env.PORT || 3000;
const TARGET_IP = '38.99.238.132';
const TARGET_PORT = 80;
const TARGET_HOST = 'apsy.homes';

// Pool de User-Agents realistas
const USER_AGENTS = [
  // Android Players
  'ExoPlayerLib/2.18.1 (Linux;Android 11) ExoPlayerDemo/2.18.1',
  'stagefright/1.2 (Linux;Android 9)',
  'Dalvik/2.1.0 (Linux; U; Android 10; SM-G973F Build/QP1A)',
  
  // iOS Players  
  'AppleCoreMedia/1.0.0.19A346 (iPhone; U; CPU OS 15_0 like Mac OS X; pt_br)',
  'AppleCoreMedia/1.0.0.18A373 (iPad; U; CPU OS 14_0 like Mac OS X; pt_br)',
  
  // Smart TV
  'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/79.0.3945.79 Safari/537.36 WebAppManager',
  'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 Chrome/85.0.4183.93 TV Safari/537.36',
  'HbbTV/1.4.1 (+DL;SAMSUNG;SmartTV2020;T-MSKDEUC-2002.3;;)',
  
  // Set-Top Boxes
  'Lavf/58.76.100',
  'VLC/3.0.16 LibVLC/3.0.16',
  'GStreamer souphttpsrc 1.18.4',
  
  // Kodi/XBMC
  'Kodi/19.1 (Windows NT 10.0; Win64; x64) App_Bitness/64 Version/19.1-Matrix',
  'XBMC/16.0 Git:20160207-c327c53 (Windows; U; Windows NT 10.0; en-US)',
];

// Rotacionar User-Agent baseado na URL (consistente por canal)
function getUserAgent(url) {
  // Usar hash da URL para sempre dar mesmo User-Agent para mesmo canal
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash) + url.charCodeAt(i);
    hash = hash & hash;
  }
  const index = Math.abs(hash) % USER_AGENTS.length;
  return USER_AGENTS[index];
}

// Headers adicionais para parecer player legítimo
function getRealisticHeaders(req, userAgent) {
  const headers = {
    'Host': TARGET_HOST,
    'User-Agent': userAgent,
    'Accept': '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Connection': 'keep-alive',
  };

  // Copiar Range (importante para streaming)
  if (req.headers['range']) {
    headers['Range'] = req.headers['range'];
  }

  // Adicionar Referer (parece mais legítimo)
  headers['Referer'] = `http://${TARGET_HOST}/`;

  // Icy-MetaData (alguns servidores IPTV checam isso)
  headers['Icy-MetaData'] = '1';

  return headers;
}

const server = http.createServer((req, res) => {
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
      target: `${TARGET_IP}:${TARGET_PORT}`,
      user_agents: USER_AGENTS.length,
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

  // Endpoint M3U automático
  if (req.url.startsWith('/get-m3u')) {
    const urlParams = new URL(req.url, `http://localhost`);
    const username = urlParams.searchParams.get('username');
    const password = urlParams.searchParams.get('password');

    if (!username || !password) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Erro: Parâmetros obrigatórios: username e password');
      return;
    }

    const m3uUrl = `http://${TARGET_IP}:${TARGET_PORT}/get.php?username=${username}&password=${password}&type=m3u_plus&output=ts`;
    
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
    return;
  }

  // PROXY DE STREAMS com User-Agent rotativo
  const userAgent = getUserAgent(req.url);
  console.log(`  → UA: ${userAgent.substring(0, 50)}...`);

  const options = {
    hostname: TARGET_IP,
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers: getRealisticHeaders(req, userAgent),
    timeout: 60000,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const duration = Date.now() - startTime;
    console.log(`  ✓ ${proxyRes.statusCode} | ${duration}ms`);

    // Se for bloqueio (403/429), tentar com outro User-Agent
    if (proxyRes.statusCode === 403 || proxyRes.statusCode === 429) {
      console.log(`  ⚠️  Bloqueado! Tentando outro User-Agent...`);
      
      // Destruir requisição atual
      proxyReq.destroy();
      
      // Tentar com User-Agent aleatório diferente
      const randomUA = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
      const retryOptions = { ...options };
      retryOptions.headers['User-Agent'] = randomUA;
      
      console.log(`  → Retry UA: ${randomUA.substring(0, 50)}...`);
      
      const retryReq = http.request(retryOptions, (retryRes) => {
        console.log(`  ✓ Retry: ${retryRes.statusCode}`);
        
        const responseHeaders = { ...retryRes.headers };
        responseHeaders['Access-Control-Allow-Origin'] = '*';
        res.writeHead(retryRes.statusCode, responseHeaders);
        retryRes.pipe(res);
      });
      
      retryReq.on('error', (err) => {
        console.error(`  ✗ Retry error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(`Erro após retry: ${err.message}`);
        }
      });
      
      retryReq.end();
      return;
    }

    // Copiar headers
    const responseHeaders = {};
    Object.keys(proxyRes.headers).forEach(key => {
      responseHeaders[key] = proxyRes.headers[key];
    });
    responseHeaders['Access-Control-Allow-Origin'] = '*';
    
    res.writeHead(proxyRes.statusCode, responseHeaders);
    
    // Stream
    let bytesTransferred = 0;
    proxyRes.on('data', (chunk) => {
      bytesTransferred += chunk.length;
      res.write(chunk);
    });

    proxyRes.on('end', () => {
      const totalDuration = Date.now() - startTime;
      console.log(`  ✓ ${(bytesTransferred/1024/1024).toFixed(2)} MB em ${totalDuration}ms`);
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
      res.end(`Erro de conexão: ${err.message}`);
    }
  });

  proxyReq.on('timeout', () => {
    console.error(`  ✗ Timeout`);
    proxyReq.destroy();
  });

  req.pipe(proxyReq);
});

server.timeout = 300000; // 5 minutos
server.keepAliveTimeout = 300000;

server.listen(PORT, '0.0.0.0', () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 Proxy IPTV - Anti-Detecção');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📡 Porta: ${PORT}`);
  console.log(`🎯 Target: ${TARGET_IP} (${TARGET_HOST})`);
  console.log(`🎭 User-Agents: ${USER_AGENTS.length} diferentes`);
  console.log(`🔄 Rotação: Automática por canal`);
  console.log(`🛡️  Anti-Block: Retry automático`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
