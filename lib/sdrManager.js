// lib/sdrManager.js
const { Client } = require('ssh2');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const logger = require('./logger');

const sdrConnections = {};
const sdrStates = {};
const connectionPromises = {};
const rateLimiter = new RateLimiterMemory({ points: 100, duration: 60 }); // 5 attempts per second per IP

let SDR_BOARDS; // Set from server.js

const SSH_CONFIG = {
    username: 'root',
    password: 'analog', // Use environment variable in production: process.env.SSH_PASSWORD
    hostVerification: false,
    knownHosts: '/dev/null',
    algorithms: { serverHostKey: ['ssh-rsa', 'ssh-dss'] }
};

// Mode GPIO mappings from Verilog (absolute values)
const MODE_GPIOS = {
    wn: 71,    // White noise = 71
    fsk: 69,   // FSK noise = 69
    bpsk: 70,  // BPSK noise = 70
    qpsk: 64,  // QPSK noise = 64
    ntsc: 68   // NTSC = 68
};

// Rate limiter middleware
function rateLimiterMiddleware(req, res, next) {
    rateLimiter.consume(req.ip)
        .then(() => {
            next();
        })
        .catch(() => {
            res.status(429).send('Too Many Requests');
        });
}

async function connectToSDR(id, host) {
    if (connectionPromises[id]) return connectionPromises[id];

    connectionPromises[id] = new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
            logger.info(`SSH connected to SDR ${id} at ${host}`);
            sdrConnections[id] = conn;
            resolve(conn);
        });
        conn.on('error', (err) => {
            logger.error(`SSH connection error for SDR ${id}: ${err.message}`);
            delete connectionPromises[id];
            reject(err);
        });
        conn.on('close', () => {
            logger.warn(`SSH connection closed for SDR ${id}`);
            delete sdrConnections[id];
            delete connectionPromises[id];
        });
        conn.connect({ ...SSH_CONFIG, host });
    });

    return connectionPromises[id];
}

async function executeCommand(id, command, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const conn = await connectToSDR(id, SDR_BOARDS[id].host);
            return new Promise((resolve, reject) => {
                conn.exec(command, (err, stream) => {
                    if (err) return reject(err);
                    let output = '';
                    stream.on('data', (data) => output += data.toString());
                    stream.stderr.on('data', (data) => output += data.toString());
                    stream.on('close', (code) => {
                        if (code !== 0) reject(new Error(`Command '${command}' failed with code ${code}: ${output}`));
                        else resolve(output.trim());
                    });
                });
            });
        } catch (err) {
            logger.warn(`Execute command attempt ${attempt} failed for SDR ${id}: ${err.message}`);
            if (attempt === retries) throw err;
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
    }
}

async function pollSDRState(id) {
    try {
        const gain = parseFloat(await executeCommand(id, 'iio_attr -c ad9361-phy voltage0 hardwaregain'));
        const gen_mode = await executeCommand(id, 'iio_attr -c ad9361-phy voltage0 gain_control_mode');
        const freq = parseInt(await executeCommand(id, 'iio_attr -c ad9361-phy altvoltage1 frequency'));
        const sampling_freq = parseInt(await executeCommand(id, 'iio_attr -c ad9361-phy voltage0 sampling_frequency'));
        sdrStates[id] = {
            ...sdrStates[id],
            gain,
            gen_mode,
            freq,
            sampling_freq
        };
    } catch (err) {
        logger.error(`Poll state failed for SDR ${id}: ${err.message}`);
        throw err;
    }
}

async function initSDR(id) {
    if (sdrStates[id].initialized) return;

    try {
        // Ensure TX off
        for (const gpio of Object.values(MODE_GPIOS)) {
            await executeCommand(id, `gpioset gpiochip0 ${gpio}=0`);
        }

        // Set defaults
        const currentGenMode = await executeCommand(id, 'iio_attr -c ad9361-phy voltage0 gain_control_mode');
        if (currentGenMode !== 'manual') {
            await executeCommand(id, 'iio_attr -c ad9361-phy voltage0 gain_control_mode manual');
        }
        const currentGain = parseFloat(await executeCommand(id, 'iio_attr -c ad9361-phy voltage0 hardwaregain'));
        if (currentGain !== 0) {
            await executeCommand(id, 'iio_attr -c ad9361-phy voltage0 hardwaregain 0');
        }

        // Other init commands...
        await executeCommand(id, 'iio_reg ad9361-phy 0x173 0x3F'); // Enable TX
        await executeCommand(id, 'iio_reg ad9361-phy 0x174 0x3F'); // Enable TX buffer

        sdrStates[id] = {
            connected: true,
            initialized: true,
            gain: 0,
            gen_mode: 'manual',
            freq: 0,
            sampling_freq: 0,
            modes: { wn: false, fsk: false, bpsk: false, qpsk: false, ntsc: false },
            tx_on: false
        };
        await pollSDRState(id);
        logger.info(`SDR ${id} initialized`);
    } catch (err) {
        logger.error(`Init failed for SDR ${id}: ${err.message}`);
        throw err;
    }
}

module.exports = {
    sdrStates,
    rateLimiterMiddleware,
    connectToSDR,
    executeCommand,
    pollSDRState,
    initSDR,
    MODE_GPIOS,
    setSDRBoards: function(boards) {
        SDR_BOARDS = boards;
    }
};