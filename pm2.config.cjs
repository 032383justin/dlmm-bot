module.exports = {
    apps: [
        {
            name: "dlmm-bot",
            script: "./dist/start.js",
            watch: false,
            env: {
                NODE_ENV: "production",
            },
            env_dev: {
                NODE_ENV: "development",
            },
        },
    ],
};
