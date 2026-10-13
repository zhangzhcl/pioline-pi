// Pipline SQLite 元数据存储门面：统一组织 Schema 迁移、偏好与设备配对、工作流图及运行实例持久化。

use rusqlite::Connection;
#[cfg(unix)]
use std::path::PathBuf;

mod run_state_validation;
mod runs;
mod schema;
mod template_validation;
#[path = "metadata_store/workflow_edge_validation.rs"]
mod workflow_edge_validation;
#[path = "metadata_store/workflow_run_read_validation.rs"]
mod workflow_run_read_validation;
#[path = "metadata_store/workflow_snapshot_validation.rs"]
mod workflow_snapshot_validation;
#[path = "metadata_store/workflow_validation.rs"]
mod workflow_validation;
mod workflows;

use run_state_validation::{
    validate_workflow_run_max_concurrency, validate_workflow_run_node_meta_snapshot,
    validate_workflow_run_node_states, validate_workflow_run_output_sizes,
};

pub(crate) const SCHEMA_VERSION: i64 = 5;
pub(crate) const MAX_WORKFLOW_RUN_JSON_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_WORKFLOW_RUN_EVENT_JSON_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_WORKFLOW_NODE_OUTPUT_BYTES: usize = 512 * 1024;
pub(crate) const MAX_WORKFLOW_RUN_EVENT_COUNT: i64 = 10_000;
pub(crate) const TERMINAL_WORKFLOW_RUN_EVENT_RESERVE: i64 = 8;
pub(crate) const MAX_WORKFLOW_JSON_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_WORKFLOW_EVENT_JSON_BYTES: usize = 1024 * 1024;

pub struct MetadataStore {
    pub(crate) connection: Connection,
    #[cfg(unix)]
    pub(crate) path: PathBuf,
}

#[cfg(test)]
#[path = "metadata_store/tests.rs"]
mod tests;
