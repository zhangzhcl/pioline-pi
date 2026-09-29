const { spawnSync } = require("node:child_process");
const path = require("node:path");

if (process.platform !== "darwin") process.exit(0);

const identity = process.env.APPLE_SIGNING_IDENTITY;
if (!identity || identity === "-") process.exit(0);

const scriptPath = path.join(__dirname, "sign-pi-resources.sh");
const result = spawnSync("bash", [scriptPath], {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(`[sign-pi-resources] ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
