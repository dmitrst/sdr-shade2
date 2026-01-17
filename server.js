// server.js - Node.js backend for managing multiple PlutoSDR-like boards
// This sets up an Express server with REST API and Socket.io for real-time communication.
// It handles SSH connections to each SDR board for executing commands.
// Robust state management: We maintain a state object for each SDR, updated after commands and periodically polled.
// Assumptions:
// - All boards use the same credentials (root/analog, customizable).
// - SSH connections are managed per SDR, with reconnection on failure.
// - Key parameters: gain (hardwaregain), gen_mode (e.g., manual/auto for gain_control_mode), freq (frequency).
// - Additional commands can be added as needed.
// - Error handling and logging included for robustness.
// - Added initialization: Run essential enable/buffer commands on connection or via API.
// - Moved SDR_BOARDS to boards.json for easier configuration.
// - Enhanced Socket.io config to handle unstable clients: Adjusted ping intervals/timeouts.
// - Switched to 'rate-limiter-flexible' (recommended by Socket.io docs) for rate limiting to prevent spam/reconnect loops.
// - Added CORS middleware to allow cross-origin requests from frontend (e.g., if on different port).
// - Added retry logic to executeCommand (up to 3 retries with delay on failure).
// - Added connection locking to prevent race conditions in connectToSDR (using pending promise cache).
// - In initSDR, check current values before writing to avoid 'device busy' errors.
// - Added gen_mode set to 'manual' if 'slow_attack', gain default to 0.
// - Added modes polling and setting (using gpioset/gpioget, assuming base GPIO 54).
// - In initSDR, ensure TX off by setting all modes to 0.
// - Updated MODE_GPIOS with absolute values.
// - Added sampling_freq to state, poll, and set to 20000000 when NTSC mode is selected.
// - Removed all gpioget calls; use in-memory state for modes/tx_on (assume sets stick, no external changes).
// - Added endpoint for setting sampling_freq.
// - Added reconnect endpoint to force reconnection and re-init.
// - For production: Serve React build from /frontend/build, handle SPA routing.
// - Added /api/restart_usb endpoint to cycle power on USB hub ports 1-4 (hub 1-1) using uhubctl.
// - Assumes sudo uhubctl is allowed without password (configure sudoers.d).
// - Uses child_process.exec for uhubctl commands.

// Dependencies: Install with `npm install express socket.io ssh2 uuid winston rate-limiter-flexible cors path child_process`
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client } = require('ssh2');
const uuid = require('uuid');
const winston = require('winston');
const fs = require('fs'); // Added for reading boards.json
const { RateLimiterMemory } = require('rate-limiter-flexible'); // Added for connection rate limiting
const cors = require('cors'); // Added for CORS support
const path = require('path'); // For serving static files
const { exec } = require('child_process'); // Added for uhubctl commands

// Logger setup (set to 'warn' for connects/disconnects to reduce noise; use 'info' for detailed)
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'app.log' })
    ]
});

// Load SDR boards from boards.json
let SDR_BOARDS;
try {
    const data = fs.readFileSync('boards.json', 'utf8');
    SDR_BOARDS = JSON.parse(data);
    logger.info('Loaded SDR boards from boards.json');
} catch (err) {
    logger.error(`Failed to load boards.json: ${err.message}`);
    process.exit(1); // Exit if config fails to load
}

const SSH_CONFIG = {
    username: 'root',
    password: 'analog', // Use environment variable in production: process.env.SSH_PASSWORD
    hostVerification: false, // Equivalent to StrictHostKeyChecking=no
    knownHosts: '/dev/null', // Not directly supported, but we ignore host key
    algorithms: { serverHostKey: ['ssh-rsa', 'ssh-dss'] } // Adjust if needed
};

// Mode GPIO mappings from Verilog (absolute values)
const MODE_GPIOS = {
    wn: 71,    // White noise = 71
    fsk: 69,   // FSK noise = 69
    bpsk: 70,  // BPSK noise = 70
    qpsk: 64,  // QPSK noise = 64
    ntsc: 68   // NTSC = 68
};

// USB hub config for power cycle (hub 1-1, ports 1-4)
const USB_HUB = '1-1';
const USB_PORTS = [1, 2, 3, 4]; // Ports for the 4 PlutoSDRs (adjust if more hubs)

// State management: In-memory store for each SDR's state (gain, gen_mode, freq, status, modes)
let sdrStates = SDR_BOARDS.reduce((acc, board) => {
    acc[board.id] = {
        connected: false,
        initialized: false,
        gain: null,
        gen_mode: null,
        freq: null,
        sampling_freq: null, // New field
        modes: { wn: false, fsk: false, bpsk: false, qpsk: false, ntsc: false },
        tx_on: false,
        lastUpdated: null,
        error: null
    };
    return acc;
}, {});

// SSH connection pool: One persistent connection per SDR for efficiency
let sdrConnections = SDR_BOARDS.reduce((acc, board) => {
    acc[board.id] = null; // Will hold SSH Client instance
    return acc;
}, {});

// Pending connection promises to prevent race conditions
const pendingConnections = {};

// Function to connect or reconnect to an SDR via SSH (with locking)
function connectToSDR(sdrId) {
    if (pendingConnections[sdrId]) {
        return pendingConnections[sdrId]; // Return existing promise if connecting
    }

    const connectPromise = new Promise((resolve, reject) => {
        const board = SDR_BOARDS.find(b => b.id === sdrId);
        if (!board) return reject(new Error('Invalid SDR ID'));

        if (sdrConnections[sdrId] && sdrConnections[sdrId].ready) {
            return resolve(sdrConnections[sdrId]);
        }

        const conn = new Client();
        conn.on('ready', () => {
            logger.info(`SSH connected to ${sdrId} (${board.ip})`);
            sdrStates[sdrId].connected = true;
            sdrStates[sdrId].error = null;
            sdrConnections[sdrId] = conn;
            resolve(conn);
        }).on('error', (err) => {
            logger.error(`SSH error for ${sdrId}: ${err.message}`);
            sdrStates[sdrId].connected = false;
            sdrStates[sdrId].error = err.message;
            reject(err);
        }).on('end', () => {
            logger.info(`SSH connection ended for ${sdrId}`);
            sdrStates[sdrId].connected = false;
            sdrStates[sdrId].initialized = false;
            sdrConnections[sdrId] = null;
            delete pendingConnections[sdrId];
        }).on('close', () => {
            logger.info(`SSH connection closed for ${sdrId}`);
            sdrStates[sdrId].connected = false;
            sdrStates[sdrId].initialized = false;
            sdrConnections[sdrId] = null;
            delete pendingConnections[sdrId];
        });

        conn.connect({
            host: board.ip,
            port: 22,
            username: SSH_CONFIG.username,
            password: SSH_CONFIG.password,
            readyTimeout: 10000, // 10s timeout
            keepaliveInterval: 10000, // Keepalive to detect disconnections
            keepaliveCountMax: 3
        });
    });

    pendingConnections[sdrId] = connectPromise;
    return connectPromise;
}

// Function to execute a command on an SDR via SSH (with retries)
async function executeCommand(sdrId, command, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const conn = await connectToSDR(sdrId);
            return await new Promise((resolve, reject) => {
                conn.exec(command, (err, stream) => {
                    if (err) return reject(err);
                    let output = '';
                    let errorOutput = '';
                    stream.on('close', (code, signal) => {
                        if (code !== 0) {
                            reject(new Error(`Command failed with code ${code}: ${errorOutput}`));
                        } else {
                            resolve(output.trim());
                        }
                    }).on('data', (data) => {
                        output += data;
                    }).stderr.on('data', (data) => {
                        errorOutput += data;
                    });
                });
            });
        } catch (err) {
            logger.error(`Execute command attempt ${attempt} failed for ${sdrId}: ${err.message}`);
            sdrConnections[sdrId] = null; // Force reconnect on next try
            if (attempt === retries) {
                throw err; // Rethrow after last retry
            }
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff: 1s, 2s, 3s
        }
    }
}

// Helper to check current sysfs value
async function getSysfsValue(sdrId, path) {
    return await executeCommand(sdrId, `cat ${path}`);
}

// Function to initialize SDR with essential commands (check before write to avoid busy errors)
async function initSDR(sdrId) {
    try {
        const basePath = '/sys/bus/iio/devices/iio:device2';
        const scanPath = `${basePath}/scan_elements`;
        const bufferPath = `${basePath}/buffer`;

        // Check and set out_voltage0_en
        if (await getSysfsValue(sdrId, `${scanPath}/out_voltage0_en`) !== '1') {
            await executeCommand(sdrId, `echo 1 > ${scanPath}/out_voltage0_en`);
        }

        // Check and set out_voltage1_en
        if (await getSysfsValue(sdrId, `${scanPath}/out_voltage1_en`) !== '1') {
            await executeCommand(sdrId, `echo 1 > ${scanPath}/out_voltage1_en`);
        }

        // Check and set buffer/length
        if (await getSysfsValue(sdrId, `${bufferPath}/length`) !== '1024') {
            await executeCommand(sdrId, `echo 1024 > ${bufferPath}/length`);
        }

        // Check and set buffer/enable (if already enabled, disable first if needed)
        if (await getSysfsValue(sdrId, `${bufferPath}/enable`) !== '1') {
            await executeCommand(sdrId, `echo 1 > ${bufferPath}/enable`);
        }

        // Set gen_mode to manual and gain to 0
        await executeCommand(sdrId, 'iio_attr -c ad9361-phy voltage0 gain_control_mode manual');
        await executeCommand(sdrId, 'iio_attr -c ad9361-phy voltage0 hardwaregain 0');

        // Ensure TX off: Set all modes to 0
        for (const gpio of Object.values(MODE_GPIOS)) {
            await executeCommand(sdrId, `gpioset gpiochip0 ${gpio}=0`);
        }

        sdrStates[sdrId].modes = { wn: false, fsk: false, bpsk: false, qpsk: false, ntsc: false };
        sdrStates[sdrId].tx_on = false;
        sdrStates[sdrId].initialized = true;
        logger.info(`Initialized SDR ${sdrId}`);
        await pollSDRState(sdrId); // Poll after init
    } catch (err) {
        sdrStates[sdrId].initialized = false;
        logger.error(`Initialization failed for ${sdrId}: ${err.message}`);
        sdrStates[sdrId].error = err.message;
        throw err;
    }
}

// Function to update SDR state by polling current values (no mode polling, use memory)
async function pollSDRState(sdrId) {
    try {
        let gen_mode = await executeCommand(sdrId, 'iio_attr -c ad9361-phy voltage0 gain_control_mode');
        if (gen_mode === 'slow_attack') {
            await executeCommand(sdrId, 'iio_attr -c ad9361-phy voltage0 gain_control_mode manual');
            gen_mode = 'manual';
        }
        const gain = await executeCommand(sdrId, 'iio_attr -c ad9361-phy voltage0 hardwaregain');
        const freq = await executeCommand(sdrId, 'iio_attr -c ad9361-phy altvoltage1 frequency');
        const sampling_freq = await executeCommand(sdrId, 'iio_attr -c ad9361-phy voltage0 sampling_frequency');

        sdrStates[sdrId] = {
            ...sdrStates[sdrId],
            gain: parseInt(gain) || 0,
            gen_mode,
            freq: parseInt(freq) || null,
            sampling_freq: parseInt(sampling_freq) || null,
            lastUpdated: new Date().toISOString(),
            error: null
        };
        logger.info(`Polled state for ${sdrId}: ${JSON.stringify(sdrStates[sdrId])}`);
    } catch (err) {
        logger.error(`Poll failed for ${sdrId}: ${err.message}`);
        sdrStates[sdrId].error = err.message;
    }
}

// Periodic polling for all SDRs (every 30s, adjustable)
setInterval(() => {
    SDR_BOARDS.forEach(board => {
        if (sdrStates[board.id].connected && sdrStates[board.id].initialized) {
            pollSDRState(board.id);
        }
    });
}, 30000);

// Initial connections, init, and polling (make sequential to avoid races)
(async () => {
    for (const board of SDR_BOARDS) {
        try {
            await connectToSDR(board.id);
            await initSDR(board.id);
            await pollSDRState(board.id);
        } catch (err) {
            logger.error(`Initial setup failed for ${board.id}: ${err.message}`);
        }
    }
})();

// Express app setup
const app = express();
const server = http.createServer(app);

// Enable CORS for all routes (allows requests from frontend on different port/origin)
app.use(cors({
    origin: '*', // Allow all origins; restrict in production (e.g., 'http://localhost:3000')
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

const io = socketIo(server, {
    cors: { origin: '*' }, // Already set, but consistent with app cors
    pingInterval: 10000, // Send ping every 10s to detect dead clients
    pingTimeout: 5000, // Disconnect if no pong in 5s
    maxHttpBufferSize: 1e8 // Increase buffer for larger payloads if needed
});

// Rate limiting for Socket.io connections (prevents spam/reconnect loops)
// Using RateLimiterMemory: 10 points per IP, consume 1 per connection, refill every second
const rateLimiter = new RateLimiterMemory({
    points: 10, // Max 10 connections
    duration: 1, // Per second
});

io.use((socket, next) => {
    rateLimiter.consume(socket.handshake.address) // Consume based on IP
        .then(() => {
            next();
        })
        .catch(() => {
            logger.warn(`Rate limit exceeded for IP: ${socket.handshake.address}`);
            next(new Error('Too many connections - rate limit exceeded'));
        });
});

// Serve React production build (static files first)
app.use(express.static(path.join(__dirname, 'build')));

app.use(express.json());

// REST API Endpoints

// Get list of SDR boards
app.get('/api/sdrs', (req, res) => {
    res.json(SDR_BOARDS.map(board => ({
        ...board,
        state: sdrStates[board.id]
    })));
});

// Get state of a specific SDR
app.get('/api/sdrs/:id', (req, res) => {
    const { id } = req.params;
    if (!sdrStates[id]) return res.status(404).json({ error: 'SDR not found' });
    res.json({ ...SDR_BOARDS.find(b => b.id === id), state: sdrStates[id] });
});

// Initialize an SDR (runs the essential commands)
app.post('/api/sdrs/:id/init', async (req, res) => {
    const { id } = req.params;
    if (!sdrStates[id]) return res.status(404).json({ error: 'SDR not found' });

    try {
        await initSDR(id);
        io.emit('sdrUpdate', { id, state: sdrStates[id] }); // Broadcast update
        res.json({ success: true, state: sdrStates[id] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reconnect to an SDR (force reconnect and re-init)
app.post('/api/sdrs/:id/reconnect', async (req, res) => {
    const { id } = req.params;
    if (!sdrStates[id]) return res.status(404).json({ error: 'SDR not found' });

    try {
        sdrConnections[id] = null; // Force close current connection if any
        await connectToSDR(id);
        await initSDR(id);
        await pollSDRState(id);
        io.emit('sdrUpdate', { id, state: sdrStates[id] }); // Broadcast update
        res.json({ success: true, state: sdrStates[id] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Restart USB power for all SDRs (cycle power on hub 1-1 ports 1-4)
app.post('/api/restart_usb', async (req, res) => {
    try {
        // Power off all ports
        for (const port of USB_PORTS) {
            exec(`sudo uhubctl -l ${USB_HUB} -p ${port} -a off`, (err) => {
                if (err) logger.error(`USB off failed for port ${port}: ${err.message}`);
            });
        }
        // Wait 5 seconds
        await new Promise(resolve => setTimeout(resolve, 5000));
        // Power on all ports
        for (const port of USB_PORTS) {
            exec(`sudo uhubctl -l ${USB_HUB} -p ${port} -a on`, (err) => {
                if (err) logger.error(`USB on failed for port ${port}: ${err.message}`);
            });
        }
        // Re-init all SDRs after power cycle
        for (const board of SDR_BOARDS) {
            sdrConnections[board.id] = null;
            await connectToSDR(board.id);
            await initSDR(board.id);
            await pollSDRState(board.id);
        }
        io.emit('initialStates', sdrStates); // Broadcast full update
        res.json({ success: true });
    } catch (err) {
        logger.error(`USB restart failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Set gain for an SDR (ensure initialized first)
app.post('/api/sdrs/:id/gain', async (req, res) => {
    const { id } = req.params;
    const { value } = req.body; // Expect { value: number }
    if (!sdrStates[id] || typeof value !== 'number') return res.status(400).json({ error: 'Invalid request' });
    if (!sdrStates[id].initialized) return res.status(400).json({ error: 'SDR not initialized' });

    try {
        await executeCommand(id, `iio_attr -c ad9361-phy voltage0 hardwaregain ${value}`);
        await pollSDRState(id); // Update state after command
        io.emit('sdrUpdate', { id, state: sdrStates[id] }); // Broadcast update
        res.json({ success: true, state: sdrStates[id] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Set frequency
app.post('/api/sdrs/:id/freq', async (req, res) => {
    const { id } = req.params;
    const { value } = req.body; // Expect { value: number }
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
    const { value } = req.body; // Expect { value: number in Hz }
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

// New endpoint to set mode (exclusive, sets one to 1, others to 0)
app.post('/api/sdrs/:id/set_mode', async (req, res) => {
    const { id } = req.params;
    const { mode } = req.body; // Expect { mode: 'wn' | 'fsk' | 'bpsk' | 'qpsk' | 'ntsc' | 'none' }
    if (!sdrStates[id] || !['wn', 'fsk', 'bpsk', 'qpsk', 'ntsc', 'none'].includes(mode)) return res.status(400).json({ error: 'Invalid request' });
    if (!sdrStates[id].initialized) return res.status(400).json({ error: 'SDR not initialized' });

    try {
        // Set all to 0 first
        for (const gpio of Object.values(MODE_GPIOS)) {
            await executeCommand(id, `gpioset gpiochip0 ${gpio}=0`);
        }
        // Set the selected to 1 if not none
        if (mode !== 'none') {
            await executeCommand(id, `gpioset gpiochip0 ${MODE_GPIOS[mode]}=1`);
        }
        // Update memory state
        const newModes = { wn: false, fsk: false, bpsk: false, qpsk: false, ntsc: false };
        if (mode !== 'none') newModes[mode] = true;
        sdrStates[id].modes = newModes;
        sdrStates[id].tx_on = mode !== 'none';
        // Set sampling_frequency for NTSC
        if (mode === 'ntsc') {
            await executeCommand(id, 'iio_attr -c ad9361-phy voltage0 sampling_frequency 20000000');
        }
        await pollSDRState(id); // Update other states
        io.emit('sdrUpdate', { id, state: sdrStates[id] }); // Broadcast update
        res.json({ success: true, state: sdrStates[id] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Socket.io for real-time (with enhanced logging including socket.id)
io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);
    // Send initial states
    socket.emit('initialStates', sdrStates);

    socket.on('disconnect', () => {
        logger.info(`Client disconnected: ${socket.id}`);
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
});