import '../../env.js';
import mediasoup from 'mediasoup'
import WebSocket from 'ws';

// --- ICE Server Config Loader ---
let iceServers = [];
async function loadIceServers() {
    try {
        const apiBase = process.env.INTEROP_API_BASE_URL;
        if (!apiBase) return;
        const res = await fetch(`${apiBase}/dspeak/config`);
        if (res.ok) {
            iceServers = await res.json();
            console.info('[mediasoup] Loaded ICE server config:', iceServers);
        } else {
            console.warn('[mediasoup] Failed to fetch ICE server config:', res.status);
        }
    } catch (err) {
        console.warn('[mediasoup] Error loading ICE server config:', err && err.message ? err.message : err);
    }
}

// --- Interop WebSocket Client ---
let interopWs;
function resolveInteropWsUrl() {
    const wsBase = process.env.INTEROP_WS_API_BASE_URL
        || (process.env.INTEROP_API_BASE_URL ? process.env.INTEROP_API_BASE_URL.replace(/^http(s?):/i, 'ws$1:') : null);
    return wsBase ? `${wsBase}/dspeak/interop` : null;
}
function connectInteropWs() {
    const interopUrl = resolveInteropWsUrl();
    if (!interopUrl) return;
    interopWs = new WebSocket(interopUrl);
    interopWs.on('open', () => {
        // Optionally log or send initial handshake
    });
    interopWs.on('close', () => {
        setTimeout(connectInteropWs, 2000); // Reconnect on close
    });
    interopWs.on('error', (err) => {
        // Log interop errors for diagnostics
        console.error('[SFU] Interop WebSocket error:', err && err.message ? err.message : err);
    });
    interopWs.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'force_disconnect' && data.userId && data.channelId) {
                // Find the ws for this user/channel
                for (const client of clients) {
                    if (client.userId === data.userId && client.channelId === data.channelId) {
                        client.send(JSON.stringify({
                            type: 'force_disconnect',
                            reason: data.reason || 'disconnected by server'
                        }));
                        client.close();
                    }
                }
            }
            // Add more control event handlers here as needed
        } catch (e) {
            console.warn('[SFU] Malformed interop/control message:', msg);
        }
    });
}
connectInteropWs();

function sendInteropEvent(event) {
    if (interopWs && interopWs.readyState === WebSocket.OPEN) {
        interopWs.send(JSON.stringify(event));
    }
}


// Per-channel presence and media maps
const clients = new Set();
const channelPresence = new Map(); // channelId -> Set of userIds
const channelTransports = new Map(); // channelId -> Map<ws, Map<transportId, transport>>
const channelProducers = new Map(); // channelId -> Map<ws, producer>
const channelConsumers = new Map(); // channelId -> Map<ws, consumer>

const isProd = process.env.NODE_ENV === 'production';
let worker;
let router;
let webRtcServerIpv4;
let webRtcServerIpv6;
const mediaCodecs = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
    }
];


// Helper function to detect client IP family from WebSocket request
function getClientIpFamily(req) {
    // Get the real client IP, accounting for proxies
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                     req.headers['x-real-ip'] ||
                     req.connection?.remoteAddress ||
                     req.socket?.remoteAddress ||
                     (req.connection?.socket ? req.connection.socket.remoteAddress : null);
    
    if (!clientIp) return 'ipv4'; // Default fallback
    
    // Remove IPv4-mapped IPv6 prefix if present
    const cleanIp = clientIp.replace(/^::ffff:/, '');
    
    // Check if it's an IPv6 address
    if (clientIp.includes(':') && !cleanIp.includes('.')) {
        return 'ipv6';
    }
    
    return 'ipv4';
}

async function initMediasoup() {
    try {
        await loadIceServers();
        worker = await mediasoup.createWorker();
        router = await worker.createRouter({ mediaCodecs });
        
        // --- Separate WebRtcServer setup for IPv4 and IPv6 ---
        const port = parseInt(process.env.SFU_PORT, 10) || undefined;
        const ipv4SourcePort = parseInt(process.env.SFU_IPV4_PORT, 10);
        const announcedIpV4 = (process.env.SFU_IPV4 || '').trim();
        const announcedIpV6 = (process.env.SFU_IPV6 || '').trim();

        // Create IPv4-only WebRTC server
        if (announcedIpV4) {
            try {
                // For playit.gg tunnel: listen on target port (SFU_PORT), announce source IP only
                // Port correction will be handled in ICE candidate processing
                const ipv4ListenInfos = [
                    { protocol: 'udp', ip: '0.0.0.0', port: port, announcedAddress: announcedIpV4 },
                    { protocol: 'tcp', ip: '0.0.0.0', port: port, announcedAddress: announcedIpV4 }
                ];
                webRtcServerIpv4 = await worker.createWebRtcServer({ listenInfos: ipv4ListenInfos });
                console.log('[mediasoup] IPv4 WebRtcServer initialized:', ipv4ListenInfos);
                console.log(`[mediasoup] Listening on local port ${port}, announcing IP ${announcedIpV4}`);
                console.log(`[mediasoup] Port correction (${port} -> ${ipv4SourcePort}) will be applied to ICE candidates`);
            } catch (err) {
                console.error('[mediasoup] IPv4 WebRtcServer setup failed:', err?.message || err);
            }
        }

        // Create IPv6-only WebRTC server  
        if (announcedIpV6) {
            try {
                const ipv6ListenInfos = [
                    { 
                        protocol: 'udp', 
                        ip: '::',
                        port: port ? port + 1 : undefined, // Use different port for IPv6 to avoid conflicts
                        announcedAddress: announcedIpV6,
                        flags: { ipv6Only: true }
                    },
                    { 
                        protocol: 'tcp', 
                        ip: '::',
                        port: port ? port + 1 : undefined,
                        announcedAddress: announcedIpV6,
                        flags: { ipv6Only: true }
                    }
                ];
                webRtcServerIpv6 = await worker.createWebRtcServer({ listenInfos: ipv6ListenInfos });
                console.log('[mediasoup] IPv6 WebRtcServer initialized:', ipv6ListenInfos);
            } catch (err) {
                console.error('[mediasoup] IPv6 WebRtcServer setup failed:', err?.message || err);
            }
        }

        // Fallback to legacy dual-stack if both servers failed to initialize
        if (!webRtcServerIpv4 && !webRtcServerIpv6) {
            console.warn('[mediasoup] Both IPv4 and IPv6 servers failed, falling back to dual-stack...');
            const fallbackListenInfos = [
                { protocol: 'udp', ip: '0.0.0.0', port },
                { protocol: 'tcp', ip: '0.0.0.0', port }
            ];
            webRtcServerIpv4 = await worker.createWebRtcServer({ listenInfos: fallbackListenInfos });
            console.log('[mediasoup] Fallback WebRtcServer initialized:', fallbackListenInfos);
        }

        console.log('[mediasoup] Router and WebRtcServers initialized successfully');
        console.log(`[mediasoup] IPv4 server: ${webRtcServerIpv4 ? 'available' : 'unavailable'}`);
        console.log(`[mediasoup] IPv6 server: ${webRtcServerIpv6 ? 'available' : 'unavailable'}`);
        
    } catch (err) {
        console.error('[mediasoup] Failed to initialize router/WebRtcServers:', err);
        router = null;
        webRtcServerIpv4 = null;
        webRtcServerIpv6 = null;
    }
}

initMediasoup();


// Helper to parse query params from ws URL
function getQueryParams(url) {
    const params = {};
    if (!url) return params;
    const query = url.split('?')[1];
    if (!query) return params;
    for (const part of query.split('&')) {
        const [key, value] = part.split('=');
        params[key] = decodeURIComponent(value || '');
    }
    return params;
}


async function dspeakWebSocketHandler(ws, req) {
    // Parse auth and channelId from query params
    const params = getQueryParams(req.url);
    const userId = params.auth;
    const channelId = params.channelId;
    if (!userId || !channelId) {
        ws.send(JSON.stringify({ type: 'error', data: 'Missing auth or channelId in query params' }));
        ws.close();
        return;
    }

    // Detect client IP family for appropriate transport selection
    const clientIpFamily = getClientIpFamily(req);
    console.log(`[ws] Client ${userId} connecting with IP family: ${clientIpFamily}`);
    
    // Attach IP family to ws for transport creation
    ws.clientIpFamily = clientIpFamily;

    // Validate user/channel with main backend
    try {
        const apiBase = process.env.INTEROP_API_BASE_URL;
        const url = `${apiBase}/dspeak/channel/details?id=${encodeURIComponent(channelId)}`;
        const resp = await fetch(url, {
            headers: { 'Authorization': userId }
        });
        if (!resp.ok) {
            ws.send(JSON.stringify({ type: 'error', data: 'Channel validation failed', status: resp.status }));
            ws.close();
            return;
        }
        const channel = await resp.json();
        if (!channel.isMedia) {
            ws.send(JSON.stringify({ type: 'error', data: 'Channel is not a media channel' }));
            ws.close();
            return;
        }
        // Optionally: check if user is allowed in channel (e.g., inRoom or room membership)
        // If you want to enforce, add logic here
    } catch (err) {
        ws.send(JSON.stringify({ type: 'error', data: 'Backend validation error' }));
        ws.close();
        return;
    }

    // Attach context to ws
    ws.userId = userId;
    ws.channelId = channelId;

    clients.add(ws);
    // Add user to channel presence
    if (!channelPresence.has(channelId)) channelPresence.set(channelId, new Set());
    channelPresence.get(channelId).add(userId);
    // Notify main server of join event
    sendInteropEvent({
        type: 'media_presence',
        event: 'join',
        userId,
        channelId,
        timestamp: new Date().toISOString()
    });
    // Sync full presence
    sendInteropEvent({
        type: 'channel_presence_sync',
        channelId,
        userIds: Array.from(channelPresence.get(channelId))
    });
    // Init per-channel maps
    if (!channelTransports.has(channelId)) channelTransports.set(channelId, new Map());
    if (!channelProducers.has(channelId)) channelProducers.set(channelId, new Map());
    if (!channelConsumers.has(channelId)) channelConsumers.set(channelId, new Map());

    // Broadcast presence and producers to all in channel
    const inRoom = Array.from(channelPresence.get(channelId));
    const producers = channelProducers.has(channelId)
        ? Array.from(channelProducers.get(channelId).values()).map(p => p.id)
        : [];
    for (const client of clients) {
        if (client.channelId === channelId) {
            client.send(JSON.stringify({
                type: 'currentlyInChannel',
                inRoom,
                producers
            }));
        }
    }

    ws.send(JSON.stringify({
        type: 'connected',
        data: {
            channelId,
            userId,
            message: 'dspeak socket connection successful'
        }
    }));

    ws.on('message', async (message) => {
        let data;
        try {
            if (Buffer.isBuffer(message)) {
                message = message.toString('utf8');
            }
            if (typeof message === 'string') {
                try {
                    data = JSON.parse(message);
                } catch (e) {
                    ws.send(JSON.stringify({ type: 'error', data: 'Malformed JSON in message' }));
                    return;
                }
            } else if (typeof message === 'object' && message !== null) {
                data = message;
            } else {
                ws.send(JSON.stringify({ type: 'error', data: 'Unsupported message type' }));
                return;
            }
            if (!data || typeof data.type !== 'string') {
                ws.send(JSON.stringify({ type: 'error', data: 'Invalid message format: missing type' }));
                return;
            }
            // Only allow further actions if ws has userId/channelId
            if (!ws.userId || !ws.channelId) {
                ws.send(JSON.stringify({ type: 'error', data: 'Unauthorized: missing user context' }));
                ws.close();
                return;
            }
            switch (data.type) {
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                    break;
                case 'create-transport': {
                    if (!router) {
                        ws.send(JSON.stringify({ type: 'error', data: 'Router not ready' }));
                        break;
                    }
                    
                    // Select appropriate WebRTC server based on client IP family
                    let selectedWebRtcServer;
                    if (ws.clientIpFamily === 'ipv6' && webRtcServerIpv6) {
                        selectedWebRtcServer = webRtcServerIpv6;
                        console.log(`[ws] Using IPv6 WebRTC server for client ${ws.userId}`);
                    } else if (ws.clientIpFamily === 'ipv4' && webRtcServerIpv4) {
                        selectedWebRtcServer = webRtcServerIpv4;
                        console.log(`[ws] Using IPv4 WebRTC server for client ${ws.userId}`);
                    } else {
                        // Fallback logic
                        selectedWebRtcServer = webRtcServerIpv4 || webRtcServerIpv6;
                        if (selectedWebRtcServer) {
                            console.log(`[ws] Using fallback WebRTC server for client ${ws.userId} (${ws.clientIpFamily})`);
                        }
                    }
                    
                    if (!selectedWebRtcServer) {
                        ws.send(JSON.stringify({ type: 'error', data: 'No WebRTC server available for your connection type' }));
                        break;
                    }
                    
                    try {
                        const transport = await router.createWebRtcTransport({
                            webRtcServer: selectedWebRtcServer,
                            enableUdp: true,
                            enableTcp: true,
                            preferUdp: true,
                            iceServers: Array.isArray(iceServers) && iceServers.length > 0 ? iceServers : undefined
                        });
                        // Ensure inner maps exist
                        if (!channelTransports.get(ws.channelId).has(ws)) {
                            channelTransports.get(ws.channelId).set(ws, new Map());
                        }
                        channelTransports.get(ws.channelId).get(ws).set(transport.id, transport);
                        
                        console.log(`[ws] Created transport ${transport.id} for ${ws.clientIpFamily} client ${ws.userId}`);
                        console.log(`[ws] Original ICE candidates: ${transport.iceCandidates.length} candidates`);
                        transport.iceCandidates.forEach((candidate, index) => {
                            console.log(`[ws] Original candidate ${index}: ${candidate.address}:${candidate.port} (${candidate.protocol})`);
                        });
                        
                        // Process ICE candidates to ensure correct announced ports for playit.gg tunnel
                        let processedIceCandidates = transport.iceCandidates;
                        if (ws.clientIpFamily === 'ipv4') {
                            const ipv4SourcePort = parseInt(process.env.SFU_IPV4_PORT, 10);
                            const announcedIpV4 = process.env.SFU_IPV4;
                            const localPort = parseInt(process.env.SFU_PORT, 10) || 12825;
                            
                            if (ipv4SourcePort && announcedIpV4) {
                                processedIceCandidates = transport.iceCandidates.map(candidate => {
                                    // Fix IPv4 candidates: replace local port with external playit.gg port
                                    if (candidate.address === announcedIpV4 && candidate.port === localPort) {
                                        console.log(`[ws] Correcting IPv4 candidate port: ${candidate.address}:${candidate.port} -> ${candidate.address}:${ipv4SourcePort}`);
                                        return {
                                            ...candidate,
                                            port: ipv4SourcePort
                                        };
                                    }
                                    return candidate;
                                });
                            }
                        }
                        
                        console.log(`[ws] Final ICE candidates: ${processedIceCandidates.length} candidates`);
                        processedIceCandidates.forEach((candidate, index) => {
                            console.log(`[ws] Final candidate ${index}: ${candidate.address}:${candidate.port} (${candidate.protocol})`);
                        });
                        
                        ws.send(JSON.stringify({
                            type: 'transport-params',
                            data: {
                                id: transport.id,
                                iceParameters: transport.iceParameters,
                                iceCandidates: processedIceCandidates,
                                dtlsParameters: transport.dtlsParameters,
                                sctpParameters: transport.sctpParameters || undefined
                            }
                        }));
                    } catch (err) {
                        console.error(`[ws] Failed to create transport for ${ws.clientIpFamily} client:`, err?.message || err);
                        ws.send(JSON.stringify({ type: 'error', data: 'Failed to create transport' }));
                    }
                    break;
                }
                case 'get-rtp-capabilities': {
                    if (!router) {
                        console.error('[ws] get-rtp-capabilities: Router not ready');
                        ws.send(JSON.stringify({ type: 'error', data: 'Router not ready' }));
                        break;
                    }
                    try {
                        const rtpCaps = JSON.parse(JSON.stringify(router.rtpCapabilities));
                        ws.send(JSON.stringify({ type: 'rtp-capabilities', data: rtpCaps }));
                    } catch (err) {
                        console.error('[ws] get-rtp-capabilities: Failed to get RTP capabilities', err);
                        ws.send(JSON.stringify({ type: 'error', data: 'Failed to get RTP capabilities', details: err && err.message }));
                    }
                    break;
                }
                case 'connect-transport': {
                    const wsTransports = channelTransports.get(ws.channelId).get(ws);
                    if (!wsTransports || wsTransports.size === 0) {
                        ws.send(JSON.stringify({ type: 'error', data: 'Transport not found' }));
                        break;
                    }
                    try {
                        const { dtlsParameters, transportId } = data.data || {};
                        if (transportId) {
                            const transport = wsTransports.get(transportId);
                            if (!transport) {
                                ws.send(JSON.stringify({ type: 'error', data: 'Failed to connect transport' }));
                                break;
                            }
                            await transport.connect({ dtlsParameters });
                            ws.send(JSON.stringify({ type: 'transport-connected', data: { id: transport.id } }));
                        } else {
                            // No id given: try to connect all pending transports
                            let connectedAny = false;
                            for (const t of wsTransports.values()) {
                                try {
                                    await t.connect({ dtlsParameters });
                                    connectedAny = true;
                                } catch {}
                            }
                            if (connectedAny) {
                                ws.send(JSON.stringify({ type: 'transport-connected' }));
                            } else {
                                ws.send(JSON.stringify({ type: 'error', data: 'Failed to connect transport' }));
                            }
                        }
                    } catch (err) {
                        console.error('[ws] connect-transport error:', err && err.message ? err.message : err);
                        ws.send(JSON.stringify({ type: 'error', data: 'Failed to connect transport', details: err && err.message }));
                    }
                    break;
                }
                case 'produce': {
                    console.log(`[ws] Received 'produce' from user ${ws.userId} in channel ${ws.channelId}`);
                    const wsTransports = channelTransports.get(ws.channelId).get(ws);
                    if (!wsTransports || wsTransports.size === 0) {
                        ws.send(JSON.stringify({ type: 'error', data: 'Transport not found' }));
                        break;
                    }
                    try {
                        const { kind, rtpParameters, transportId } = data.data;
                        let transport = transportId ? wsTransports.get(transportId) : null;
                        if (!transport) {
                            // Fallback to first transport
                            transport = Array.from(wsTransports.values())[0];
                        }
                        if (!transport) {
                            ws.send(JSON.stringify({ type: 'error', data: 'Transport not found' }));
                            break;
                        }
                        const producer = await transport.produce({ kind, rtpParameters });
                        channelProducers.get(ws.channelId).set(ws, producer);
                        ws.send(JSON.stringify({ type: 'producer-id', data: { id: producer.id } }));
                        // Notify all other clients in channel of new producer (exclude producer's own client)
                        for (const client of clients) {
                            if (client !== ws && client.channelId === ws.channelId) {
                                client.send(JSON.stringify({
                                    type: 'new-producer',
                                    data: { producerId: producer.id }
                                }));
                            }
                        }
                    } catch (err) {
                        ws.send(JSON.stringify({ type: 'error', data: 'Failed to create producer' }));
                    }
                    break;
                }
                case 'consume': {
                    console.log(`[ws] Received 'consume' from user ${ws.userId} in channel ${ws.channelId}`);
                    const wsTransports = channelTransports.get(ws.channelId).get(ws);
                    if (!wsTransports || wsTransports.size === 0) {
                        ws.send(JSON.stringify({ type: 'error', data: 'Transport not found' }));
                        break;
                    }
                    const { rtpCapabilities, transportId } = data.data;
                    let transport = transportId ? wsTransports.get(transportId) : null;
                    if (!transport) {
                        // Fallback to last (most recently created) transport for consuming
                        const vals = Array.from(wsTransports.values());
                        transport = vals[vals.length - 1];
                    }
                    if (!transport) {
                        ws.send(JSON.stringify({ type: 'error', data: 'Transport not found' }));
                        break;
                    }
                    // Loop through all remote producers in the channel (not self)
                    let foundProducer = false;
                    for (const [client, producer] of channelProducers.get(ws.channelId).entries()) {
                        if (client === ws) continue;
                        if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
                            ws.send(JSON.stringify({ type: 'error', data: `Cannot consume producer ${producer.id}` }));
                            continue;
                        }
                        try {
                            const consumer = await transport.consume({
                                producerId: producer.id,
                                rtpCapabilities,
                                paused: false,
                            });
                            // Store consumer per producer for this ws
                            if (!channelConsumers.get(ws.channelId).has(ws)) {
                                channelConsumers.get(ws.channelId).set(ws, new Map());
                            }
                            channelConsumers.get(ws.channelId).get(ws).set(producer.id, consumer);
                            ws.send(JSON.stringify({
                                type: 'consumer-params',
                                data: {
                                    id: consumer.id,
                                    producerId: producer.id,
                                    kind: consumer.kind,
                                    rtpParameters: consumer.rtpParameters,
                                }
                            }));
                            foundProducer = true;
                        } catch (err) {
                            ws.send(JSON.stringify({ type: 'error', data: `Failed to create consumer for producer ${producer.id}` }));
                        }
                    }
                    if (!foundProducer) {
                        ws.send(JSON.stringify({ type: 'error', data: 'No remote producers available' }));
                    }
                    break;
                }
                default:
                    ws.send(JSON.stringify({ type: 'error', data: `Unknown message type: ${data.type}` }));
            }
        } catch (error) {
            ws.send(JSON.stringify({ type: 'error', data: 'Error parsing or handling message' }));
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        // Remove from channel presence
        if (channelPresence.has(ws.channelId)) {
            channelPresence.get(ws.channelId).delete(ws.userId);
            // Notify main server of leave event
            sendInteropEvent({
                type: 'media_presence',
                event: 'leave',
                userId: ws.userId,
                channelId: ws.channelId,
                timestamp: new Date().toISOString()
            });
            // Sync full presence
            sendInteropEvent({
                type: 'channel_presence_sync',
                channelId: ws.channelId,
                userIds: Array.from(channelPresence.get(ws.channelId))
            });
            // Broadcast updated presence and producers
            const inRoom = Array.from(channelPresence.get(ws.channelId));
            const producers = channelProducers.has(ws.channelId)
                ? Array.from(channelProducers.get(ws.channelId).values()).map(p => p.id)
                : [];
            for (const client of clients) {
                if (client.channelId === ws.channelId) {
                    client.send(JSON.stringify({
                        type: 'currentlyInChannel',
                        inRoom,
                        producers
                    }));
                }
            }
        }
        // Clean up per-channel media
        if (channelTransports.has(ws.channelId)) {
            const tmap = channelTransports.get(ws.channelId);
            const wsTransports = tmap.get(ws);
            if (wsTransports) {
                for (const t of wsTransports.values()) {
                    try { t.close(); } catch {}
                }
            }
            tmap.delete(ws);
        }
        if (channelProducers.has(ws.channelId)) {
            const pmap = channelProducers.get(ws.channelId);
            const producer = pmap.get(ws);
            if (producer) producer.close();
            pmap.delete(ws);
        }
        if (channelConsumers.has(ws.channelId)) {
            const cmap = channelConsumers.get(ws.channelId);
            const wsConsumers = cmap.get(ws);
            if (wsConsumers && wsConsumers instanceof Map) {
                for (const consumer of wsConsumers.values()) {
                    try { consumer.close(); } catch {}
                }
            } else if (wsConsumers) {
                // Legacy: single consumer
                try { wsConsumers.close(); } catch {}
            }
            cmap.delete(ws);
        }
    });
}

export { dspeakWebSocketHandler, clients };
