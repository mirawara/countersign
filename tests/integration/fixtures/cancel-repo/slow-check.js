const { spawn } = require("node:child_process");

spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
setInterval(() => {}, 600000);
