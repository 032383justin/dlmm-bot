(async () => {
    console.log("════════════════════════════════════════════════════");
    console.log("🟢 DLMM BOT STARTUP");
    console.log("════════════════════════════════════════════════════");

    const { bootstrap } = require("./bootstrap");

    console.log("📦 Bootstrapping singletons…");
    await bootstrap();

    console.log("⚙️ Bootstrapping complete. Launching runtime…");

    // Delay 1–2 seconds to ensure registry is locked
    await new Promise(res => setTimeout(res, 1500));

    console.log("🚀 Importing runtime loop (index.js)");
    require("./index.js");
})();

