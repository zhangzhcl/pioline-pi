#[cfg(not(debug_assertions))]
compile_error!("workflow-code-worker is a development-only experiment");

#[allow(dead_code)]
#[path = "../../src/workflow_code_runner.rs"]
mod workflow_code_runner;

fn main() {
    std::process::exit(workflow_code_runner::run_stdio_confined_worker());
}
