import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const temporaryDirectories = new Set();
const testPublicKey =
  "untrusted comment: minisign public key: Pipline test fixture\n" +
  "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("Tauri release updater config", () => {
  it("writes a signed updater overlay for the selected Pipline repository", async () => {
    const temp = await mkdtemp(join(tmpdir(), "pipline-release-config-test-"));
    temporaryDirectories.add(temp);
    const scripts = join(temp, "scripts");
    const tauri = join(temp, "src-tauri");
    await Promise.all([mkdir(scripts), mkdir(tauri)]);
    const config = JSON.parse(await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
    config.plugins.updater.pubkey = testPublicKey;
    await Promise.all([
      writeFile(
        join(scripts, "write-tauri-release-config.js"),
        await readFile(join(root, "scripts", "write-tauri-release-config.js")),
      ),
      writeFile(
        join(scripts, "updater-key-policy.js"),
        await readFile(join(root, "scripts", "updater-key-policy.js")),
      ),
      writeFile(join(tauri, "tauri.conf.json"), `${JSON.stringify(config)}\n`),
    ]);

    const result = spawnSync(process.execPath, [join(scripts, "write-tauri-release-config.js")], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "owner/pipline-product",
        PIPLINE_UPDATER_PUBLIC_KEY: testPublicKey,
        TAURI_SIGNING_PRIVATE_KEY: "temporary-test-key-placeholder",
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(await readFile(join(tauri, "tauri.release.conf.json"), "utf8"))).toEqual({
      bundle: { createUpdaterArtifacts: true },
      plugins: {
        updater: {
          endpoints: [
            "https://github.com/owner/pipline-product/releases/latest/download/latest.json",
          ],
        },
      },
    });
  });

  it("rejects the inherited Picot key even when all release key variables are present", async () => {
    const temp = await mkdtemp(join(tmpdir(), "pipline-release-config-test-"));
    temporaryDirectories.add(temp);
    const scripts = join(temp, "scripts");
    const tauri = join(temp, "src-tauri");
    await Promise.all([mkdir(scripts), mkdir(tauri)]);
    const config = JSON.parse(await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
    const inheritedPublicKey = config.plugins.updater.pubkey;
    await Promise.all([
      writeFile(
        join(scripts, "write-tauri-release-config.js"),
        await readFile(join(root, "scripts", "write-tauri-release-config.js")),
      ),
      writeFile(
        join(scripts, "updater-key-policy.js"),
        await readFile(join(root, "scripts", "updater-key-policy.js")),
      ),
      writeFile(join(tauri, "tauri.conf.json"), `${JSON.stringify(config)}\n`),
    ]);

    const result = spawnSync(process.execPath, [join(scripts, "write-tauri-release-config.js")], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "owner/pipline-product",
        PIPLINE_UPDATER_PUBLIC_KEY: inheritedPublicKey,
        TAURI_SIGNING_PRIVATE_KEY: "temporary-test-key-placeholder",
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Replace the inherited Picot updater key",
    );
    await expect(readFile(join(tauri, "tauri.release.conf.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects release preparation before writing config when the updater private key is missing", async () => {
    const temp = await mkdtemp(join(tmpdir(), "pipline-release-config-test-"));
    temporaryDirectories.add(temp);
    const scripts = join(temp, "scripts");
    const tauri = join(temp, "src-tauri");
    await Promise.all([mkdir(scripts), mkdir(tauri)]);
    await Promise.all([
      writeFile(
        join(scripts, "write-tauri-release-config.js"),
        await readFile(join(root, "scripts", "write-tauri-release-config.js")),
      ),
      writeFile(
        join(scripts, "updater-key-policy.js"),
        await readFile(join(root, "scripts", "updater-key-policy.js")),
      ),
      writeFile(
        join(tauri, "tauri.conf.json"),
        await readFile(join(root, "src-tauri", "tauri.conf.json")),
      ),
    ]);

    const result = spawnSync(process.execPath, [join(scripts, "write-tauri-release-config.js")], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "owner/pipline",
        PIPLINE_UPDATER_PUBLIC_KEY: JSON.parse(
          await readFile(join(tauri, "tauri.conf.json"), "utf8"),
        ).plugins.updater.pubkey,
        TAURI_SIGNING_PRIVATE_KEY: "",
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("TAURI_SIGNING_PRIVATE_KEY");
    await expect(readFile(join(tauri, "tauri.release.conf.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects updater key-pair verification before invoking signing tools without a private key", () => {
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts", "verify-tauri-updater-keypair.js")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PIPLINE_UPDATER_PUBLIC_KEY: "untrusted comment: minisign public key:\nkey",
          TAURI_SIGNING_PRIVATE_KEY: "",
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("TAURI_SIGNING_PRIVATE_KEY");
  });
});
