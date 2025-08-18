import '../../env.js';
import mediasoup from 'mediasoup'
import WebSocket from 'ws';
import { incCounter, setGauge } from '../../lib/metrics.js';

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
const channelProducerUserMap = new Map(); // channelId -> Map<producerId, userId>

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

// Monitoring / heartbeat / staging state
const stagedParticipants = new Map(); // key = `${channelId}:${userId}` -> { transports, producer, consumers, timer, ts }
let globalRequestCounter = 0;
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.SFU_HEARTBEAT_INTERVAL_MS, 10) || 15000; // send ping every 15s
const HEARTBEAT_MISS_THRESHOLD_MS = parseInt(process.env.SFU_HEARTBEAT_MISS_THRESHOLD_MS, 10) || 60000; // 60s timeout default
const GRACE_MS = parseInt(process.env.SFU_GRACE_MS, 10) || 60000; // keep participant state for 60s by default

function nextRequestId() {
    return `${Date.now()}-${++globalRequestCounter}`;
}

function logLifecycle(event, details = {}) {
    try {
        const log = Object.assign({ timestamp: new Date().toISOString(), event, workerId: worker && worker.pid ? worker.pid : null }, details);
        console.log('[SFU-Lifecycle]', JSON.stringify(log));
    } catch (e) {
        console.log('[SFU-Lifecycle] ', event, details);
    }
}

// Heartbeat monitor: check last-seen timestamps from client-sent pings and stage stale connections
setInterval(() => {
    const now = Date.now();
    for (const ws of clients) {
        try {
            if (ws.readyState !== WebSocket.OPEN) continue;
            // If client never sent a ping, treat age from connection time
            if (!ws.lastHeartbeat) ws.lastHeartbeat = ws._connectedAt || now;
            const age = now - (ws.lastHeartbeat || 0);
            if (age > HEARTBEAT_MISS_THRESHOLD_MS) {
                logLifecycle('heartbeat-timeout', { userId: ws.userId || null, channelId: ws.channelId || null, ageMs: age });
                // Stage disconnect for grace window
                stageDisconnect(ws, 'heartbeat-timeout');
            }
        } catch (e) {
            console.warn('[SFU] Heartbeat monitor error for ws:', e && e.message ? e.message : e);
        }
    }
}, HEARTBEAT_INTERVAL_MS);


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
    ws._connectedAt = Date.now();

    // Helper to send messages with correlation id
    ws.sendWithId = function(obj) {
        try {
            if (!obj.requestId) obj.requestId = nextRequestId();
            ws.send(JSON.stringify(obj));
        } catch (e) {
            console.warn('[SFU] sendWithId failed', e && e.message ? e.message : e);
        }
    };
    // If this user/channel was recently staged, restore resources
    if (restoreIfStaged(ws)) {
        clients.add(ws);
        ws.send(JSON.stringify({
            type: 'connected',
            data: {
                channelId,
                userId,
                message: 'dspeak socket restored from staged state'
            }
        }));
        // Broadcast presence and available producers to channel
        const inRoom = channelPresence.has(channelId) ? Array.from(channelPresence.get(channelId)) : [];
        const producers = channelProducers.has(channelId)
            ? Array.from(channelProducers.get(channelId).values()).map(p => p.id)
            : [];
        const producerUserMap = channelProducerUserMap.has(channelId)
            ? Object.fromEntries(channelProducerUserMap.get(channelId).entries())
            : {};
        for (const client of clients) {
            if (client.channelId === channelId) {
                client.send(JSON.stringify({ type: 'currentlyInChannel', inRoom, producers, producerUserMap }));
            }
        }
    } else {
        clients.add(ws);
    }
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
    const producerUserMap = channelProducerUserMap.has(channelId)
        ? Object.fromEntries(channelProducerUserMap.get(channelId).entries())
        : {};
    for (const client of clients) {
        if (client.channelId === channelId) {
            client.send(JSON.stringify({
                type: 'currentlyInChannel',
                inRoom,
                producers,
                producerUserMap
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

    // On join: automatically create consumers for all existing producers
    setImmediate(async () => {
        const wsTransports = channelTransports.get(ws.channelId).get(ws);
        if (!wsTransports || wsTransports.size === 0) return;
        // Wait for client to send rtpCapabilities before consuming
        // Optionally, cache rtpCapabilities per ws if you want to automate
        // For now, only create consumer if client has sent rtpCapabilities
        if (ws._lastRtpCapabilities) {
            for (const [client, producer] of channelProducers.get(ws.channelId).entries()) {
                if (client === ws) continue;
                let transport = Array.from(wsTransports.values())[wsTransports.size - 1];
                if (!transport) continue;
                if (!router.canConsume({ producerId: producer.id, rtpCapabilities: ws._lastRtpCapabilities })) continue;
                try {
                    const consumer = await transport.consume({
                        producerId: producer.id,
                        rtpCapabilities: ws._lastRtpCapabilities,
                        paused: false,
                    });
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
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'error', data: `Failed to create consumer for producer ${producer.id}` }));
                }
            }
        }
    });

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
                    // Reply quickly with pong and mirror requestId if present
                    ws.lastHeartbeat = Date.now();
                    ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now(), requestId: data.requestId || null }));
                    break;
                case 'pong':
                    // Client replied to our ping
                    ws.lastHeartbeat = Date.now();
                    if (data.requestId) {
                        logLifecycle('pong-received', { userId: ws.userId, channelId: ws.channelId, requestId: data.requestId });
                    }
                    break;
                    case 'client-rtp-capabilities': {
                        // Client sends its RTP capabilities after receiving router's
                        if (!data.data || typeof data.data !== 'object') {
                            ws.send(JSON.stringify({ type: 'error', data: 'Missing RTP capabilities in message' }));
                            break;
                        }

                        // Normalization: some clients wrap the capabilities under { rtpCapabilities: {...} }
                        // while others send the raw capabilities object. Accept both shapes and store the
                        // actual rtpCapabilities object at ws._lastRtpCapabilities for later canConsume checks.
                        const incoming = data.data;
                        if (incoming.rtpCapabilities && typeof incoming.rtpCapabilities === 'object') {
                            ws._lastRtpCapabilities = incoming.rtpCapabilities;
                        } else {
                            ws._lastRtpCapabilities = incoming;
                        }

                        // Defensive: ensure it's an object with codecs array
                        if (!ws._lastRtpCapabilities || !Array.isArray(ws._lastRtpCapabilities.codecs)) {
                            ws.send(JSON.stringify({ type: 'error', data: 'Invalid RTP capabilities format' }));
                            break;
                        }

                        ws.sendWithId({ type: 'rtp-capabilities-ack' });
                        break;
                    }
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
                        
                        logLifecycle('transport-created', { transportId: transport.id, userId: ws.userId, channelId: ws.channelId, clientIpFamily: ws.clientIpFamily });
                        console.log(`[ws] Created transport ${transport.id} for ${ws.clientIpFamily} client ${ws.userId}`);
                        console.log(`[ws] Original ICE candidates: ${transport.iceCandidates.length} candidates`);
                        transport.iceCandidates.forEach((candidate, index) => {
                            console.log(`[ws] Original candidate ${index}: ${candidate.address}:${candidate.port} (${candidate.protocol})`);
                        });

                        // Attach ICE/DTLS state listeners
                        transport.on?.('icestatechange', (iceState) => {
                            logLifecycle('transport-ice-state', { transportId: transport.id, userId: ws.userId, channelId: ws.channelId, iceState });
                        });
                        transport.on?.('iceselectedtuplechange', (info) => {
                            logLifecycle('transport-ice-selected-pair', { transportId: transport.id, userId: ws.userId, channelId: ws.channelId, selectedPair: info });
                        });
                        transport.on?.('dtlsstatechange', (dtlsState) => {
                            logLifecycle('transport-dtls-state', { transportId: transport.id, userId: ws.userId, channelId: ws.channelId, dtlsState });
                            if (dtlsState === 'failed') {
                                // send advisory before closing
                                try {
                                    ws.send(JSON.stringify({ type: 'transport-closed', transportId: transport.id, reason: 'dtls-failed' }));
                                } catch (e) {}
                                incCounter('sfu_transport_dtls_failed_total');
                                stageDisconnect(ws, 'dtls-failed');
                            }
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
                        logLifecycle('get-rtp-capabilities', { userId: ws.userId, channelId: ws.channelId });
                        const rtpCaps = JSON.parse(JSON.stringify(router.rtpCapabilities));
                        ws.sendWithId({ type: 'rtp-capabilities', data: rtpCaps });
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
                        logLifecycle('connect-transport-request', { userId: ws.userId, channelId: ws.channelId });
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
                        
                        // Enforce one audio producer per user
                        const userProducerMap = channelProducers.get(ws.channelId);
                        for (const [client, existingProducer] of userProducerMap.entries()) {
                            if (client.userId === ws.userId && client !== ws && existingProducer) {
                                existingProducer.close();
                                userProducerMap.delete(client);
                                if (channelProducerUserMap.has(ws.channelId)) {
                                    channelProducerUserMap.get(ws.channelId).delete(existingProducer.id);
                                }
                            }
                        }
                        
                        const producer = await transport.produce({ kind, rtpParameters });
                        channelProducers.get(ws.channelId).set(ws, producer);
                        logLifecycle('producer-created', { producerId: producer.id, userId: ws.userId, channelId: ws.channelId });
                        // Attach close listener
                        producer.on?.('transportclose', () => {
                            logLifecycle('producer-transport-closed', { producerId: producer.id, userId: ws.userId, channelId: ws.channelId });
                            incCounter('sfu_producer_transport_closed_total');
                        });
                        producer.on?.('close', () => {
                            logLifecycle('producer-closed', { producerId: producer.id, userId: ws.userId, channelId: ws.channelId });
                            incCounter('sfu_producer_closed_total');
                        });
                        if (!channelProducerUserMap.has(ws.channelId)) channelProducerUserMap.set(ws.channelId, new Map());
                        channelProducerUserMap.get(ws.channelId).set(producer.id, ws.userId);
                        ws.send(JSON.stringify({ type: 'producer-id', data: { id: producer.id, userId: ws.userId, channelId: ws.channelId } }));
                        
                        // Notify interop server of new producer
                        sendInteropEvent({
                            type: 'media_producer',
                            event: 'add',
                            userId,
                            channelId,
                            producerId: producer.id,
                            timestamp: new Date().toISOString()
                        });
                        
                        // Broadcast updated producers to all in channel
                        const inRoom = Array.from(channelPresence.get(channelId));
                        const producers = channelProducers.has(channelId)
                            ? Array.from(channelProducers.get(channelId).values()).map(p => p.id)
                            : [];
                        const producerUserMap = channelProducerUserMap.has(channelId)
                            ? Object.fromEntries(channelProducerUserMap.get(channelId).entries())
                            : {};
                        for (const client of clients) {
                            if (client.channelId === channelId) {
                                client.send(JSON.stringify({
                                    type: 'currentlyInChannel',
                                    inRoom,
                                    producers,
                                    producerUserMap
                                }));
                                    // Always send available producerIds after produce
                                    client.send(JSON.stringify({
                                        type: 'available-producers',
                                        data: { producers, producerUserMap }
                                    }));
                            }
                        }
                        
                        // Auto-consume logic: immediately create consumer for this producer on other clients
                        setImmediate(async () => {
                            for (const client of clients) {
                                if (client.channelId !== ws.channelId || client === ws) continue;
                                const clientTransports = channelTransports.get(client.channelId).get(client);
                                if (!clientTransports || clientTransports.size === 0) continue;
                                let transport = Array.from(clientTransports.values())[clientTransports.size - 1];
                                if (!transport) continue;
                                if (!router.canConsume({ producerId: producer.id, rtpCapabilities: client._lastRtpCapabilities })) continue;
                                try {
                                    const consumer = await transport.consume({
                                        producerId: producer.id,
                                        rtpCapabilities: client._lastRtpCapabilities,
                                        paused: false,
                                    });
                                    if (!channelConsumers.get(client.channelId).has(client)) {
                                        channelConsumers.get(client.channelId).set(client, new Map());
                                    }
                                    channelConsumers.get(client.channelId).get(client).set(producer.id, consumer);
                                    client.send(JSON.stringify({
                                        type: 'consumer-params',
                                        data: {
                                            id: consumer.id,
                                            producerId: producer.id,
                                            kind: consumer.kind,
                                            rtpParameters: consumer.rtpParameters,
                                            userId: channelProducerUserMap.get(ws.channelId)?.get(producer.id) || null
                                        }
                                    }));
                                } catch (err) {
                                    client.send(JSON.stringify({ type: 'error', data: `Failed to create consumer for new producer ${producer.id}` }));
                                }
                            }
                        });
                        
                        ws.send(JSON.stringify({
                            type: 'produced',
                            data: {
                                id: producer.id,
                                userId,
                                channelId,
                                kind: producer.kind,
                                rtpParameters: producer.rtpParameters,
                            }
                        }));
                    } catch (err) {
                        console.error(`[ws] Failed to handle produce request:`, err?.message || err);
                        ws.send(JSON.stringify({ type: 'error', data: 'Failed to produce media' }));
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
                    try {
                        const { producerId, transportId } = data.data;
                            // Validate producerId
                            if (!producerId || typeof producerId !== 'string') {
                                ws.send(JSON.stringify({ type: 'error', data: 'Missing or invalid producerId in consume request' }));
                                break;
                            }
                        let transport = wsTransports.get(transportId);
                        if (!transport) {
                            ws.send(JSON.stringify({ type: 'error', data: 'Transport not found' }));
                            break;
                        }
                        // Check if we can consume this producer
                        const producerExists = channelProducers.get(ws.channelId) && Array.from(channelProducers.get(ws.channelId).values()).find(p => p.id === producerId);
                        if (!producerExists) {
                            console.warn(`[ws] Cannot consume: producerId ${producerId} not found for user ${ws.userId} in channel ${ws.channelId}`);
                            ws.send(JSON.stringify({ type: 'error', data: 'Cannot consume this producer: producer not found' }));
                            break;
                        }
                        // Check for missing RTP capabilities
                            if (!ws._lastRtpCapabilities) {
                                ws.send(JSON.stringify({ type: 'error', data: 'Cannot consume: missing RTP capabilities. Please send your RTP capabilities first.' }));
                                break;
                            }
                        if (!router.canConsume({ producerId, rtpCapabilities: ws._lastRtpCapabilities })) {
                            // Find the producer object for detailed logging
                            const producerObj = Array.from(channelProducers.get(ws.channelId).values()).find(p => p.id === producerId);

                            // Stringify deep objects for clearer logs (avoid truncation of nested objects)
                            const producerRtp = producerObj && producerObj.rtpParameters ? producerObj.rtpParameters : null;
                            try {
                                console.warn(`[ws] Cannot consume: router cannot consume producerId ${producerId} for user ${ws.userId} in channel ${ws.channelId}.`);
                                console.warn('[ws] Producer RTP parameters (full):', JSON.stringify(producerRtp, null, 2));
                            } catch (e) {
                                console.warn('[ws] Producer RTP parameters (raw):', producerRtp);
                            }
                            try {
                                console.warn('[ws] Client RTP capabilities (full):', JSON.stringify(ws._lastRtpCapabilities, null, 2));
                            } catch (e) {
                                console.warn('[ws] Client RTP capabilities (raw):', ws._lastRtpCapabilities);
                            }

                            ws.send(JSON.stringify({ type: 'error', data: 'Cannot consume this producer: codec/parameter mismatch' }));
                            break;
                        }
                        const consumer = await transport.consume({
                            producerId,
                            rtpCapabilities: ws._lastRtpCapabilities,
                            paused: false,
                        });
                        logLifecycle('consumer-created', { consumerId: consumer.id, producerId, userId: ws.userId, channelId: ws.channelId });
                        consumer.on?.('close', () => {
                            logLifecycle('consumer-closed', { consumerId: consumer.id, producerId, userId: ws.userId, channelId: ws.channelId });
                            incCounter('sfu_consumer_closed_total');
                        });
                        consumer.on?.('producerclose', () => {
                            logLifecycle('consumer-producer-closed', { consumerId: consumer.id, producerId, userId: ws.userId, channelId: ws.channelId });
                            incCounter('sfu_consumer_producer_closed_total');
                        });
                        if (!channelConsumers.get(ws.channelId).has(ws)) {
                            channelConsumers.get(ws.channelId).set(ws, new Map());
                        }
                        channelConsumers.get(ws.channelId).get(ws).set(producerId, consumer);
                        ws.send(JSON.stringify({
                            type: 'consumer-params',
                            data: {
                                id: consumer.id,
                                producerId,
                                kind: consumer.kind,
                                rtpParameters: consumer.rtpParameters,
                            }
                        }));
                    } catch (err) {
                        console.error(`[ws] Failed to handle consume request:`, err?.message || err);
                        ws.send(JSON.stringify({ type: 'error', data: 'Failed to consume media' }));
                    }
                    break;
                }
                case 'resume': {
                    console.log(`[ws] Received 'resume' from user ${ws.userId} in channel ${ws.channelId}`);
                    const wsTransports = channelTransports.get(ws.channelId).get(ws);
                    if (!wsTransports || wsTransports.size === 0) {
                        ws.send(JSON.stringify({ type: 'error', data: 'Transport not found' }));
                        break;
                    }
                    try {
                        const { transportId } = data.data;
                        let transport = wsTransports.get(transportId);
                        if (!transport) {
                            ws.send(JSON.stringify({ type: 'error', data: 'Transport not found' }));
                            break;
                        }
                        await transport.resume();
                        ws.send(JSON.stringify({ type: 'resumed' }));
                    } catch (err) {
                        console.error(`[ws] Failed to resume transport:`, err?.message || err);
                        ws.send(JSON.stringify({ type: 'error', data: 'Failed to resume transport' }));
                    }
                    break;
                }
                case 'pause': {
                    console.log(`[ws] Received 'pause' from user ${ws.userId} in channel ${ws.channelId}`);
                    const wsTransports = channelTransports.get(ws.channelId).get(ws);
                    if (!wsTransports || wsTransports.size === 0) {
                        ws.send(JSON.stringify({ type: 'error', data: 'Transport not found' }));
                        break;
                    }
                    try {
                        const { transportId } = data.data;
                        let transport = wsTransports.get(transportId);
                        if (!transport) {
                            ws.send(JSON.stringify({ type: 'error', data: 'Transport not found' }));
                            break;
                        }
                        await transport.pause();
                        ws.send(JSON.stringify({ type: 'paused' }));
                    } catch (err) {
                        console.error(`[ws] Failed to pause transport:`, err?.message || err);
                        ws.send(JSON.stringify({ type: 'error', data: 'Failed to pause transport' }));
                    }
                    break;
                }
                case 'close-transport': {
                    console.log(`[ws] Received 'close-transport' from user ${ws.userId} in channel ${ws.channelId}`);
                    const wsTransports = channelTransports.get(ws.channelId).get(ws);
                    if (!wsTransports || wsTransports.size === 0) {
                        ws.send(JSON.stringify({ type: 'error', data: 'Transport not found' }));
                        break;
                    }
                    try {
                        const { transportId } = data.data;
                        let transport = wsTransports.get(transportId);
                        if (!transport) {
                            ws.send(JSON.stringify({ type: 'error', data: 'Transport not found' }));
                            break;
                        }
                        await transport.close();
                        ws.send(JSON.stringify({ type: 'transport-closed' }));
                    } catch (err) {
                        console.error(`[ws] Failed to close transport:`, err?.message || err);
                        ws.send(JSON.stringify({ type: 'error', data: 'Failed to close transport' }));
                    }
                    break;
                }
                default:
                    ws.send(JSON.stringify({ type: 'error', data: `Unknown message type: ${data.type}` }));
            }
        } catch (err) {
            console.error('[ws] Error handling message:', err);
            ws.send(JSON.stringify({ type: 'error', data: 'Internal server error' }));
        }
    });

    ws.on('close', () => {
        // Stage disconnect with grace period so clients can reconnect without full teardown
        logLifecycle('ws-close-received', { userId, channelId });
        stageDisconnect(ws, 'client-close');
    });

    // Graceful staging: keep resources for a short window to allow resume
    function stageDisconnect(targetWs, reason) {
        try {
            const key = `${targetWs.channelId}:${targetWs.userId}`;
            if (stagedParticipants.has(key)) {
                // Already staged; reset timer
                const entry = stagedParticipants.get(key);
                clearTimeout(entry.timer);
                entry.ts = Date.now();
                entry.reason = reason;
                entry.timer = setTimeout(() => finalizeDisconnect(key), GRACE_MS);
                logLifecycle('stage-refresh', { key, reason, graceMs: GRACE_MS });
                return;
            }

            // Capture current resources
            const transports = channelTransports.has(targetWs.channelId) ? channelTransports.get(targetWs.channelId).get(targetWs) : null;
            const producer = channelProducers.has(targetWs.channelId) ? channelProducers.get(targetWs.channelId).get(targetWs) : null;
            const consumers = channelConsumers.has(targetWs.channelId) ? channelConsumers.get(targetWs.channelId).get(targetWs) : null;

            // Remove from active client list and presence immediately
            clients.delete(targetWs);
            if (channelPresence.has(targetWs.channelId)) {
                channelPresence.get(targetWs.channelId).delete(targetWs.userId);
                // broadcast presence
                for (const client of clients) {
                    if (client.channelId === targetWs.channelId) {
                        client.send(JSON.stringify({ type: 'currentlyInChannel', inRoom: Array.from(channelPresence.get(targetWs.channelId)) }));
                    }
                }
            }

            const timer = setTimeout(() => finalizeDisconnect(key), GRACE_MS);
            stagedParticipants.set(key, { transports, producer, consumers, timer, ts: Date.now(), reason });
            logLifecycle('stage-created', { key, reason, graceMs: GRACE_MS });
            incCounter('sfu_stage_created_total');

            // Notify interop server of staged leave
            sendInteropEvent({ type: 'media_presence', event: 'staged-leave', userId: targetWs.userId, channelId: targetWs.channelId, reason, timestamp: new Date().toISOString() });
        } catch (e) {
            console.warn('[SFU] stageDisconnect error:', e && e.message ? e.message : e);
            // Fallback to immediate finalization
            finalizeDisconnect(`${ws.channelId}:${ws.userId}`);
        }
    }

    function finalizeDisconnect(key) {
        try {
            const entry = stagedParticipants.get(key);
            if (!entry) return;
            const [channelId, userId] = key.split(':');
            // Close transports
            if (entry.transports) {
                for (const transport of entry.transports.values()) {
                    try { transport.close(); } catch (e) {}
                    logLifecycle('transport-closed', { transportId: transport.id, userId, channelId, reason: entry.reason });
                }
            }
            // Close producer
            if (entry.producer) {
                try { entry.producer.close(); } catch (e) {}
                logLifecycle('producer-closed', { producerId: entry.producer.id, userId, channelId, reason: entry.reason });
                if (channelProducerUserMap.has(channelId)) channelProducerUserMap.get(channelId).delete(entry.producer.id);
            }
            // Consumers cleanup
            if (entry.consumers) {
                for (const consumer of entry.consumers.values()) {
                    try { consumer.close(); } catch (e) {}
                    logLifecycle('consumer-closed', { consumerId: consumer.id, userId, channelId, reason: entry.reason });
                }
            }

            stagedParticipants.delete(key);
            incCounter('sfu_finalized_disconnect_total');
            // Notify interop server of final leave
            sendInteropEvent({ type: 'media_presence', event: 'leave', userId, channelId, reason: entry.reason, timestamp: new Date().toISOString() });
        } catch (e) {
            console.warn('[SFU] finalizeDisconnect error:', e && e.message ? e.message : e);
        }
    }

    // Allow restoration if client reconnects with same userId/channelId within grace window
    function restoreIfStaged(newWs) {
        const key = `${newWs.channelId}:${newWs.userId}`;
        const entry = stagedParticipants.get(key);
        if (!entry) return false;
        clearTimeout(entry.timer);
        // Reattach maps
        if (!channelTransports.has(newWs.channelId)) channelTransports.set(newWs.channelId, new Map());
        if (entry.transports) channelTransports.get(newWs.channelId).set(newWs, entry.transports);
        if (!channelProducers.has(newWs.channelId)) channelProducers.set(newWs.channelId, new Map());
        if (entry.producer) channelProducers.get(newWs.channelId).set(newWs, entry.producer);
        if (entry.consumers) {
            if (!channelConsumers.has(newWs.channelId)) channelConsumers.set(newWs.channelId, new Map());
            channelConsumers.get(newWs.channelId).set(newWs, entry.consumers);
        }
        stagedParticipants.delete(key);
        logLifecycle('stage-restored', { key });
        incCounter('sfu_stage_restored_total');
        // record reconnection time
        try {
            const reconnectMs = Date.now() - (entry.ts || Date.now());
            incCounter('sfu_reconnect_total');
            setGauge('sfu_last_reconnect_ms', reconnectMs);
        } catch (e) {}
        // Notify interop server of re-join
        sendInteropEvent({ type: 'media_presence', event: 'rejoin', userId: newWs.userId, channelId: newWs.channelId, timestamp: new Date().toISOString() });
        return true;
    }
}

export {dspeakWebSocketHandler}
