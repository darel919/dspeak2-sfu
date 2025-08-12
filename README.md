# dspeak Backend Handler
This is a repository for [dspeak,](https://github.com/darel919/dspeak2 "dspeak") peer-to-peer application backend. This backend will handle SFUs.


This backend now supports robust SFU <-> main server interop via a dedicated WebSocket channel (`/dspeak/interop`).

## SFU <-> Main Server Interop

- Real-time events (media presence, channel sync, control) are exchanged between the SFU and main server using a persistent WebSocket connection.
- All interop messages are JSON objects with a `type` field for routing.

### Message Types

- `media_presence`: User joins/leaves a media channel or starts/stops producing media.
  - Example:
    ```json
    {
      "type": "media_presence",
      "event": "join" | "leave" | "start_produce" | "stop_produce",
      "userId": "USER_ID",
      "channelId": "CHANNEL_ID",
      "timestamp": "2025-08-12T12:34:56.789Z"
    }
    ```
- `channel_presence_sync`: Sync the full list of users currently active in a media channel.
- `sfu_status`: Notify main server of SFU status or errors.
- `force_disconnect`: Main server instructs SFU to disconnect a user from a channel (e.g., banned, kicked).

### Error Handling

- All malformed or invalid messages are ignored or responded to with a clear error message.
- If a message cannot be parsed as JSON, the SFU logs a warning and ignores it.
- If a required field is missing (e.g., `type`), the SFU responds with `{ "type": "error", "data": "Invalid message format: missing type" }`.
- For unsupported or unknown message types, the SFU responds with `{ "type": "error", "data": "Unknown message type: ..." }`.
- For all SFU actions (transport, produce, consume, etc.), errors are returned as `{ "type": "error", "data": "..." }` with a clear reason.
- Interop WebSocket network errors are logged and the client will auto-reconnect.

### Control Event Handling

- The SFU listens for control events (e.g., `force_disconnect`) from the main server.
- On receiving a `force_disconnect` event, the SFU disconnects the specified user from the specified channel and notifies them with a reason.


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
