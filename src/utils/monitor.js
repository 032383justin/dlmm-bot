"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var fs_1 = require("fs");
var path_1 = require("path");
var logFile = path_1.default.join(__dirname, '../../combined.log');
console.log('--- DLMM Bot Monitor ---');
console.log("Reading logs from: ".concat(logFile));
console.log('Waiting for new logs...\n');
var fileSize = 0;
try {
    fileSize = fs_1.default.statSync(logFile).size;
}
catch (e) {
    // File might not exist yet
}
var processLine = function (line) {
    if (!line.trim())
        return;
    try {
        var log = JSON.parse(line);
        var time = new Date(log.timestamp).toLocaleTimeString();
        var level = log.level.toUpperCase();
        var msg = log.message;
        // Colorize based on level (basic ANSI)
        var color = '\x1b[37m'; // White
        if (level === 'ERROR')
            color = '\x1b[31m'; // Red
        if (level === 'WARN')
            color = '\x1b[33m'; // Yellow
        if (level === 'INFO')
            color = '\x1b[36m'; // Cyan
        console.log("".concat(color, "[").concat(time, "] [").concat(level, "] ").concat(msg, "\u001B[0m"));
        if (log.pools) {
            // Pretty print pools array
            console.log('\x1b[32m', log.pools.join('\n '), '\x1b[0m');
        }
        else if (log.details) {
            console.log('\x1b[90m', JSON.stringify(log.details, null, 2), '\x1b[0m');
        }
    }
    catch (e) {
        // console.log(line); // Print raw if not JSON
    }
};
// Watch for changes
fs_1.default.watchFile(logFile, { interval: 1000 }, function (curr, prev) {
    if (curr.size > prev.size) {
        var stream = fs_1.default.createReadStream(logFile, {
            start: prev.size,
            end: curr.size,
        });
        stream.on('data', function (chunk) {
            var lines = chunk.toString().split('\n');
            lines.forEach(processLine);
        });
    }
});
