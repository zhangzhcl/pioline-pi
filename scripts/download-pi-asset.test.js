import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { downloadPiAsset } from "./download-pi-asset.cjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("Pi release asset download", () => {
  it("opens the destination only after following a redirect to the payload", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pipline-pi-download-"));
    temporaryDirectories.push(directory);
    const destination = path.join(directory, "pi.zip");
    const requests = [];
    let openedFiles = 0;
    const httpsGet = (url, _options, onResponse) => {
      const request = new EventEmitter();
      requests.push(String(url));
      queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = requests.length === 1 ? 302 : 200;
        response.headers = requests.length === 1 ? { location: "https://cdn.example/pi.zip" } : {};
        onResponse(response);
        response.end(requests.length === 1 ? "" : "pi-archive");
      });
      return request;
    };

    await downloadPiAsset("https://github.example/pi.zip", destination, {
      httpsGet,
      createWriteStream: (...args) => {
        openedFiles += 1;
        return fs.createWriteStream(...args);
      },
    });

    expect(requests).toEqual(["https://github.example/pi.zip", "https://cdn.example/pi.zip"]);
    expect(openedFiles).toBe(1);
    expect(fs.readFileSync(destination, "utf8")).toBe("pi-archive");
  });
});
