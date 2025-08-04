# dspeak Backend - MediaSoup WebSocket Handler

This document explains the implementation and usage of the MediaSoup-powered WebSocket handler in `dspeak/socket.ts`.

## Overview
The handler enables real-time audio communication using MediaSoup. It manages WebSocket connections, MediaSoup worker/router initialization, and WebRTC transport creation for clients.

## Steps

### 1. MediaSoup Initialization
- A MediaSoup worker and router are created on server startup.
- The router is configured with Opus audio codec.
- Initialization is performed asynchronously via `initMediasoup()`.

### 2. WebSocket Connection Handling
- On client connection (`open`), the client is added to a set and receives a test message.
- On disconnection (`close`), the client is removed from the set.

### 3. Message Handling
- `ping`: Replies with a `pong` and timestamp.
- `broadcast`: Forwards a message to all other clients.
- `create-transport`: Creates a MediaSoup WebRTC transport for the client.
  - Uses `listenIps` with dynamic `announcedIp`:
    - Production: `api.darelisme.my.id`
    - Development: `localhost`
  - Sends transport parameters (`id`, `iceParameters`, `iceCandidates`, `dtlsParameters`) to the client.
- `connect-transport`: Client sends DTLS parameters to connect the transport.
- `produce`: Client sends media parameters to create a producer (audio stream).
- `consume`: Client requests to consume another client's producer stream. Server responds with consumer parameters (`id`, `producerId`, `kind`, `rtpParameters`).

### 4. Resource Cleanup
- On client disconnect, associated transport, producer, and consumer are closed and removed.

### 4. Environment Awareness
- The code checks `process.env.NODE_ENV` to determine the environment and set the correct public IP/domain for WebRTC signaling.

## Example Usage
- Connect to the WebSocket endpoint.
- Send `{ type: "create-transport" }` to receive transport parameters for WebRTC setup.
- Send `{ type: "connect-transport", data: { dtlsParameters } }` to connect the transport.
- Send `{ type: "produce", data: { kind, rtpParameters } }` to start sending audio.
- Send `{ type: "consume", data: { rtpCapabilities } }` to receive another client's audio stream.

## Next Steps
- Add authentication and room/session management as needed.

---

This documentation will be updated as new features and steps are added to the implementation.
