// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const uuid = require('uuid');
const cors = require('cors');
const path = require('path');
const { exec } = require('child_process');
const validateDeviceBinding = require('./lib/deviceBinding');
const { loadBoards } = require('./lib/configLoader');
const { sdrStates, rateLimiterMiddleware, initSDR, executeCommand, pollSDRState, MODE_GPIOS, setSDRBoards } = require('./lib/sdrManager');
const logger = require('./lib/logger');

// Validate device binding first
validateDeviceBinding();

// Load SDR boards
const SDR_BOARDS = loadBoards();
setSDRBoards(SDR_BOARDS);

// Initialize states
Object.keys(SDR_BOARDS).forEach(id => {
    sdrStates[id] = {
        connected: false,
        initialized: false,
        gain: 0,
        gen_mode: 'manual',
        freq: 0,
        sampling_freq: 0,
        modes: { wn: false, fsk: false, bpsk: false, qpsk: false, ntsc: false },
        tx_on: false
    };
});

// Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: '*' },
    pingInterval: 10000,
    pingTimeout: 5000
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(rateLimiterMiddleware); // Apply rate limiting

// Serve static files from /build
app.use(express.static(path.join(__dirname, 'build')));

// API Endpoints
// Get all SDR states (return array for frontend compatibility)
app.get('/api/sdrs', (req, res) => {
    const sdrsArray = Object.entries(sdrStates).map(([id, state]) => ({ id, ...state }));
    res.json(sdrsArray);
});

// Initialize SDR
app.post('/api/sdrs/:id/init', async (req, res) => {
    const { id } = req.params;
    if (!sdrStates[id]) return res.status(404).json({ error: 'SDR not found' });

    try {
        await initSDR(id);
        io.emit('sdrUpdate', { id, state: sdrStates[id] });
        res.json({ success: true, state: sdrStates[id] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reconnect SDR
app.post('/api/sdrs/:id/reconnect', async (req, res) => {
    const { id } = req.params;
    if (!sdrStates[id]) return res.status(404).json({ error: 'SDR not found' });

    try {
        if (sdrConnections[id]) sdrConnections[id].end();
        await initSDR(id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Set gen_mode
app.post('/api/sdrs/:id/gen_mode', async (req, res) => {
    const { id } = req.params;
    const { value } = req.body; // Expect { value: 'manual' | 'slow_attack' }
    if (!sdrStates[id] || !['manual', 'slow_attack'].includes(value)) return res.status(400).json({ error: 'Invalid request' });
    if (!sdrStates[id].initialized) return res.status(400).json({ error: 'SDR not initialized' });

    try {
        await executeCommand(id, `iio_attr -c ad9361-phy voltage0 gain_control_mode ${value}`);
        await pollSDRState(id);
        io.emit('sdrUpdate', { id, state: sdrStates[id] });
        res.json({ success: true, state: sdrStates[id] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Set gain
app.post('/api/sdrs/:id/gain', async (req, res) => {
    const { id } = req.params;
    const { value } = req.body;
    if (!sdrStates[id] || typeof value !== 'number') return res.status(400).json({ error: 'Invalid request' });
    if (!sdrStates[id].initialized) return res.status(400).json({ error: 'SDR not initialized' });

    try {
        await executeCommand(id, `iio_attr -c ad9361-phy voltage0 hardwaregain ${value}`);
        await pollSDRState(id);
        io.emit('sdrUpdate', { id, state: sdrStates[id] });
        res.json({ success: true, state: sdrStates[id] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Set frequency
app.post('/api/sdrs/:id/freq', async (req, res) => {
    const { id } = req.params;
    const { value } = req.body;
    if (!sdrStates[id] || typeof value !== 'number') return res.status(400).json({ error: 'Invalid request' });
    if (!sdrStates[id].initialized) return res.status(400).json({ error: 'SDR not initialized' });

    try {
        await executeCommand(id, `iio_attr -c ad9361-phy altvoltage1 frequency ${value}`);
        await pollSDRState(id);
        io.emit('sdrUpdate', { id, state: sdrStates[id] });
        res.json({ success: true, state: sdrStates[id] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Set sampling frequency
app.post('/api/sdrs/:id/sampling_freq', async (req, res) => {
    const { id } = req.params;
    const { value } = req.body;
    if (!sdrStates[id] || typeof value !== 'number') return res.status(400).json({ error: 'Invalid request' });
    if (!sdrStates[id].initialized) return res.status(400).json({ error: 'SDR not initialized' });

    try {
        await executeCommand(id, `iio_attr -c ad9361-phy voltage0 sampling_frequency ${value}`);
        await pollSDRState(id);
        io.emit('sdrUpdate', { id, state: sdrStates[id] });
        res.json({ success: true, state: sdrStates[id] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Set mode
app.post('/api/sdrs/:id/set_mode', async (req, res) => {
    const { id } = req.params;
    const { mode } = req.body;
    if (!sdrStates[id] || !['wn', 'fsk', 'bpsk', 'qpsk', 'ntsc', 'none'].includes(mode)) return res.status(400).json({ error: 'Invalid request' });
    if (!sdrStates[id].initialized) return res.status(400).json({ error: 'SDR not initialized' });

    try {
        for (const gpio of Object.values(MODE_GPIOS)) {
            await executeCommand(id, `gpioset gpiochip0 ${gpio}=0`);
        }
        if (mode !== 'none') {
            await executeCommand(id, `gpioset gpiochip0 ${MODE_GPIOS[mode]}=1`);
        }
        const newModes = { wn: false, fsk: false, bpsk: false, qpsk: false, ntsc: false };
        if (mode !== 'none') newModes[mode] = true;
        sdrStates[id].modes = newModes;
        sdrStates[id].tx_on = mode !== 'none';
        if (mode === 'ntsc') {
            await executeCommand(id, 'iio_attr -c ad9361-phy voltage0 sampling_frequency 20000000');
        }
        await pollSDRState(id);
        io.emit('sdrUpdate', { id, state: sdrStates[id] });
        res.json({ success: true, state: sdrStates[id] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Restart USB for specific SDR
app.post('/ap/:id/restart_usb', async (req, res) => {
    const { id } = req.params;
    if (!SDR_BOARDS[id]) return res.status(404).json({ error: 'SDR not found' });

    const usbPort = SDR_BOARDS[id].usb_port;
    if (!usbPort) return res.status(400).json({ error: 'No USB port configured for this SDR' });

    try {
        exec(`sudo uhubctl -a cycle -l 1-1 -p ${usbPort}`, (err, stdout, stderr) => {
            if (err) throw new Error(`uhubctl failed: ${stderr}`);
            logger.info(`USB restart for SDR ${id} (port ${usbPort}): ${stdout}`);
            res.json({ success: true, output: stdout });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Handle SPA routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

// Socket.io
io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);
    socket.emit('initialStates', Object.entries(sdrStates).map(([id, state]) => ({id, ...state}))); // Send as array

    socket.on('disconnect', () => {
        logger.info(`Client disconnected: ${socket.id}`);
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
});