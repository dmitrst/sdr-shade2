const fs = require('fs');
const crypto = require('crypto');

// Read serial from /proc/cpuinfo
const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
const serialLine = cpuInfo.split('\n').find(line => line.startsWith('Serial'));
const serial = serialLine ? serialLine.split(':')[1].trim() : '';

// Secret from env (set it first: export BINDING_SECRET=your_secret_here)
const secret = process.env.BINDING_SECRET || 'f87fd1374ae44f4ecbb072c1959dec13605b7b05711cbee9b4e3fadb702cf10a';

// Compute MD5
const hash = crypto.createHash('md5').update(serial + secret).digest('hex');

// Write to config.json
fs.writeFileSync('config.json', JSON.stringify({ key: hash }, null, 2));
console.log('config.json generated with key:', hash);