# DSpeak SFU <-> Main Server Interop WebSocket API

**WebSocket Path:** `/dspeak/interop`

---

## Message Types

### 1. Media Presence Events
- **Purpose:** Notify main server when a user joins/leaves a media channel or starts/stops producing media.
- **Direction:** SFU → Main
- **Example:**
```json
{
  "type": "media_presence",
  "event": "join" | "leave" | "start_produce" | "stop_produce",
  "userId": "USER_ID",
  "channelId": "CHANNEL_ID",
  "timestamp": "2025-08-12T12:34:56.789Z"
}
```

### 2. Channel Presence Sync
- **Purpose:** Sync the full list of users currently active in a media channel.
- **Direction:** SFU → Main
- **Example:**
```json
{
  "type": "channel_presence_sync",
  "channelId": "CHANNEL_ID",
  "userIds": ["USER_ID1", "USER_ID2"]
}
```

### 3. SFU Status/Error Notification
- **Purpose:** Notify main server of SFU status or errors.
- **Direction:** SFU → Main
- **Example:**
```json
{
  "type": "sfu_status",
  "status": "ok" | "error",
  "details": "Description of the error or status"
}
```

### 4. Force Disconnect (Optional)
- **Purpose:** Main server instructs SFU to disconnect a user from a channel (e.g., banned, kicked).
- **Direction:** Main → SFU
- **Example:**
```json
{
  "type": "force_disconnect",
  "userId": "USER_ID",
  "channelId": "CHANNEL_ID",
  "reason": "banned"
}
```

---

## Summary Table

| Type                  | Direction      | Fields                                      |
|-----------------------|---------------|---------------------------------------------|
| media_presence        | SFU → Main    | event, userId, channelId, timestamp         |
| channel_presence_sync | SFU → Main    | channelId, userIds                          |
| sfu_status            | SFU → Main    | status, details                             |
| force_disconnect      | Main → SFU    | userId, channelId, reason                   |

---

**All messages are JSON objects with a `type` field for routing.**

---

## Error Handling & Flows

- All malformed or invalid messages are ignored or responded to with a clear error message (see below).
- If a message cannot be parsed as JSON, the SFU will log a warning and ignore it.
- If a required field is missing (e.g., `type`), the SFU will respond with `{ "type": "error", "data": "Invalid message format: missing type" }`.
- For unsupported or unknown message types, the SFU will respond with `{ "type": "error", "data": "Unknown message type: ..." }`.
- For all SFU actions (transport, produce, consume, etc.), errors are returned as `{ "type": "error", "data": "..." }` with a clear reason.
- Interop WebSocket network errors are logged and the client will auto-reconnect.

### Example Error Response
```json
{
  "type": "error",
  "data": "Malformed JSON in message"
}
```

---

## Control Event Handling (Main → SFU)

- The SFU listens for control events (e.g., `force_disconnect`) from the main server.
- On receiving a `force_disconnect` event, the SFU will disconnect the specified user from the specified channel and notify them with a reason.
- Malformed or unknown control messages are logged and ignored.

---

## Maintenance Notes

- All flows and error cases should be kept up to date in this document as the protocol evolves.
- For new control/event types, add a new section and example payload.
