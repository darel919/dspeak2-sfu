import mediasoup from 'mediasoup'
import fetch from 'node-fetch';
import WebSocket from 'ws';
// --- Interop WebSocket Client ---
let interopWs;
function connectInteropWs() {
    const interopUrl = (process.env.INTEROP_API_BASE_URL || 'ws://localhost:328') + '/dspeak/interop';
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
const channelTransports = new Map(); // channelId -> Map<ws, transport>
const channelProducers = new Map(); // channelId -> Map<ws, producer>
const channelConsumers = new Map(); // channelId -> Map<ws, consumer>

const isProd = process.env.NODE_ENV === 'production';
let worker;
let router;
const mediaCodecs = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
    }
];

async function initMediasoup() {
    try {
        worker = await mediasoup.createWorker();
        router = await worker.createRouter({ mediaCodecs });
        console.log('[mediasoup] Router initialized:', !!router);
    } catch (err) {
        console.error('[mediasoup] Failed to initialize router:', err);
        router = null;
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

    // Validate user/channel with main backend
    try {
        const apiBase = process.env.INTEROP_API_BASE_URL || 'http://localhost:328';
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
                    const announcedIp = isProd ? 'api.darelisme.my.id' : 'localhost';
                    try {
                        const transport = await router.createWebRtcTransport({
                            listenIps: [{ ip: '0.0.0.0', announcedIp }],
                            enableUdp: true,
                            enableTcp: true,
                            preferUdp: true,
                        });
                        channelTransports.get(ws.channelId).set(ws, transport);
                        ws.send(JSON.stringify({
                            type: 'transport-params',
                            data: {
                                id: transport.id,
                                iceParameters: transport.iceParameters,
                                iceCandidates: transport.iceCandidates,
                                dtlsParameters: transport.dtlsParameters,
                                sctpParameters: transport.sctpParameters || undefined
                            }
                        }));
                    } catch (err) {
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
                    const transport = channelTransports.get(ws.channelId).get(ws);
                    if (!transport) {
                        ws.send(JSON.stringify({ type: 'error', data: 'Transport not found' }));
                        break;
                    }
                    try {
                        const { dtlsParameters } = data.data;
                        await transport.connect({ dtlsParameters });
                        ws.send(JSON.stringify({ type: 'transport-connected' }));
                    } catch (err) {
                        ws.send(JSON.stringify({ type: 'error', data: 'Failed to connect transport' }));
                    }
                    break;
                }
                case 'produce': {
                    console.log(`[ws] Received 'produce' from user ${ws.userId} in channel ${ws.channelId}`);
                    const transport = channelTransports.get(ws.channelId).get(ws);
                    if (!transport) {
                        ws.send(JSON.stringify({ type: 'error', data: 'Transport not found' }));
                        break;
                    }
                    try {
                        const { kind, rtpParameters } = data.data;
                        const producer = await transport.produce({ kind, rtpParameters });
                        channelProducers.get(ws.channelId).set(ws, producer);
                        ws.send(JSON.stringify({ type: 'producer-id', data: { id: producer.id } }));
                        // Notify all clients in channel of new producer
                        for (const client of clients) {
                            if (client.channelId === ws.channelId) {
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
                    const transport = channelTransports.get(ws.channelId).get(ws);
                    if (!transport) {
                        ws.send(JSON.stringify({ type: 'error', data: 'Transport not found' }));
                        break;
                    }
                    // Find a producer in the same channel, not self
                    const producerEntry = Array.from(channelProducers.get(ws.channelId).entries()).find(([client]) => client !== ws);
                    if (!producerEntry) {
                        ws.send(JSON.stringify({ type: 'error', data: 'No producer available' }));
                        break;
                    }
                    const [, producer] = producerEntry;
                    try {
                        const { rtpCapabilities } = data.data;
                        if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
                            ws.send(JSON.stringify({ type: 'error', data: 'Cannot consume' }));
                            break;
                        }
                        const consumer = await transport.consume({
                            producerId: producer.id,
                            rtpCapabilities,
                            paused: false,
                        });
                        channelConsumers.get(ws.channelId).set(ws, consumer);
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
                        ws.send(JSON.stringify({ type: 'error', data: 'Failed to create consumer' }));
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
            const transport = tmap.get(ws);
            if (transport) transport.close();
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
            const consumer = cmap.get(ws);
            if (consumer) consumer.close();
            cmap.delete(ws);
        }
    });
}

export { dspeakWebSocketHandler, clients };
