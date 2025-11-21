module.exports = {
    apps: [
        {
            name: "dlmm-bot",
            script: "./dist/index.js",
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
