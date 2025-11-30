(async () => {
    console.log("🔧 Bootstrapping DLMM engine...");
    const { bootstrap } = require("./bootstrap");
    await bootstrap();

    console.log("🚀 Launching runtime loop...");
    require("./index");

    console.log("🟢 Bot runtime active — blocking main thread");
    setInterval(() => {}, 1 << 30); // prevents Node from exiting
})();
