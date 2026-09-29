use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

/// Copies only the active and rotated Tauri log files for the Pipline app.
/// The plugin uses Tauri's display name (`Pipline`), whose casing differs from the crate name.
pub fn copy_pipline_logs(source_dir: &Path, destination: &Path) -> Result<usize, String> {
    let mut sources = fs::read_dir(source_dir)
        .map_err(|error| format!("Unable to read Pipline logs: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_file() {
                return None;
            }
            let name = entry.file_name();
            let name = name.to_str()?;
            let normalized_name = name.to_ascii_lowercase();
            let is_active = normalized_name == "pipline.log";
            let is_rotated =
                normalized_name.starts_with("pipline_") && normalized_name.ends_with(".log");
            (is_active || is_rotated).then(|| (is_active, entry.path()))
        })
        .collect::<Vec<_>>();

    if sources.is_empty() {
        return Err("No Pipline logs are available to export.".into());
    }

    // Export rotated files oldest-first and append the active log last.
    sources.sort_by(|(active_a, path_a), (active_b, path_b)| {
        active_a
            .cmp(active_b)
            .then_with(|| path_a.file_name().cmp(&path_b.file_name()))
    });

    let destination_path = resolved_destination(destination)?;
    for (_, source) in &sources {
        if fs::canonicalize(source).ok().as_ref() == Some(&destination_path) {
            return Err("The export destination cannot replace a Pipline log file.".into());
        }
    }

    let mut output = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(destination)
        .map_err(|error| format!("Unable to create the diagnostic log export: {error}"))?;

    for (_, source) in &sources {
        let name = source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("pipline.log");
        writeln!(output, "===== {name} =====")
            .map_err(|error| format!("Unable to write the diagnostic log export: {error}"))?;
        let mut input = File::open(source)
            .map_err(|error| format!("Unable to open a Pipline log file: {error}"))?;
        io::copy(&mut input, &mut output)
            .map_err(|error| format!("Unable to write the diagnostic log export: {error}"))?;
        output
            .write_all(b"\n")
            .map_err(|error| format!("Unable to write the diagnostic log export: {error}"))?;
    }
    output
        .flush()
        .map_err(|error| format!("Unable to finish the diagnostic log export: {error}"))?;

    Ok(sources.len())
}

fn resolved_destination(destination: &Path) -> Result<PathBuf, String> {
    if destination.exists() {
        return fs::canonicalize(destination)
            .map_err(|error| format!("Unable to resolve the export destination: {error}"));
    }
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "The export destination has no parent directory.".to_string())?;
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("Unable to resolve the export destination: {error}"))?;
    let name = destination
        .file_name()
        .ok_or_else(|| "The export destination has no file name.".to_string())?;
    Ok(parent.join(name))
}

pub async fn export_app_logs(app: AppHandle) -> Result<Option<usize>, String> {
    let source_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("Unable to locate Pipline logs: {error}"))?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Pipline diagnostics", &["txt"])
        .set_file_name("pipline-diagnostics.txt")
        .save_file(move |path| {
            let _ = sender.send(path);
        });

    let Some(destination) = receiver
        .await
        .map_err(|error| format!("The save dialog did not return a result: {error}"))?
    else {
        return Ok(None);
    };
    let destination = destination
        .into_path()
        .map_err(|error| format!("Unable to resolve the export destination: {error}"))?;

    tokio::task::spawn_blocking(move || copy_pipline_logs(&source_dir, &destination))
        .await
        .map_err(|error| format!("The diagnostic log export stopped unexpectedly: {error}"))?
        .map(Some)
}

#[cfg(test)]
mod tests {
    use super::copy_pipline_logs;
    use std::fs;

    #[test]
    fn combines_active_and_rotated_pipline_logs_only() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("logs");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("pipline.log"), "current log\n").unwrap();
        fs::write(source.join("pipline_2026-09-27.log"), "rotated log\n").unwrap();
        fs::write(source.join("other.log"), "unrelated log\n").unwrap();
        fs::write(source.join("pipline.txt"), "not a log\n").unwrap();
        fs::create_dir(source.join("pipline_subdir.log")).unwrap();

        let destination = temp.path().join("diagnostics.txt");
        let count = copy_pipline_logs(&source, &destination).unwrap();
        let content = fs::read_to_string(destination).unwrap();

        assert_eq!(count, 2);
        assert!(content.contains("rotated log"));
        assert!(content.contains("current log"));
        assert!(!content.contains("unrelated log"));
        assert!(!content.contains("not a log"));
        assert!(content.find("rotated log").unwrap() < content.find("current log").unwrap());
    }

    #[test]
    fn combines_default_tauri_product_name_logs_case_insensitively() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("logs");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("Pipline.log"), "current product log\n").unwrap();
        fs::write(
            source.join("Pipline_2026-09-27.log"),
            "rotated product log\n",
        )
        .unwrap();
        fs::write(source.join("other.log"), "unrelated log\n").unwrap();

        let destination = temp.path().join("diagnostics.txt");
        let count = copy_pipline_logs(&source, &destination).unwrap();
        let content = fs::read_to_string(destination).unwrap();

        assert_eq!(count, 2);
        assert!(content.contains("rotated product log"));
        assert!(content.contains("current product log"));
        assert!(!content.contains("unrelated log"));
        assert!(
            content.find("rotated product log").unwrap()
                < content.find("current product log").unwrap()
        );
    }

    #[test]
    fn refuses_to_export_when_no_pipline_logs_exist() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("logs");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("other.log"), "unrelated\n").unwrap();

        let error = copy_pipline_logs(&source, &temp.path().join("diagnostics.txt")).unwrap_err();

        assert!(error.contains("No Pipline logs"));
        assert!(!temp.path().join("diagnostics.txt").exists());
    }

    #[test]
    fn refuses_to_overwrite_an_active_source_log() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("logs");
        fs::create_dir(&source).unwrap();
        let active_log = source.join("pipline.log");
        fs::write(&active_log, "preserve me\n").unwrap();

        assert!(copy_pipline_logs(&source, &active_log).is_err());
        assert_eq!(fs::read_to_string(active_log).unwrap(), "preserve me\n");
    }
}
