import './env.js';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import dspeakRoutes from './routes/dspeak/index.js';
import { dspeakWebSocketHandler } from './routes/dspeak/socket.js';
import { renderPrometheus } from './lib/metrics.js';

const app = express();
const port = process.env.PORT || 8425;

app.use('/', dspeakRoutes);

app.get('/metrics', (req, res) => {
  try {
    const body = renderPrometheus();
    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(body);
  } catch (e) {
    res.status(500).send('metrics error');
  }
});

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/socket' });
wss.on('connection', dspeakWebSocketHandler);

server.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
  console.log(`WebSocket server listening on ws://localhost:${port}/socket`);
  // console.log(process.env.INTEROP_API_BASE_URL);
});
