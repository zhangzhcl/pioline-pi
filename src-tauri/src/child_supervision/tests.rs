use super::*;
use std::cell::RefCell;

#[test]
fn runtime_registry_follows_the_resolved_pi_agent_directory() {
    let root = Path::new(r"C:\isolated\.pi\agent");
    assert_eq!(
        pi_root_from_agent_dir(root),
        Some(Path::new(r"C:\isolated\.pi"))
    );
}

fn registry_with(dir: &Path, supervisor_pid: u32, entries: Vec<RuntimeEntry>) {
    write_registry(
        &dir.join(format!("{supervisor_pid}.json")),
        &RuntimeRegistry {
            supervisor_pid,
            entries,
        },
    );
}

#[test]
fn kills_runtimes_whose_supervisor_is_gone() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().to_path_buf();
    registry_with(
        &dir,
        4242,
        vec![RuntimeEntry {
            pid: 7001,
            started_at: String::new(),
        }],
    );
    let killed = RefCell::new(Vec::new());
    let count = sweep_orphans_in(Some(dir.clone()), 1, &|pid| pid == 7001, &|pid| {
        killed.borrow_mut().push(pid)
    });
    assert_eq!(count, 1);
    assert_eq!(*killed.borrow(), vec![7001]);
    assert!(!dir.join("4242.json").exists());
}

#[test]
fn leaves_runtimes_of_a_live_supervisor_alone() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().to_path_buf();
    registry_with(
        &dir,
        4242,
        vec![RuntimeEntry {
            pid: 7001,
            started_at: String::new(),
        }],
    );
    let killed = RefCell::new(Vec::new());
    let count = sweep_orphans_in(Some(dir.clone()), 1, &|_| true, &|pid| {
        killed.borrow_mut().push(pid)
    });
    assert_eq!(count, 0);
    assert!(killed.borrow().is_empty());
    // The registry must survive: those runtimes still have an owner.
    assert!(dir.join("4242.json").exists());
}

#[test]
fn never_kills_a_pid_that_was_recycled() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().to_path_buf();
    registry_with(
        &dir,
        4242,
        vec![RuntimeEntry {
            pid: 7001,
            started_at: "Thu Sep  3 11:59:30 2026".into(),
        }],
    );
    let killed = RefCell::new(Vec::new());
    // The pid is alive, but it is some other process now: start times differ.
    let count = sweep_orphans_in(Some(dir), 1, &|pid| pid == 7001, &|pid| {
        killed.borrow_mut().push(pid)
    });
    assert_eq!(count, 0);
    assert!(killed.borrow().is_empty());
}

#[test]
fn ignores_our_own_registry_file() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().to_path_buf();
    registry_with(
        &dir,
        99,
        vec![RuntimeEntry {
            pid: 7001,
            started_at: String::new(),
        }],
    );
    let killed = RefCell::new(Vec::new());
    let count = sweep_orphans_in(Some(dir.clone()), 99, &|_| false, &|pid| {
        killed.borrow_mut().push(pid)
    });
    assert_eq!(count, 0);
    assert!(dir.join("99.json").exists());
}

#[test]
fn a_live_process_reads_as_alive() {
    let pid = std::process::id();
    assert!(pid_is_alive(pid));
    assert!(process_start_time(pid).is_some());
}
