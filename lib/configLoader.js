// lib/configLoader.js
const fs = require('fs');
const logger = require('./logger');

module.exports = {
    loadBoards: function() {
        let SDR_BOARDS;
        try {
            const data = fs.readFileSync('boards.json', 'utf8');
            const boardsArray = JSON.parse(data);
            SDR_BOARDS = boardsArray.reduce((acc, board) => {
                acc[board.id] = { ip: board.ip, name: board.name, usb_port: board.usb_port }; // Rename 'ip' to 'host' for consistency
                return acc;
            }, {});
            logger.info('Loaded SDR boards from boards.json');
        } catch (err) {
            logger.error(`Failed to load boards.json: ${err.message}`);
            process.exit(1);
        }
        return SDR_BOARDS;
    }
};