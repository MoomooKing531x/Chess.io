#!/usr/bin/env node
'use strict';
const http = require('http');
const { spawn } = require('child_process');

// Start all game modes as child processes
const MODES = ['battlegrid', 'kings', 'pieces'];
const processes = {};
const ports = { battlegrid: 3000, kings: 3001, pieces: 3002 };

console.log('Starting all Chess.io game modes...');

MODES.forEach(mode => {
  const proc = spawn('node', ['chessio.js', mode, ports[mode].toString()], {
    stdio: 'inherit',
    env: { ...process.env, USE_PATH_ROUTING: '1' }
  });

  proc.on('error', (err) => {
    console.error(`Failed to start ${mode}:`, err);
  });

  proc.on('exit', (code) => {
    console.log(`${mode} exited with code ${code}`);
  });

  processes[mode] = proc;
  console.log(`Started ${mode} on port ${ports[mode]}`);
});

// Wait a moment for servers to start
setTimeout(() => {
  const PORT = process.env.PORT || 3000;
  console.log(`Proxy server starting on port ${PORT}...`);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    // Redirect root to /battlegrid
    if (pathname === '/') {
      res.writeHead(302, { Location: '/battlegrid' });
      res.end();
      return;
    }

    // Route to appropriate game based on path
    let targetPort = ports.battlegrid;
    let targetPath = '/';

    if (pathname.startsWith('/battlegrid')) {
      targetPort = ports.battlegrid;
      targetPath = pathname.substring(11) || '/';
    } else if (pathname.startsWith('/kings')) {
      targetPort = ports.kings;
      targetPath = pathname.substring(6) || '/';
    } else if (pathname.startsWith('/pieces')) {
      targetPort = ports.pieces;
      targetPath = pathname.substring(7) || '/';
    }

    // Proxy request to target server
    const options = {
      hostname: 'localhost',
      port: targetPort,
      path: targetPath + url.search,
      method: req.method,
      headers: { ...req.headers, host: `localhost:${targetPort}` }
    };

    const proxyReq = http.request(options, (proxyRes) => {
      // Update URLs in HTML for proper routing
      if (proxyRes.headers['content-type'] && proxyRes.headers['content-type'].includes('text/html')) {
        let data = '';
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
          // Update NAV URLs to use path-based routing
          const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
          data = data.replace(/'http:\/\/localhost:3000'/g, `'${baseUrl}/battlegrid'`);
          data = data.replace(/'http:\/\/localhost:3001'/g, `'${baseUrl}/kings'`);
          data = data.replace(/'http:\/\/localhost:3002'/g, `'${baseUrl}/pieces'`);
          data = data.replace(/https:\/\/moomoochess-battlegrid\.onrender\.com/g, `${baseUrl}/battlegrid`);
          data = data.replace(/https:\/\/moomoochess-kings\.onrender\.com/g, `${baseUrl}/kings`);
          data = data.replace(/https:\/\/moomoochess-pieces\.onrender\.com/g, `${baseUrl}/pieces`);

          // Update WebSocket URL to use the current host with the correct path
          const wsBase = baseUrl.replace(/^https?:/, process.env.RENDER_EXTERNAL_URL ? 'wss:' : 'ws:');
          if (targetPort === ports.battlegrid) {
            data = data.replace(/window\.__WS_URL__ = "[^"]*"/g, `window.__WS_URL__ = "${wsBase}/battlegrid"`);
          } else if (targetPort === ports.kings) {
            data = data.replace(/window\.__WS_URL__ = "[^"]*"/g, `window.__WS_URL__ = "${wsBase}/kings"`);
          } else if (targetPort === ports.pieces) {
            data = data.replace(/window\.__WS_URL__ = "[^"]*"/g, `window.__WS_URL__ = "${wsBase}/pieces"`);
          }

          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          res.end(data);
        });
      } else {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
    });

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err);
      res.writeHead(502);
      res.end('Bad Gateway');
    });

    req.pipe(proxyReq);
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    let targetPort = ports.battlegrid;
    let targetPath = '/ws';

    if (pathname.startsWith('/battlegrid')) {
      targetPort = ports.battlegrid;
      targetPath = pathname.substring(11) || '/ws';
    } else if (pathname.startsWith('/kings')) {
      targetPort = ports.kings;
      targetPath = pathname.substring(6) || '/ws';
    } else if (pathname.startsWith('/pieces')) {
      targetPort = ports.pieces;
      targetPath = pathname.substring(7) || '/ws';
    } else {
      // Default to battlegrid
      targetPort = ports.battlegrid;
      targetPath = '/ws';
    }

    const proxyReq = http.request({
      hostname: 'localhost',
      port: targetPort,
      path: targetPath,
      method: req.method,
      headers: req.headers
    });

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write('HTTP/1.1 101 Web Socket Protocol Handshake\r\n' +
        'Upgrade: WebSocket\r\n' +
        'Connection: Upgrade\r\n' +
        '\r\n');
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });

    proxyReq.on('error', (err) => {
      console.error('WebSocket proxy error:', err);
      socket.destroy();
    });

    proxyReq.end();
  });

  server.listen(PORT, () => {
    console.log(`Proxy server listening on port ${PORT}`);
    console.log(`Battle Grid: http://localhost:${PORT}/battlegrid`);
    console.log(`Battle of the Kings: http://localhost:${PORT}/kings`);
    console.log(`Pieces with Pieces: http://localhost:${PORT}/pieces`);
  });

  // Handle shutdown
  process.on('SIGTERM', () => {
    console.log('Shutting down all game modes...');
    server.close();
    Object.values(processes).forEach(proc => proc.kill('SIGTERM'));
  });

  process.on('SIGINT', () => {
    console.log('Shutting down all game modes...');
    server.close();
    Object.values(processes).forEach(proc => proc.kill('SIGTERM'));
  });
}, 2000);
