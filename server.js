// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const uuid = require('uuid');
const cors = require('cors');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const validateDeviceBinding = require('./lib/deviceBinding');
const { loadBoards } = require('./lib/configLoader');
const { sdrStates, rateLimiterMiddleware, initSDR, executeCommand, pollSDRState, MODE_GPIOS, setSDRBoards } = require('./lib/sdrManager');
const logger = require('./lib/logger');

// Validate device binding first
validateDeviceBinding();

// Load SDR boards
const SDR_BOARDS = loadBoards();
setSDRBoards(SDR_BOARDS);

// Relay GPIO pins from Waveshare RPi Relay Board wiki
const RELAY_GPIOS = [26, 20, 21]; // Relay1:26, Relay2:20, Relay3:21

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

// Initialize relays to off on startup
updateRelays().catch(err => logger.error(`Startup relay init failed: ${err.message}`));

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

// Reconnect SDR (now with per-port USB cycle)
app.post('/api/sdrs/:id/reconnect', async (req, res) => {
    const { id } = req.params;
    if (!sdrStates[id]) return res.status(404).json({ error: 'SDR not found' });

    try {
        // Cycle USB port for this SDR
        await restartUsbPort(id);

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

// Set mode (updated with relay control)
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

        // Update local relays based on new TX state
        await updateRelays();

        res.json({ success: true, state: sdrStates[id] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Restart USB hub (global, unchanged)
app.post('/api/restart_usb', async (req, res) => {
    try {
        const { stdout, stderr } = await execPromise('sudo uhubctl -a cycle -l 1-1 -p 1-4');
        if (stderr) throw new Error(`uhubctl failed: ${stderr}`);
        logger.info(`USB restart: ${stdout}`);
        res.json({ success: true, output: stdout });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sdrs/:id/restart_usb', async (req, res) => {
    const { id } = req.params;
    if (!sdrStates[id]) return res.status(404).json({ error: 'SDR not found' });
    try {
        // Customize uhubctl per SDR (e.g., map ID to specific port; example assumes port based on ID)
        const port = parseInt(id.replace('sdr', '')); // e.g., sdr1 -> port 1
        exec(`sudo uhubctl -a cycle -l 1-1 -p ${port}`, (err, stdout, stderr) => {
            if (err) throw new Error(`uhubctl failed: ${stderr}`);
            logger.info(`USB restart for ${id}: ${stdout}`);
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

// Helper: Restart specific USB port for an SDR
async function restartUsbPort(id) {
    const port = SDR_BOARDS[id].usb_port;
    if (!port) {
        logger.warn(`No usb_port defined for SDR ${id}, skipping USB cycle`);
        return;
    }
    try {
        const { stdout, stderr } = await execPromise(`sudo uhubctl -a cycle -l 1-1 -p ${port}`);
        if (stderr) throw new Error(`uhubctl failed for port ${port}: ${stderr}`);
        logger.info(`USB restart for SDR ${id} on port ${port}: ${stdout}`);
    } catch (err) {
        logger.error(`USB restart failed for SDR ${id}: ${err.message}`);
        throw err; // Re-throw to handle in caller
    }
}

// Helper: Set a single relay using pinctrl (active-low: dl=ON, dh=OFF)
async function setRelay(relayIndex, state) {
    const gpio = RELAY_GPIOS[relayIndex];
    const level = state ? 'dl' : 'dh'; // dl (low/0) = ON, dh (high/1) = OFF
    try {
        const { stderr } = await execPromise(`sudo pinctrl set ${gpio} op ${level}`);
        if (stderr) throw new Error(stderr);
    } catch (err) {
        throw new Error(`Failed to set relay ${relayIndex + 1} (GPIO ${gpio}) to ${state}: ${err.message}`);
    }
}

// Helper: Update all relays based on active SDRs (OR the relay states)
async function updateRelays() {
    const required = Array(3).fill(0);
    Object.entries(sdrStates).forEach(([id, state]) => {
        if (state.tx_on && SDR_BOARDS[id]?.relays && SDR_BOARDS[id].relays.length === 3) {
            SDR_BOARDS[id].relays.forEach((val, idx) => {
                if (val === 1) required[idx] = 1;
            });
        }
    });

    for (let i = 0; i < 3; i++) {
        try {
            await setRelay(i, required[i]);
            logger.info(`Set relay ${i + 1} to ${required[i]}`);
        } catch (err) {
            logger.error(err.message);
        }
    }
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
});