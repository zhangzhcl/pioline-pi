const fs = require("node:fs");
const https = require("node:https");

function downloadPiAsset(url, destination, dependencies = {}) {
  const httpsGet = dependencies.httpsGet ?? https.get;
  const createWriteStream = dependencies.createWriteStream ?? fs.createWriteStream;
  const maxRedirects = dependencies.maxRedirects ?? 10;

  function request(currentUrl, redirectCount) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let file = null;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        if (file) {
          const removePartial = () => fs.unlink(destination, () => reject(error));
          if (file.closed) removePartial();
          else {
            file.once("close", removePartial);
            file.destroy();
          }
          return;
        }
        reject(error);
      };
      let parsedUrl;
      try {
        parsedUrl = new URL(currentUrl);
        if (parsedUrl.protocol !== "https:")
          throw new Error("Pi download redirects must use HTTPS");
      } catch (error) {
        fail(error);
        return;
      }

      let requestHandle;
      try {
        requestHandle = httpsGet(
          parsedUrl,
          { headers: { "User-Agent": "pipline-fetch" } },
          (response) => {
            const location = response.headers.location;
            if (response.statusCode >= 300 && response.statusCode < 400 && location) {
              response.resume();
              if (redirectCount >= maxRedirects) {
                fail(new Error(`Too many redirects while downloading ${parsedUrl.href}`));
                return;
              }
              let redirectedUrl;
              try {
                redirectedUrl = new URL(location, parsedUrl).href;
              } catch (error) {
                fail(error);
                return;
              }
              request(redirectedUrl, redirectCount + 1).then(resolve, reject);
              return;
            }
            if (response.statusCode !== 200) {
              response.resume();
              fail(new Error(`HTTP ${response.statusCode} for ${parsedUrl.href}`));
              return;
            }

            try {
              file = createWriteStream(destination);
            } catch (error) {
              response.resume();
              fail(error);
              return;
            }
            response.on("aborted", () =>
              fail(new Error(`Download response aborted for ${parsedUrl.href}`)),
            );
            response.on("error", fail);
            file.on("error", fail);
            file.on("finish", () => {
              file.close((error) => {
                if (error) {
                  fail(error);
                  return;
                }
                if (settled) return;
                settled = true;
                resolve();
              });
            });
            response.pipe(file);
          },
        );
        requestHandle.on("error", fail);
      } catch (error) {
        fail(error);
      }
    });
  }

  return request(url, 0);
}

module.exports = { downloadPiAsset };
