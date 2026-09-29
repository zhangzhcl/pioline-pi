// ABOUTME: Creates an SPDX entry for the separately bundled Node.js runtime.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PIN = JSON.parse(fs.readFileSync(path.join(__dirname, "node-runtime-version.json"), "utf8"));

function createNodeRuntimeSpdx(target, created = new Date()) {
  const arch = target === "darwin-arm64" ? "arm64" : target === "darwin-x64" ? "x64" : null;
  if (!arch) throw new Error(`Unsupported Node runtime SBOM target: ${target}`);
  const archive = `node-v${PIN.version}-darwin-${arch}.tar.gz`;
  const checksum = PIN.sha256?.[archive];
  if (!/^[a-f0-9]{64}$/i.test(checksum ?? ""))
    throw new Error(`Missing SHA-256 pin for ${archive}`);

  const nodeSpdxId = "SPDXRef-NodeJS";
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `Pipline bundled Node.js ${PIN.version} (${target})`,
    documentNamespace: `https://spdx.org/spdxdocs/pipline-node-runtime-${PIN.version}-${target}-${checksum.slice(0, 12)}`,
    creationInfo: {
      creators: ["Tool: Pipline Node Runtime SBOM Generator"],
      created: created.toISOString(),
    },
    packages: [
      {
        SPDXID: nodeSpdxId,
        name: "Node.js",
        versionInfo: PIN.version,
        downloadLocation: `${PIN.source}${archive}`,
        filesAnalyzed: false,
        licenseConcluded: "MIT",
        licenseDeclared: "MIT",
        copyrightText: "NOASSERTION",
        checksums: [{ algorithm: "SHA256", checksumValue: checksum }],
        externalRefs: [
          {
            referenceCategory: "PACKAGE-MANAGER",
            referenceType: "purl",
            referenceLocator: `pkg:generic/nodejs@${PIN.version}?arch=${arch}&os=darwin`,
          },
        ],
      },
    ],
    relationships: [
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relationshipType: "DESCRIBES",
        relatedSpdxElement: nodeSpdxId,
      },
    ],
  };
}

function writeNodeRuntimeSpdx(target) {
  const document = createNodeRuntimeSpdx(target);
  const destination = path.join(ROOT, `pipline-node-runtime-${target}-sbom.spdx.json`);
  fs.writeFileSync(destination, `${JSON.stringify(document, null, 2)}\n`);
  return destination;
}

if (require.main === module) {
  const target = process.argv[2];
  if (!target)
    throw new Error("Usage: node scripts/node-runtime-sbom.cjs <darwin-arm64|darwin-x64>");
  console.log(writeNodeRuntimeSpdx(target));
}

module.exports = { createNodeRuntimeSpdx, writeNodeRuntimeSpdx };
