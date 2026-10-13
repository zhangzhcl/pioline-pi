// ABOUTME: Owns per-window owner identity, bearer capability validation, and the
// ABOUTME: exact-origin navigation boundary for capability-bearing WebViews.

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::path::PathBuf;
#[cfg(test)]
use std::sync::{Arc, Mutex};
#[cfg(test)]
use std::time::{Duration, Instant};

#[cfg(test)]
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
#[cfg(test)]
use rand::rngs::OsRng;
#[cfg(test)]
use rand::RngCore;

#[cfg(test)]
mod tests;

#[cfg(test)]
const CAPABILITY_LEN: usize = 32;
const OWNER_ID_LEN: usize = 16;

/// Opaque per-window owner identity. Distinct from the bearer capability.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct OwnerId(String);

impl OwnerId {
    /// Derive a non-secret, stable owner partition from a desktop window's
    /// session-scoped client id. The v2 Host keeps the raw client id private.
    pub(crate) fn from_client_id(client_id: &str) -> Self {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(client_id.as_bytes());
        Self(hex_encode(&digest[..OWNER_ID_LEN]))
    }
}

/// Shared registry of window owners, their capabilities, and navigation permits.
#[cfg(test)]
#[derive(Clone, Default)]
pub struct WindowOwnerRegistry {
    inner: Arc<Mutex<RegistryState>>,
}

#[cfg(test)]
#[derive(Default)]
struct RegistryState {
    owners: HashMap<OwnerId, OwnerRecord>,
    capability_index: HashMap<[u8; CAPABILITY_LEN], OwnerId>,
    next_generation: u64,
}

#[cfg(test)]
struct OwnerRecord {
    window_label: String,
    canonical_cwd: PathBuf,
    primary_port: u16,
    current_origin: String,
    pending: Option<PendingNavigation>,
    transition: Option<WorkspaceTransition>,
    capability_bytes: [u8; CAPABILITY_LEN],
    workspace_generation: u64,
}

#[cfg(test)]
struct PendingNavigation {
    origin: String,
    target_port: u16,
    target_cwd: PathBuf,
    transition_generation: u64,
    expires_at: Instant,
    consumed: bool,
}

#[cfg(test)]
struct WorkspaceTransition {
    generation: u64,
    target_cwd: PathBuf,
    target_port: u16,
}

impl OwnerId {
    #[cfg(test)]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[cfg(test)]
    pub(crate) fn from_string(value: String) -> Self {
        Self(value)
    }
}

#[cfg(test)]
impl WindowOwnerRegistry {
    pub fn create_owner(
        &self,
        window_label: String,
        canonical_cwd: PathBuf,
        primary_port: u16,
        current_origin: &str,
    ) -> Result<(OwnerId, String), String> {
        let origin = normalize_origin(current_origin)
            .ok_or_else(|| "owner origin must be an http loopback Pi origin".to_string())?;

        let mut state = self.inner.lock().expect("owner registry lock poisoned");
        if state
            .owners
            .values()
            .any(|r| r.window_label == window_label)
        {
            return Err("window label is already owned".to_string());
        }

        let mut capability_bytes = [0u8; CAPABILITY_LEN];
        OsRng.fill_bytes(&mut capability_bytes);
        let mut id_bytes = [0u8; OWNER_ID_LEN];
        OsRng.fill_bytes(&mut id_bytes);

        let owner_id = OwnerId(hex_encode(&id_bytes));
        let capability = URL_SAFE_NO_PAD.encode(capability_bytes);
        state
            .capability_index
            .insert(capability_bytes, owner_id.clone());
        state.owners.insert(
            owner_id.clone(),
            OwnerRecord {
                window_label,
                canonical_cwd,
                primary_port,
                current_origin: origin,
                pending: None,
                transition: None,
                capability_bytes,
                workspace_generation: 0,
            },
        );
        Ok((owner_id, capability))
    }

    pub fn authenticate(&self, capability: &str) -> Option<OwnerId> {
        let decoded = URL_SAFE_NO_PAD.decode(capability).ok()?;
        if decoded.len() != CAPABILITY_LEN {
            return None;
        }
        let mut bytes = [0u8; CAPABILITY_LEN];
        bytes.copy_from_slice(&decoded);

        let state = self.inner.lock().expect("owner registry lock poisoned");
        state.capability_index.get(&bytes).cloned()
    }

    pub fn prepare_navigation(
        &self,
        owner: &OwnerId,
        port: u16,
        canonical_cwd: PathBuf,
        origin: &str,
        ttl: Duration,
    ) -> Result<u64, String> {
        let origin = normalize_origin(origin)
            .ok_or_else(|| "navigation origin must be an http loopback Pi origin".to_string())?;
        let mut state = self.inner.lock().expect("owner registry lock poisoned");
        let transition_gen = state
            .owners
            .get(owner)
            .ok_or_else(|| "unknown owner".to_string())?
            .transition
            .as_ref()
            .map(|t| t.generation);
        let generation = match transition_gen {
            Some(g) => g,
            None => {
                state.next_generation += 1;
                state.next_generation
            }
        };
        let record = state
            .owners
            .get_mut(owner)
            .ok_or_else(|| "unknown owner".to_string())?;
        record.pending = Some(PendingNavigation {
            origin,
            target_port: port,
            target_cwd: canonical_cwd,
            transition_generation: generation,
            expires_at: Instant::now() + ttl,
            consumed: false,
        });
        drop(state);
        Ok(generation)
    }

    pub fn authorize_navigation(&self, owner: &OwnerId, url: &tauri::Url) -> bool {
        let Some(origin) = url_origin(url) else {
            return false;
        };
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        let Some(record) = state.owners.get_mut(owner) else {
            return false;
        };
        if origin == record.current_origin {
            return true;
        }
        if let Some(pending) = record.pending.as_mut() {
            if !pending.consumed && Instant::now() < pending.expires_at && origin == pending.origin
            {
                pending.consumed = true;
                return true;
            }
        }
        false
    }

    pub fn begin_workspace_transition(
        &self,
        owner: &OwnerId,
        target_cwd: PathBuf,
        target_port: u16,
    ) -> Result<u64, String> {
        let mut state = self.inner.lock().expect("owner registry lock poisoned");
        if state
            .owners
            .get(owner)
            .ok_or_else(|| "unknown owner".to_string())?
            .transition
            .is_some()
        {
            return Err("a workspace transition is already in progress".to_string());
        }
        state.next_generation += 1;
        let generation = state.next_generation;
        let record = state
            .owners
            .get_mut(owner)
            .ok_or_else(|| "unknown owner".to_string())?;
        record.transition = Some(WorkspaceTransition {
            generation,
            target_cwd,
            target_port,
        });
        Ok(generation)
    }

    pub fn commit_workspace_transition(
        &self,
        owner: &OwnerId,
        transition_generation: u64,
        target_origin: &str,
    ) -> Result<(), String> {
        let target = normalize_origin(target_origin)
            .ok_or_else(|| "commit origin must be an http loopback Pi origin".to_string())?;
        let mut state = self.inner.lock().expect("owner registry lock poisoned");
        let record = state
            .owners
            .get_mut(owner)
            .ok_or_else(|| "unknown owner".to_string())?;

        let (target_port, new_cwd) = {
            let pending = record
                .pending
                .as_ref()
                .ok_or_else(|| "no pending navigation permit to commit".to_string())?;
            if pending.transition_generation != transition_generation {
                return Err("transition generation mismatch".to_string());
            }
            if pending.origin != target {
                return Err("commit origin does not match the prepared permit".to_string());
            }
            let new_cwd = record
                .transition
                .as_ref()
                .filter(|t| {
                    t.generation == transition_generation && t.target_port == pending.target_port
                })
                .map(|t| t.target_cwd.clone());
            (pending.target_port, new_cwd)
        };

        record.primary_port = target_port;
        if let Some(cwd) = new_cwd {
            record.canonical_cwd = cwd;
        }
        record.current_origin = target;
        record.workspace_generation = transition_generation;
        record.pending = None;
        record.transition = None;
        Ok(())
    }

    pub fn current_workspace(&self, owner: &OwnerId) -> Option<(PathBuf, u16)> {
        let state = self.inner.lock().expect("owner registry lock poisoned");
        state
            .owners
            .get(owner)
            .map(|r| (r.canonical_cwd.clone(), r.primary_port))
    }

    pub fn workspace_transition_in_progress(&self, owner: &OwnerId) -> bool {
        let state = self.inner.lock().expect("owner registry lock poisoned");
        state
            .owners
            .get(owner)
            .is_some_and(|record| record.transition.is_some())
    }

    pub fn current_workspace_generation(&self, owner: &OwnerId) -> Option<u64> {
        let state = self.inner.lock().expect("owner registry lock poisoned");
        state.owners.get(owner).map(|r| r.workspace_generation)
    }

    pub fn pending_target_origin(&self, owner: &OwnerId) -> Option<String> {
        let state = self.inner.lock().expect("owner registry lock poisoned");
        state
            .owners
            .get(owner)
            .and_then(|r| r.pending.as_ref().map(|p| p.origin.clone()))
    }

    pub fn pending_target_port(&self, owner: &OwnerId) -> Option<u16> {
        let state = self.inner.lock().expect("owner registry lock poisoned");
        state
            .owners
            .get(owner)
            .and_then(|r| r.pending.as_ref().map(|p| p.target_port))
    }

    pub fn pending_target_cwd(&self, owner: &OwnerId) -> Option<PathBuf> {
        let state = self.inner.lock().expect("owner registry lock poisoned");
        state
            .owners
            .get(owner)
            .and_then(|r| r.pending.as_ref().map(|p| p.target_cwd.clone()))
    }

    pub fn owner_for_label(&self, label: &str) -> Option<OwnerId> {
        let state = self.inner.lock().expect("owner registry lock poisoned");
        state
            .owners
            .iter()
            .find(|(_, r)| r.window_label == label)
            .map(|(owner, _)| owner.clone())
    }

    pub fn label_for_owner(&self, owner: &OwnerId) -> Option<String> {
        let state = self.inner.lock().expect("owner registry lock poisoned");
        state.owners.get(owner).map(|r| r.window_label.clone())
    }

    pub fn cancel_workspace_transition(
        &self,
        owner: &OwnerId,
        transition_generation: u64,
    ) -> Result<(), String> {
        let mut state = self.inner.lock().expect("owner registry lock poisoned");
        let Some(record) = state.owners.get_mut(owner) else {
            return Err("unknown owner".to_string());
        };
        let pending_gen = record.pending.as_ref().map(|p| p.transition_generation);
        let transition_gen = record.transition.as_ref().map(|t| t.generation);
        if pending_gen.is_none() && transition_gen.is_none() {
            return Ok(());
        }
        if pending_gen.is_some_and(|g| g != transition_generation)
            || transition_gen.is_some_and(|g| g != transition_generation)
        {
            return Err("transition generation mismatch".to_string());
        }
        record.pending = None;
        record.transition = None;
        Ok(())
    }

    pub fn revoke_owner(&self, owner: &OwnerId) {
        let mut state = self.inner.lock().expect("owner registry lock poisoned");
        if let Some(record) = state.owners.remove(owner) {
            state.capability_index.remove(&record.capability_bytes);
        }
    }
}

#[cfg(test)]
pub fn capability_initialization_script(capability: &str) -> String {
    let token = serde_json::to_string(capability).expect("capability JSON");
    format!(
        "if (window === window.top && window.location.protocol === 'http:' && [\"127.0.0.1\",\"localhost\",\"::1\",\"[::1]\"].includes(window.location.hostname)) {{ Object.defineProperty(window, '__PICOT_NATIVE_CAPABILITY__', {{ value: {token}, configurable: true }}); }}"
    )
}

#[cfg(test)]
fn normalize_origin(origin: &str) -> Option<String> {
    let url: tauri::Url = origin.parse().ok()?;
    url_origin(&url)
}

#[cfg(test)]
fn url_origin(url: &tauri::Url) -> Option<String> {
    if url.scheme() != "http" {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?;
    if !is_loopback_host(host) {
        return None;
    }
    let port = url.port_or_known_default()?;
    Some(format!("http://{host}:{port}"))
}

#[cfg(test)]
fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "::1" | "[::1]" | "localhost")
}

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}
