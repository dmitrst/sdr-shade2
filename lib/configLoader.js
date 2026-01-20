// lib/configLoader.js
const fs = require('fs');
const logger = require('./logger');

module.exports = {
    loadBoards: function() {
        let SDR_BOARDS;
        try {
            const data = fs.readFileSync('boards.json', 'utf8');
            SDR_BOARDS = JSON.parse(data);
            logger.info('Loaded SDR boards from boards.json');
        } catch (err) {
            logger.error(`Failed to load boards.json: ${err.message}`);
            process.exit(1);
        }
        return SDR_BOARDS;
    }
};