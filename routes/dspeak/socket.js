import mediasoup from 'mediasoup'

const clients = new Set();
const transports = new Map();
const producers = new Map();
const consumers = new Map();

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
    worker = await mediasoup.createWorker();
    router = await worker.createRouter({ mediaCodecs });
}

initMediasoup();

function dspeakWebSocketHandler(ws) {
    clients.add(ws);
    ws.send(JSON.stringify({
        type: 'test',
        data: { message: 'dspeak socket connection successful' }
    }));

    ws.on('message', async (message) => {
        let data;
        try {
            // console.log('Received message:', message);
            if (Buffer.isBuffer(message)) {
                message = message.toString('utf8');
            }
            if (typeof message === 'string') {
                data = JSON.parse(message);
            } else if (typeof message === 'object' && message !== null) {
                data = message;
            } else {
                throw new Error('Unsupported message type');
            }
            if (!data || typeof data.type !== 'string') {
                ws.send(JSON.stringify({ type: 'error', data: 'Invalid message format: missing type' }));
                // ...existing code...
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
                    const transport = await router.createWebRtcTransport({
                        listenIps: [{ ip: '0.0.0.0', announcedIp }],
                        enableUdp: true,
                        enableTcp: true,
                        preferUdp: true,
                    });
                    transports.set(ws, transport);
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
                    break;
                }
                case 'get-rtp-capabilities': {
                    if (!router) {
                        ws.send(JSON.stringify({ type: 'error', data: 'Router not ready' }));
                        break;
                    }
                    const rtpCaps = JSON.parse(JSON.stringify(router.rtpCapabilities));
                    console.log('Sending RTP Capabilities:', rtpCaps);
                    ws.send(JSON.stringify({ type: 'rtp-capabilities', data: rtpCaps }));
                    break;
                }
                case 'connect-transport': {
                    const transport = transports.get(ws);
                    if (!transport) {
                        ws.send(JSON.stringify({ type: 'error', data: 'Transport not found' }));
                        break;
                    }
                    const { dtlsParameters } = data.data;
                    await transport.connect({ dtlsParameters });
                    ws.send(JSON.stringify({ type: 'transport-connected' }));
                    break;
                }
                case 'produce': {
                    const transport = transports.get(ws);
                    if (!transport) {
                        ws.send(JSON.stringify({ type: 'error', data: 'Transport not found' }));
                        break;
                    }
                    const { kind, rtpParameters } = data.data;
                    const producer = await transport.produce({ kind, rtpParameters });
                    producers.set(ws, producer);
                    ws.send(JSON.stringify({ type: 'producer-id', data: { id: producer.id } }));
                    break;
                }
                case 'consume': {
                    const transport = transports.get(ws);
                    if (!transport) {
                        ws.send(JSON.stringify({ type: 'error', data: 'Transport not found' }));
                        break;
                    }
                    const producerEntry = Array.from(producers.entries()).find(([client]) => client !== ws);
                    if (!producerEntry) {
                        ws.send(JSON.stringify({ type: 'error', data: 'No producer available' }));
                        break;
                    }
                    const [, producer] = producerEntry;
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
                    consumers.set(ws, consumer);
                    ws.send(JSON.stringify({
                        type: 'consumer-params',
                        data: {
                            id: consumer.id,
                            producerId: producer.id,
                            kind: consumer.kind,
                            rtpParameters: consumer.rtpParameters,
                        }
                    }));
                    break;
                }
                default:
                    ws.send(JSON.stringify({ type: 'error', data: `Unknown message type: ${data.type}` }));
            }
        } catch (error) {
            ws.send(JSON.stringify({ type: 'error', data: 'Error parsing message' }));
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        const transport = transports.get(ws);
        if (transport) {
            transport.close();
            transports.delete(ws);
        }
        const producer = producers.get(ws);
        if (producer) {
            producer.close();
            producers.delete(ws);
        }
        const consumer = consumers.get(ws);
        if (consumer) {
            consumer.close();
            consumers.delete(ws);
        }
    });
}

export { dspeakWebSocketHandler, clients };
