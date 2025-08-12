import express from 'express'
const router = express.Router();

router.get('/health', (req, res) => {
    console.log(process.env.INTEROP_API_BASE_URL)
    res.send('dspeak v2 API is running');
});

router.get('/socket', (req, res) => {
    res.status(426).json({
        error: 'Upgrade Required',
        message: 'WebSocket connections should be made to ws://localhost:328/socket',
        websocketUrl: 'ws://localhost:328/socket'
    });
});

export default router;
