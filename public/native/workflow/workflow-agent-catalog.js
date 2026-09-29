// ABOUTME: Keeps Agent catalog operations on the Host-authoritative template revision.

export async function refreshWorkflowCatalogForAgent(refreshNodeMetaCatalog) {
  try {
    await refreshNodeMetaCatalog();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
