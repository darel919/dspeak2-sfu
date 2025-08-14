# Network Architecture: Dual-Stack IPv4/IPv6 Support

## Overview

This document explains how the dspeak-be mediasoup SFU handles dual-stack IPv4/IPv6 connectivity to resolve connection issues for IPv4-only clients.

## Problem Statement

The original implementation used a single WebRTC server that announced both IPv4 and IPv6 ICE candidates to all clients. This caused issues because:

1. **ICE Priority**: WebRTC's ICE algorithm prioritizes IPv6 candidates over IPv4 by default (RFC 8445)
2. **IPv4-only clients**: Cannot connect to IPv6 addresses, causing connection failures when they try IPv6 candidates first
3. **Fallback issues**: The fallback to IPv4 candidates might not work properly or take too long

## Solution Architecture

### Separate WebRTC Servers

The solution creates **two separate WebRTC servers**:

1. **IPv4 Server** (`webRtcServerIpv4`):
   - Binds to `0.0.0.0` (all IPv4 interfaces)
   - Port: `SFU_PORT` (e.g., 12825)
   - Announces: `SFU_IPV4` public address
   - Serves: IPv4-only clients

2. **IPv6 Server** (`webRtcServerIpv6`):
   - Binds to `::` (all IPv6 interfaces) 
   - Port: `SFU_PORT + 1` (e.g., 12826)
   - Announces: `SFU_IPV6` public address
   - Serves: IPv6-capable clients
   - Uses `ipv6Only: true` flag to prevent dual-stack conflicts

### Client IP Detection

The system detects client IP family in `getClientIpFamily()`:

```javascript
function getClientIpFamily(req) {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                     req.headers['x-real-ip'] ||
                     req.connection?.remoteAddress ||
                     // ... other fallbacks
    
    // Remove IPv4-mapped IPv6 prefix
    const cleanIp = clientIp.replace(/^::ffff:/, '');
    
    // Check if it's pure IPv6
    if (clientIp.includes(':') && !cleanIp.includes('.')) {
        return 'ipv6';
    }
    
    return 'ipv4';
}
```

### Transport Selection Logic

When a client requests `create-transport`, the server:

1. **Detects client IP family** from the WebSocket request
2. **Selects appropriate WebRTC server**:
   - IPv6 clients → `webRtcServerIpv6`
   - IPv4 clients → `webRtcServerIpv4`
   - Fallback to available server if preferred not available
3. **Creates transport** using the selected server
4. **Returns ICE candidates** that match the client's IP family only

## Network Configuration

### Environment Variables

```yaml
# IPv4 configuration (playit.gg tunnel)
SFU_IPV4: "147.185.221.30"        # Public IPv4 address (playit.gg tunnel IP)
SFU_PORT: 12825                   # Local listening port (playit.gg target port)
SFU_IPV4_PORT: 29918              # External announced port (playit.gg source port)

# IPv6 configuration (direct)
SFU_IPV6: "2001:448a:1041:c158:34cf:9616:e764:a37e"  # Public IPv6 address
# IPv6 uses SFU_PORT + 1 automatically (12826)
```

### Port Allocation

| Protocol | Local Listen Port | Announced Port | Purpose | Traffic Flow |
|----------|-------------------|----------------|---------|--------------|
| IPv4 UDP | 12825 (SFU_PORT)  | 29918 (SFU_IPV4_PORT) | RTP media | Client → 147.185.221.30:29918 → playit.gg tunnel → localhost:12825 |
| IPv4 TCP | 12825 (SFU_PORT)  | 29918 (SFU_IPV4_PORT) | RTP media | Client → 147.185.221.30:29918 → playit.gg tunnel → localhost:12825 |
| IPv6 UDP | 12826 (SFU_PORT+1) | 12826          | RTP media | Client → [SFU_IPV6]:12826 (direct) |
| IPv6 TCP | 12826 (SFU_PORT+1) | 12826          | RTP media | Client → [SFU_IPV6]:12826 (direct) |

### NAT Traversal

- **IPv4 (playit.gg tunnel)**: 
  - Listen locally on `SFU_PORT` (12825)
  - Announce external address `SFU_IPV4:SFU_IPV4_PORT` (147.185.221.30:29918)
  - Playit.gg forwards traffic from source port 29918 to target port 12825
- **IPv6 (direct)**: 
  - Listen on `SFU_PORT + 1` (12826)
  - Announce same address `SFU_IPV6:12826` for direct public routing

## Benefits

1. **Eliminates connectivity issues**: IPv4 clients only see IPv4 candidates
2. **Optimal performance**: IPv6 clients get IPv6-only candidates
3. **Proper fallback**: System gracefully handles server initialization failures
4. **Maintains compatibility**: Preserves existing client API
5. **Debugging clarity**: Clear logging shows which server/family is used

## Fallback Strategy

If both IPv4 and IPv6 servers fail to initialize:

1. **Legacy mode**: Falls back to dual-stack configuration
2. **Warning logged**: Alerts about suboptimal configuration
3. **Single server**: Uses IPv4 server as fallback for all clients

## Client Behavior

### IPv4 Clients
- Connect via WebSocket (IP family detected)
- Receive transport with IPv4-only ICE candidates
- Directly connect without IPv6 interference

### IPv6 Clients  
- Connect via WebSocket (IP family detected)
- Receive transport with IPv6-only ICE candidates
- Optimal performance with native IPv6 connectivity

## Monitoring and Debugging

The implementation includes extensive logging:

```javascript
console.log(`[ws] Client ${userId} connecting with IP family: ${clientIpFamily}`);
console.log(`[ws] Using ${clientIpFamily === 'ipv6' ? 'IPv6' : 'IPv4'} WebRTC server`);
console.log(`[ws] ICE candidates: ${transport.iceCandidates.length} candidates`);
```

This helps diagnose connectivity issues and verify proper server selection.

## Security Considerations

- **IP detection**: Uses standard HTTP headers with fallbacks
- **No IP spoofing**: Server-side detection prevents client manipulation
- **Address validation**: Only announces configured public addresses
- **Port separation**: Prevents port conflicts between IPv4/IPv6 servers

## Migration Notes

This change is **backward compatible**:
- Existing clients continue to work unchanged
- API remains identical
- Only internal transport selection logic changes
- Environment variables are additive (no breaking changes)
