# How to connect a mediasoup frontend client to the SFU backend

This backend exposes a WebSocket signaling endpoint for mediasoup. Audio-only (Opus) is supported.

## 0) Endpoint and auth
- Endpoint: `ws://HOST:PORT/socket`
- Required query params: `auth` and `channelId`
  - Example (local): `ws://localhost:8425/socket?auth=USER_ID&channelId=CHANNEL_ID`
- PORT is configurable via `PORT` env var (defaults to 8425 in `app.js`).
- If `auth` or `channelId` is missing, the server sends an error and closes the connection.

## 1) Initial server messages (after a successful connection)
Immediately after validation, the server may send:
- `connected`: `{ type: "connected", data: { channelId, userId, message } }`
- `currentlyInChannel` broadcast to you and others in the same channel:
  - `{ type: "currentlyInChannel", inRoom: string[], producers: string[] }`

The server will also broadcast `currentlyInChannel` when users join/leave.

## 2) Utility
- Keepalive: `{ type: "ping" }` -> `{ type: "pong", timestamp }`

## 3) Mediasoup signaling flow

### a) Get RTP capabilities
- Send: `{ type: "get-rtp-capabilities" }`
- Receive: `{ type: "rtp-capabilities", data: RtpCapabilities }`

Note: Router is configured for Opus only:
```
audio/opus @ 48000 Hz, 2 channels
```

### b) Create transport
- Send: `{ type: "create-transport" }`
- Receive:
  ```json
  {
    "type": "transport-params",
    "data": {
      "id": "...",
      "iceParameters": { ... },
      "iceCandidates": [ ... ],
      "dtlsParameters": { ... },
      "sctpParameters": { ... } // present when available
    }
  }
  ```

### c) Connect transport
- Send (DTLS): `{ type: "connect-transport", data: { dtlsParameters, transportId? } }`
  - If `transportId` provided, connects that transport and replies with its id.
  - If omitted, the server attempts to connect any pending transports and replies without an id.
- Receive: `{ type: "transport-connected" }` or `{ type: "transport-connected", data: { id } }`

### d) Produce (send media)
- Send: `{ type: "produce", data: { kind: "audio", rtpParameters, transportId? } }`
  - If `transportId` omitted, the server uses the first created transport.
- Receive: `{ type: "producer-id", data: { id } }`
- Server also broadcasts to the channel: `{ type: "new-producer", data: { producerId } }`

### e) Consume (receive media)
- Send: `{ type: "consume", data: { rtpCapabilities, transportId? } }`
  - If `transportId` omitted, the server uses the most recently created transport for that client.
  - Server will consume a producer from another user in the same channel; if none exist, you’ll receive an error.
- Receive:
  ```json
  {
    "type": "consumer-params",
    "data": {
      "id": "...",
      "producerId": "...",
      "kind": "audio",
      "rtpParameters": { ... }
    }
  }
  ```

## 4) Unsolicited events you should handle
- `currentlyInChannel`: room presence and current producer ids, sent on joins/leaves and on your own connect.
- `new-producer`: when someone starts producing in your channel.
- `force_disconnect`: server instructs client to disconnect (e.g., moderation); payload:
  - `{ type: "force_disconnect", reason?: string }`

## 5) Error handling (non-exhaustive)
All errors are JSON messages of the form `{ type: "error", data: string, details?: string, status?: number }`.
Potential values include:
- `Missing auth or channelId in query params` (connection is closed)
- `Backend validation error` / `Channel validation failed` / `Channel is not a media channel`
- `Router not ready` or `Router or WebRtcServer not ready`
- `Malformed JSON in message` / `Invalid message format: missing type`
- `Transport not found` / `Failed to connect transport`
- `Failed to create producer` / `No producer available` / `Cannot consume`

## 6) Minimal client outline (JavaScript)
```js
const ws = new WebSocket('ws://localhost:8425/socket?auth=USER_ID&channelId=CHANNEL_ID');

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  // handle: connected, currentlyInChannel, rtp-capabilities, transport-params,
  // transport-connected, producer-id, consumer-params, new-producer, pong, force_disconnect, error
};

// 1. Get RTP capabilities
ws.send(JSON.stringify({ type: 'get-rtp-capabilities' }));

// 2. Create transport
ws.send(JSON.stringify({ type: 'create-transport' }));

// 3. Connect transport
ws.send(JSON.stringify({ type: 'connect-transport', data: { dtlsParameters } }));

// 4. Produce
ws.send(JSON.stringify({ type: 'produce', data: { kind: 'audio', rtpParameters } }));

// 5. Consume
ws.send(JSON.stringify({ type: 'consume', data: { rtpCapabilities } }));
```

Notes
- All messages are JSON.
- The server may push presence/producer/control events at any time; handle them idempotently.
- Only audio (Opus) is supported by the current router configuration.
