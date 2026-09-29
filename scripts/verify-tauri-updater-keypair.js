import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeUpdaterPublicKey } from "./updater-key-policy.js";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const privateKey = process.env.TAURI_SIGNING_PRIVATE_KEY;
const encodedPublicKey = process.env.PIPLINE_UPDATER_PUBLIC_KEY;
if (typeof privateKey !== "string" || !privateKey.trim()) {
  throw new Error(
    "Set the GitHub Actions secret TAURI_SIGNING_PRIVATE_KEY before key-pair verification.",
  );
}
if (typeof encodedPublicKey !== "string" || !encodedPublicKey.trim()) {
  throw new Error(
    "Set the GitHub Actions variable PIPLINE_UPDATER_PUBLIC_KEY before key-pair verification.",
  );
}

const decodedPublicKey = decodeUpdaterPublicKey(encodedPublicKey);

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pipline-updater-key-check-"));
try {
  const publicKeyPath = join(temporaryDirectory, "updater.pub");
  const payloadPath = join(temporaryDirectory, "key-pair-check.txt");
  const signaturePath = `${payloadPath}.sig`;
  await Promise.all([
    writeFile(publicKeyPath, `${decodedPublicKey}\n`, "utf8"),
    writeFile(payloadPath, "Pipline updater key-pair validation v1\n", "utf8"),
  ]);

  const signer = spawnSync("bun", ["run", "tauri", "signer", "sign", payloadPath], {
    cwd: repoRoot,
    env: process.env,
    stdio: "ignore",
  });
  if (signer.error || signer.status !== 0) {
    throw new Error("Tauri could not sign the updater key-pair validation payload.");
  }
  await access(signaturePath);

  const verifierManifest = join(repoRoot, "scripts", "updater-key-verifier", "Cargo.toml");
  const verifierEnvironment = {
    ...process.env,
    CARGO_TARGET_DIR: join(repoRoot, "target", "updater-key-verifier"),
  };
  delete verifierEnvironment.TAURI_SIGNING_PRIVATE_KEY;
  delete verifierEnvironment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  const verifier = spawnSync(
    "cargo",
    [
      "run",
      "--quiet",
      "--locked",
      "--manifest-path",
      verifierManifest,
      "--",
      publicKeyPath,
      payloadPath,
      signaturePath,
    ],
    {
      cwd: repoRoot,
      env: verifierEnvironment,
      stdio: "ignore",
    },
  );
  if (verifier.error || verifier.status !== 0) {
    throw new Error("TAURI_SIGNING_PRIVATE_KEY does not match PIPLINE_UPDATER_PUBLIC_KEY.");
  }
  console.log("[updater-key] signing private key matches the configured public key");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
