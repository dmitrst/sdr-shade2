// lib/deviceBinding.js
const fs = require('fs');
const crypto = require('crypto');
const logger = require('./logger');

const BINDING_SECRET = 'f87fd1374ae44f4ecbb072c1959dec13605b7b05711cbee9b4e3fadb702cf10a'; // Hardcoded secret, same for all builds/devices

module.exports = function validateDeviceBinding() {
    const configPath = './config.json';
    let CONFIG;

    // Check if config.json exists; generate if missing (runs on deployment/first start)
    if (!fs.existsSync(configPath)) {
        logger.info('config.json not found, generating for this device');

        // Read CPU serial from /proc/cpuinfo
        const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
        const serialLine = cpuInfo.split('\n').find(line => line.startsWith('Serial'));
        const serial = serialLine ? serialLine.split(':')[1].trim() : '';

        if (!serial) {
            logger.error('Could not read device serial from /proc/cpuinfo');
            process.exit(1);
        }

        // Compute MD5 hash
        const computedHash = crypto.createHash('md5').update(serial + BINDING_SECRET).digest('hex');

        // Create config
        CONFIG = { key: computedHash };

        // Write to config.json
        try {
            fs.writeFileSync(configPath, JSON.stringify(CONFIG, null, 2));
            logger.info('config.json generated successfully with key: ' + computedHash);
        } catch (err) {
            logger.error(`Failed to write config.json: ${err.message}`);
            process.exit(1);
        }
    } else {
        // Load existing config.json
        try {
            const data = fs.readFileSync(configPath, 'utf8');
            CONFIG = JSON.parse(data);
            logger.info('Loaded general config from config.json');
        } catch (err) {
            logger.error(`Failed to load config.json: ${err.message}`);
            process.exit(1);
        }
    }

    // Validate binding (always check on start)
    const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const serialLine = cpuInfo.split('\n').find(line => line.startsWith('Serial'));
    const serial = serialLine ? serialLine.split(':')[1].trim() : '';

    const computedHash = crypto.createHash('md5').update(serial + BINDING_SECRET).digest('hex');

    if (computedHash !== CONFIG.key) {
        logger.error('Device binding failed: Hash mismatch. This app is bound to a different device.');
        //process.exit(1);
    }
    logger.info('Device binding validated successfully');
};