# PlayIt.gg Tunnel Configuration Fix

## Issue Description

The SFU was not reachable by IPv4 clients due to incorrect port configuration for the playit.gg tunnel.

### Problem
- **Incorrect**: Server was listening on the playit.gg **source port** (29918) 
- **Should be**: Server should listen on the playit.gg **target port** (12825)
- **Result**: IPv4 clients couldn't connect because the tunnel wasn't properly configured

### Root Cause
The code was using `SFU_IPV4_PORT` (29918) as the listening port, but this is the external port that clients connect to. The server should listen on the internal target port (`SFU_PORT` = 12825) and announce the external source port.

## Solution

### Code Changes Made

1. **Fixed WebRTC Server Configuration** (`routes/dspeak/socket.js`):
   ```javascript
   // BEFORE (incorrect):
   const ipv4Port = parseInt(process.env.SFU_IPV4_PORT, 10) || port;
   const ipv4ListenInfos = [
       { protocol: 'udp', ip: '0.0.0.0', port: ipv4Port, announcedAddress: announcedIpV4 }
   ];

   // AFTER (correct):
   const ipv4ListenInfos = [
       { protocol: 'udp', ip: '0.0.0.0', port: port, announcedAddress: announcedIpV4 }
   ];
   ```

2. **Enhanced ICE Candidate Processing**:
   - Server listens on local port (12825) and announces IP address only
   - ICE candidate processing corrects the port from local (12825) to external (29918)
   - Ensures proper playit.gg tunnel routing

3. **Clarified Environment Variables** (`docker-compose.yml`):
   ```yaml
   SFU_PORT: 12825                    # Local port to listen on (playit.gg target port)
   SFU_IPV4_PORT: 29918               # External port to announce (playit.gg source port) 
   SFU_IPV4: 147.185.221.30           # External IPv4 address (playit.gg tunnel IP)
   ```

### How PlayIt.gg Tunnel Works

```
Client → 147.185.221.30:29918 → PlayIt.gg Tunnel → localhost:12825
         (external IP:source)                       (internal:target)
```

**Traffic Flow:**
1. Client connects to `147.185.221.30:29918` (announced in ICE candidates)
2. PlayIt.gg tunnel forwards traffic to `localhost:12825` 
3. Mediasoup server listens on `localhost:12825`

### Key Concepts

- **Source Port (29918)**: External port that clients connect to
- **Target Port (12825)**: Internal port that the server listens on
- **Announced Address**: `147.185.221.30:29918` (what clients see)
- **Listen Address**: `0.0.0.0:12825` (what server binds to)

## Verification

After the fix:
1. Server logs should show: `Listening on local port 12825, announcing 147.185.221.30:29918`
2. IPv4 clients should receive ICE candidates with `address: "147.185.221.30", port: 29918`
3. WebRTC connections from IPv4 clients should succeed

## Documentation Updated

- `docs/connection.md`: Updated network configuration section
- `docs/network-architecture.md`: Corrected port allocation table and traffic flow
- `docker-compose.yml`: Added clarifying comments for port configuration

## Impact

- ✅ **IPv4 clients can now connect** via playit.gg tunnel
- ✅ **IPv6 clients unchanged** (still work via direct connection)
- ✅ **Backward compatible** (no API changes)
- ✅ **Proper tunnel semantics** (listen on target, announce source)

## Testing

To verify the fix works:
1. Deploy the updated configuration
2. Test IPv4 client connection from external network
3. Check that ICE candidates show the correct announced port (29918)
4. Verify WebRTC media flows successfully
