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
- `create-transport`: Creates a MediaSoup WebRTC transport for the client using a shared WebRtcServer bound to fixed ports.
  - The server advertises public IP/port via WebRtcServer `listenInfos` using environment variables:
    - IPv4: `SFU_IPV4` and `SFU_IPV4_PORT` (or `PLAYIT_PUBLIC_PORT`)
    - IPv6: `SFU_IPV6` and optional `SFU_IPV6_PORT`
    - Optional preference: `SFU_PREFERRED_FAMILY=ipv4|ipv6`
  - Sends transport parameters (`id`, `iceParameters`, `iceCandidates`, `dtlsParameters`, optional `sctpParameters`) to the client.
- `connect-transport`: Client sends DTLS parameters to connect the transport.
- `produce`: Client sends media parameters to create a producer (audio stream).
- `consume`: Client requests to consume another client's producer stream. Server responds with consumer parameters (`id`, `producerId`, `kind`, `rtpParameters`).

### 4. Resource Cleanup
- On client disconnect, associated transport, producer, and consumer are closed and removed.

### 4. Environment & SFU networking
- The server uses mediasoup WebRtcServer with explicit `listenInfos` so ICE candidates contain the exact public IP and port you configure.
- Key variables (see `.env.example`):
  - `SFU_PORT`: internal bind port for UDP/TCP (may be auto if omitted)
  - `SFU_IPV4`: public IPv4 to announce (e.g., from playit.gg)
  - `SFU_IPV4_PORT`: public port to announce for IPv4 (fallback to `PLAYIT_PUBLIC_PORT`)
  - `SFU_IPV6`: public IPv6 to announce (your host’s global IPv6)
  - `SFU_IPV6_PORT`: public port to announce for IPv6 (defaults to `SFU_PORT` when set)
  - `SFU_PREFERRED_FAMILY`: set to `ipv4` to force IPv4-only candidates, or `ipv6` to force IPv6-only
  - `PLAYIT_PUBLIC_PORT`: convenient fallback for IPv4 port when using playit.gg
- HTTP and signaling remain on the Express port (`PORT`, default 8425). The mediasoup RTP/ICE ports are controlled via the variables above.

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
