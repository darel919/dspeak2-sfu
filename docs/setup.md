# Mediasoup SFU Production Setup with NAT, IPv6, and playit.gg

This guide explains how to deploy a mediasoup-based SFU behind NAT, using Cloudflared for HTTP, public IPv6 for direct UDP, and playit.gg for IPv4 UDP relay with a fixed port.

## Checklist
- Use IPv6 directly via DNS (AAAA) with no Cloudflare proxy.
- For IPv4, bind mediasoup to a single fixed UDP port and forward that via playit.gg.
- Set `announcedIp` per family: server’s public IPv6 for v6, playit’s public IPv4 for v4.
- Create transports using a WebRtcServer so all traffic uses those fixed ports.
- Optionally enable TCP fallback on a fixed port.

## What to set for `announcedIp` in production
- **IPv6 path:** `announcedIp` = your server’s real public IPv6 address.
- **IPv4 path (through playit):** `announcedIp` = the public IPv4 that playit.gg gives you for the tunnel.
- Do not use localhost, LAN IPs, container IPs, or Cloudflare proxied hostnames. Use literal public IPs that browsers can reach.
- If only reachable via IPv6, you can omit v4 entirely (but IPv4-only clients won’t work unless you add a relay/TURN).

## How to support playit’s single fixed port
- Do not use the default “random port per WebRtcTransport” mode; playit can’t map a range.
- Use mediasoup’s WebRtcServer and bind explicit, fixed `listenInfos`:
  - UDP IPv6: `ip: '::', port: P, announcedIp: <your IPv6>`
  - UDP IPv4: `ip: '0.0.0.0', port: P, announcedIp: <playit IPv4>`
  - Optional TCP fallback on fixed port(s) (both v4/v6)
- Create WebRtcTransport with the `webRtcServer` option (not `listenIps`), and set `enableUdp: true, enableTcp: true, preferUdp: true`.
- The port you configure in WebRtcServer is the port that will be advertised in ICE candidates—set it to the same external port you registered at playit.gg.

## DNS/Cloudflare setup
- Create an AAAA record for your SFU subdomain pointing to your server’s public IPv6. Set it to DNS only (no proxy), since Cloudflare proxy breaks UDP.
- If playit provides a stable public IPv4, you can optionally publish an A record to that IPv4 (also DNS only). Not strictly required for ICE if your candidates already include the announcedIp, but it can help diagnostics.
- Keep HTTP traffic on the Cloudflared subdomain; use a separate subdomain for the SFU that bypasses the proxy entirely.

## If playit can’t give you a stable IPv4
- Use a proper TURN server with both IPv4 and IPv6 that can reach your SFU over IPv6. Configure clients with TURN over TCP/TLS 443. This lets IPv4-only clients reach your IPv6-only SFU via TURN. Ensure the TURN host has IPv6 connectivity to your SFU and open the SFU’s fixed port(s) on IPv6.

## Edge notes
- **Firewalls:** open the chosen UDP/TCP ports on the host and upstream firewall for IPv6. For IPv4, playit handles WAN exposure, but your local firewall must allow the mapped internal port.
- **Cloudflare proxy must be OFF** for any A/AAAA used by the SFU.
- If your mediasoup version doesn’t support WebRtcServer, upgrade; a single fixed port is not feasible with the legacy per-transport port allocation.

## Mapping back to your code
- In `routes/dspeak/socket.js`, switch transport creation to use a shared WebRtcServer bound to the fixed ports and set `announcedIp` per listenInfo (one for IPv6, one for IPv4 via playit). Remove/ignore per-transport listenIps.

## Quick success criteria
- IPv6 clients connect directly to your server’s IPv6 on port P.
- IPv4 clients connect via playit to the same port P.
- ICE candidates show your IPv6 and playit’s IPv4 with the exact fixed port you configured.
