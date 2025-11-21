import fs from 'fs';
import path from 'path';

const logFile = path.join(__dirname, '../../combined.log');

console.log('--- DLMM Bot Monitor ---');
console.log(`Reading logs from: ${logFile}`);
console.log('Waiting for new logs...\n');

let fileSize = 0;

try {
    fileSize = fs.statSync(logFile).size;
} catch (e) {
    // File might not exist yet
}

const processLine = (line: string) => {
    if (!line.trim()) return;
    try {
        const log = JSON.parse(line);
        const time = new Date(log.timestamp).toLocaleTimeString();
        const level = log.level.toUpperCase();
        const msg = log.message;

        // Colorize based on level (basic ANSI)
        let color = '\x1b[37m'; // White
        if (level === 'ERROR') color = '\x1b[31m'; // Red
        if (level === 'WARN') color = '\x1b[33m'; // Yellow
        if (level === 'INFO') color = '\x1b[36m'; // Cyan

        console.log(`${color}[${time}] [${level}] ${msg}\x1b[0m`);

        if (log.pools) {
            // Pretty print pools array
            console.log('\x1b[32m', log.pools.join('\n '), '\x1b[0m');
        } else if (log.details) {
            console.log('\x1b[90m', JSON.stringify(log.details, null, 2), '\x1b[0m');
        }
    } catch (e) {
        // console.log(line); // Print raw if not JSON
    }
};

// Watch for changes
fs.watchFile(logFile, { interval: 1000 }, (curr, prev) => {
    if (curr.size > prev.size) {
        const stream = fs.createReadStream(logFile, {
            start: prev.size,
            end: curr.size,
        });
        stream.on('data', (chunk) => {
            const lines = chunk.toString().split('\n');
            lines.forEach(processLine);
        });
    }
});
