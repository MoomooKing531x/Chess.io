#!/usr/bin/env node
'use strict';
const { spawn } = require('child_process');

const MODES = ['battlegrid', 'kings', 'pieces'];
const processes = [];

console.log('Starting all Chess.io game modes...');

MODES.forEach(mode => {
  const proc = spawn('node', ['chessio.js', mode], {
    stdio: 'inherit',
    env: { ...process.env }
  });

  proc.on('error', (err) => {
    console.error(`Failed to start ${mode}:`, err);
  });

  proc.on('exit', (code) => {
    console.log(`${mode} exited with code ${code}`);
  });

  processes.push(proc);
  console.log(`Started ${mode} on port ${mode === 'battlegrid' ? 3000 : mode === 'kings' ? 3001 : 3002}`);
});

// Handle shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down all game modes...');
  processes.forEach(proc => proc.kill('SIGTERM'));
});

process.on('SIGINT', () => {
  console.log('Shutting down all game modes...');
  processes.forEach(proc => proc.kill('SIGTERM'));
});
