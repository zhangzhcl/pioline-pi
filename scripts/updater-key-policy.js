// ABOUTME: Enforce Pipline-owned identity for Tauri updater signing.

const inheritedPicotPublicKey = "RWThHFEQ+Yyd6SRkMecH9KYm3pc0rauF1uwlsnTJwYt0ExfrxjTkbUea";

export function decodeUpdaterPublicKey(value) {
  const normalized = value.trim().startsWith("untrusted comment:")
    ? value.trim()
    : Buffer.from(value.trim(), "base64").toString("utf8").trim();
  const lines = normalized.split(/\r?\n/);
  const [comment, key] = lines;
  const decodedKey = key ? Buffer.from(key, "base64") : null;
  if (
    !comment?.startsWith("untrusted comment: minisign public key:") ||
    lines.length !== 2 ||
    !key ||
    decodedKey?.length !== 42 ||
    decodedKey.toString("base64") !== key ||
    key === inheritedPicotPublicKey
  ) {
    throw new Error(
      key === inheritedPicotPublicKey
        ? "Replace the inherited Picot updater key with a Pipline-owned key before release."
        : "PIPLINE_UPDATER_PUBLIC_KEY is not a valid Pipline updater public key.",
    );
  }
  return normalized;
}
