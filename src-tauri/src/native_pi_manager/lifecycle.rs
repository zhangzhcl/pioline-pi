// ABOUTME: Runtime stop, restart, session binding/rebinding, status snapshots,
// ABOUTME: and closed-stream cleanup for NativePiManager.

use crate::runtime_coordinator::{RuntimeSnapshot, RuntimeStatus, RuntimeTarget};

use super::{NativeLaunchSpec, NativePiManager, NativePiManagerInner, NativeRuntimeEvent};

impl NativePiManager {
    pub fn stop(&self, target: &RuntimeTarget) -> Result<(), String> {
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "Runtime coordinator lock poisoned".to_string())?
            .validate(target)
            .map_err(|error| format!("Runtime stop rejected: {error:?}"))?;
        let mut runtime = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| "Native runtime registry lock poisoned".to_string())?
            .remove(&target.instance_id)
            .ok_or_else(|| "Native runtime instance is not running".to_string())?;
        if let Some(process) = &mut runtime.process {
            process.kill()?;
        }
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "Runtime coordinator lock poisoned".to_string())?
            .unregister(target)
            .map_err(|error| format!("Cannot unregister stopped runtime: {error:?}"))?;
        if let Ok(mut pending_ui) = self.inner.pending_ui.lock() {
            pending_ui.remove(&target.instance_id);
        }
        Ok(())
    }

    pub fn stop_workspace(&self, workspace_id: &str) {
        let targets = self
            .inner
            .runtimes
            .lock()
            .map(|runtimes| {
                runtimes
                    .values()
                    .filter_map(|runtime| runtime.target.lock().ok().map(|target| target.clone()))
                    .filter(|target| target.workspace_id == workspace_id)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for target in targets {
            let _ = self.stop(&target);
        }
    }

    pub fn stop_all(&self) {
        let targets = self
            .inner
            .runtimes
            .lock()
            .map(|runtimes| {
                runtimes
                    .values()
                    .filter_map(|runtime| runtime.target.lock().ok().map(|target| target.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for target in targets {
            let _ = self.stop(&target);
        }
    }

    /// Stop the runtime for `target` and spawn a fresh one that resumes the same
    /// session, returning the new instance id. Used to pick up extension/package
    /// changes without leaving the app. Falls back to a no-op returning the
    /// existing instance id when the target is not currently running.
    pub fn restart(
        &self,
        target: &RuntimeTarget,
        spec: &NativeLaunchSpec,
    ) -> Result<String, String> {
        let existing = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| "Native runtime registry lock poisoned".to_string())?
            .values()
            .find_map(|runtime| {
                let current = runtime.target.lock().ok()?;
                (current.workspace_id == target.workspace_id
                    && current.session_id == target.session_id)
                    .then(|| current.clone())
            });

        let Some(existing) = existing else {
            // Not currently running — nothing to restart.
            return Ok(target.instance_id.clone());
        };

        self.stop(&existing)?;

        let new_instance = format!("instance-{}", uuid::Uuid::new_v4().simple());
        let fresh = RuntimeTarget::new(
            existing.workspace_id,
            existing.session_id,
            new_instance.clone(),
        );
        self.spawn(fresh, spec)?;
        Ok(new_instance)
    }

    pub fn target_for_session(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Option<RuntimeTarget> {
        self.inner
            .runtimes
            .lock()
            .ok()?
            .values()
            .find_map(|runtime| {
                let target = runtime.target.lock().ok()?;
                (target.workspace_id == workspace_id && target.session_id == session_id)
                    .then(|| target.clone())
            })
    }

    pub fn target_for_session_id(&self, session_id: &str) -> Option<RuntimeTarget> {
        self.inner
            .runtimes
            .lock()
            .ok()?
            .values()
            .find_map(|runtime| {
                let target = runtime.target.lock().ok()?;
                (target.session_id == session_id).then(|| target.clone())
            })
    }

    pub fn bind_session_id(
        &self,
        temporary: &RuntimeTarget,
        session_id: &str,
    ) -> Result<RuntimeTarget, String> {
        if !temporary.session_id.starts_with("temporary-") {
            return Ok(temporary.clone());
        }
        self.rebind_session_id_with_event(temporary, session_id, "session_bound")
    }

    /// Re-point a *formal* (non-"temporary-") session id to another formal
    /// session id, for an instance whose live session changed identity out
    /// from under the registry — e.g. pi forking a new session file in place
    /// for the same running instance.
    pub fn rebind_session_id(
        &self,
        current: &RuntimeTarget,
        session_id: &str,
    ) -> Result<RuntimeTarget, String> {
        self.rebind_session_id_with_event(current, session_id, "session_rebound")
    }

    fn rebind_session_id_with_event(
        &self,
        current: &RuntimeTarget,
        session_id: &str,
        event_type: &str,
    ) -> Result<RuntimeTarget, String> {
        let mut coordinator = self
            .inner
            .coordinator
            .lock()
            .map_err(|_| "Runtime coordinator lock poisoned".to_string())?;
        let binding_event = coordinator
            .emit_event(
                current,
                serde_json::json!({
                    "type": event_type,
                    "sessionId": session_id,
                }),
            )
            .map_err(|error| format!("Cannot sequence session binding: {error:?}"))?;
        let formal = coordinator
            .bind_session_id(current, session_id)
            .map_err(|error| format!("Cannot bind formal session: {error:?}"))?;
        drop(coordinator);
        let runtime = self
            .inner
            .runtimes
            .lock()
            .map_err(|_| "Native runtime registry lock poisoned".to_string())?;
        let managed = runtime
            .get(&current.instance_id)
            .ok_or_else(|| "Native runtime instance is not running".to_string())?;
        *managed
            .target
            .lock()
            .map_err(|_| "Native runtime target lock poisoned".to_string())? = formal.clone();
        drop(runtime);
        let _ = self.inner.events.send(NativeRuntimeEvent {
            target: binding_event.target,
            sequence: binding_event.sequence,
            event: binding_event.event,
        });
        Ok(formal)
    }

    pub fn snapshot(&self, target: &RuntimeTarget) -> Result<RuntimeSnapshot, String> {
        self.inner
            .coordinator
            .lock()
            .map_err(|_| "Runtime coordinator lock poisoned".to_string())?
            .snapshot(target)
            .map_err(|error| format!("Runtime snapshot rejected: {error:?}"))
    }

    pub fn statuses(&self) -> Result<Vec<RuntimeStatus>, String> {
        Ok(self
            .inner
            .coordinator
            .lock()
            .map_err(|_| "Runtime coordinator lock poisoned".to_string())?
            .statuses())
    }
}

pub(super) fn remove_closed_runtime(inner: &NativePiManagerInner, instance_id: &str) {
    let runtime = inner
        .runtimes
        .lock()
        .ok()
        .and_then(|mut runtimes| runtimes.remove(instance_id));
    let Some(mut runtime) = runtime else {
        return;
    };
    if let Some(process) = &mut runtime.process {
        let _ = process.kill();
    }
    let target = runtime.target.lock().ok().map(|target| target.clone());
    if let Some(target) = target {
        if let Ok(mut coordinator) = inner.coordinator.lock() {
            let _ = coordinator.unregister(&target);
        }
    }
    if let Ok(mut pending_ui) = inner.pending_ui.lock() {
        pending_ui.remove(instance_id);
    }
}
