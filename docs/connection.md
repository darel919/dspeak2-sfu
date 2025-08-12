# How to Connect a Mediasoup Frontend Client to the SFU Backend

## 1. WebSocket Connection
- Connect to the SFU backend using WebSocket:
  - `ws://<sfu-host>:<port>/socket?auth=USER_ID&channelId=CHANNEL_ID`
- Replace `<sfu-host>`, `<port>`, `USER_ID`, and `CHANNEL_ID` with actual values.

## 2. Mediasoup Signaling Steps

### a. Get RTP Capabilities
- Client sends:
  ```json
  { "type": "get-rtp-capabilities" }
  ```
- Server replies:
  ```json
  { "type": "rtp-capabilities", "data": { ... } }
  ```

### b. Create Transport
- Client sends:
  ```json
  { "type": "create-transport" }
  ```
- Server replies:
  ```json
  { "type": "transport-params", "data": { "id": ..., "iceParameters": ..., "iceCandidates": ..., "dtlsParameters": ... } }
  ```

### c. Connect Transport
- Client sends:
  ```json
  { "type": "connect-transport", "data": { "dtlsParameters": ... } }
  ```
- Server replies:
  ```json
  { "type": "transport-connected" }
  ```

### d. Produce (Send Media)
- Client sends:
  ```json
  { "type": "produce", "data": { "kind": "audio", "rtpParameters": ... } }
  ```
- Server replies:
  ```json
  { "type": "producer-id", "data": { "id": ... } }
  ```

### e. Consume (Receive Media)
- Client sends:
  ```json
  { "type": "consume", "data": { "rtpCapabilities": ... } }
  ```
- Server replies:
  ```json
  { "type": "consumer-params", "data": { "id": ..., "producerId": ..., "kind": ..., "rtpParameters": ... } }
  ```

## 3. Example (JavaScript)

```js
const ws = new WebSocket('ws://<sfu-host>:<port>/socket?auth=USER_ID&channelId=CHANNEL_ID');

ws.onmessage = async (event) => {
  const msg = JSON.parse(event.data);
  // handle messages as described above
};

// 1. Get RTP Capabilities
ws.send(JSON.stringify({ type: 'get-rtp-capabilities' }));

// 2. Create Transport
ws.send(JSON.stringify({ type: 'create-transport' }));

// 3. Connect Transport
ws.send(JSON.stringify({ type: 'connect-transport', data: { dtlsParameters } }));

// 4. Produce
ws.send(JSON.stringify({ type: 'produce', data: { kind: 'audio', rtpParameters } }));

// 5. Consume
ws.send(JSON.stringify({ type: 'consume', data: { rtpCapabilities } }));
```

---

- All messages are JSON and follow the protocol implemented in your backend.
- The client must handle error messages and follow the correct sequence.
- For advanced usage, refer to the mediasoup-client documentation.
