(async () => {
    console.log("🔧 Bootstrapping DLMM engine...");
    const { bootstrap, startRuntime } = require("./bootstrap");

    // STEP 1 — Bootstrap
    const { engine } = await bootstrap();

    // STEP 2 — Start runtime loop (uses the engine created above)
    console.log("🚀 Launching runtime loop...");
    await startRuntime(engine);

    // STEP 3 — Block process to prevent PM2 restart
    console.log("🟢 Bot runtime active — blocking main thread");
    setInterval(() => {}, 1 << 30);
})();

