import { describe, expect, it } from "vitest";
import { createNodeRuntimeSpdx } from "./node-runtime-sbom.cjs";

describe("bundled Node runtime SBOM", () => {
  it("describes the exact target archive as an MIT-licensed SPDX package", () => {
    const document = createNodeRuntimeSpdx("darwin-arm64");
    const node = document.packages[0];
    expect(document.spdxVersion).toBe("SPDX-2.3");
    expect(document.relationships).toContainEqual({
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: "SPDXRef-NodeJS",
    });
    expect(node).toMatchObject({
      SPDXID: "SPDXRef-NodeJS",
      name: "Node.js",
      versionInfo: "22.23.3",
      licenseDeclared: "MIT",
      downloadLocation: "https://nodejs.org/dist/v22.23.3/node-v22.23.3-darwin-arm64.tar.gz",
      checksums: [
        {
          algorithm: "SHA256",
          checksumValue: "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53",
        },
      ],
    });
  });

  it("rejects targets without a separately bundled Node runtime", () => {
    expect(() => createNodeRuntimeSpdx("windows-x64")).toThrow(/unsupported/i);
  });
});
