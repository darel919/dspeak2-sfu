import './env.js';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import dspeakRoutes from './routes/dspeak/index.js';
import { dspeakWebSocketHandler } from './routes/dspeak/socket.js';

const app = express();
const port = process.env.PORT || 8425;

app.use('/', dspeakRoutes);

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/socket' });
wss.on('connection', dspeakWebSocketHandler);

server.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
  console.log(`WebSocket server listening on ws://localhost:${port}/socket`);
  // console.log(process.env.INTEROP_API_BASE_URL);
});
