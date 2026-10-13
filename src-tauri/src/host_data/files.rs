use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::markitdown_preview::{is_convertible_suffix, INPUT_BYTE_CAP};

use super::{HostDataError, HostDataPlane};

#[path = "file_helpers.rs"]
mod file_helpers;

use file_helpers::{
    classify_preview_file, is_ignored_mention_dir, preview_extension, FileMentionWalk,
    PreviewFileKind,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub relative_path: String,
    pub kind: FileKind,
    /// Byte size of the file; `None` for directories or when metadata is unavailable.
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMentionCandidate {
    pub value: String,
    pub label: String,
    pub description: String,
    pub is_directory: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMentionSearchResult {
    pub items: Vec<FileMentionCandidate>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub mtime_ms: f64,
    pub mime_type: String,
    pub is_binary: bool,
    pub truncated: bool,
    pub editable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawFileContent {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub size: u64,
}

pub struct ConvertibleFile {
    pub path: String,
    pub bytes: Vec<u8>,
    pub suffix: String,
    pub size: u64,
    pub mtime_ms: f64,
    pub mime_type: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WriteFileResult {
    Saved { size: u64, mtime_ms: f64 },
    Conflict,
    Invalid,
}

const TEXT_READ_LIMIT: usize = 2 * 1024 * 1024;
const EDIT_SIZE_LIMIT: usize = 1024 * 1024;
pub(super) const BINARY_PREFIX_BYTES: usize = 512;

impl HostDataPlane {
    pub fn list_files(
        &self,
        workspace_id: &str,
        relative_path: &str,
        show_hidden: bool,
    ) -> Result<Vec<FileEntry>, HostDataError> {
        let root = self.workspace_root(workspace_id)?;
        let root = root.as_path();
        let requested = safe_join(root, relative_path)?;
        if !requested.is_dir() {
            return Err(HostDataError::NotDirectory);
        }
        let mut entries = std::fs::read_dir(&requested)
            .map_err(|error| HostDataError::Io(error.to_string()))?
            .filter_map(Result::ok)
            .filter(|entry| show_hidden || !entry.file_name().to_string_lossy().starts_with('.'))
            .filter_map(|entry| {
                let file_type = entry.file_type().ok()?;
                let kind = if file_type.is_dir() {
                    FileKind::Directory
                } else if file_type.is_file() {
                    FileKind::File
                } else {
                    return None;
                };
                let size = if kind == FileKind::File {
                    entry.metadata().ok().map(|m| m.len())
                } else {
                    None
                };
                let path = entry.path();
                let relative = path.strip_prefix(root).ok()?;
                Some(FileEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    relative_path: relative.to_string_lossy().replace('\\', "/"),
                    kind,
                    size,
                })
            })
            .collect::<Vec<_>>();
        entries.sort_by_cached_key(|entry| {
            (entry.kind != FileKind::Directory, entry.name.to_lowercase())
        });
        Ok(entries)
    }

    pub fn search_file_mentions(
        &self,
        workspace_id: &str,
        query: &str,
    ) -> Result<FileMentionSearchResult, HostDataError> {
        let root = self.workspace_root(workspace_id)?;
        if !query.starts_with('@') || query.contains('\0') {
            return Err(HostDataError::InvalidMentionQuery);
        }
        let raw = query.strip_prefix('@').unwrap_or_default();
        let (is_quoted, body) = if let Some(rest) = raw.strip_prefix('"') {
            (true, rest.strip_suffix('"').unwrap_or(rest))
        } else {
            (false, raw)
        };
        let normalized = body.replace('\\', "/");
        if normalized.starts_with('/') || normalized.split('/').any(|part| part == "..") {
            return Err(HostDataError::InvalidMentionQuery);
        }
        let (display_base, fuzzy) = match normalized.rsplit_once('/') {
            Some((base, fuzzy)) => (format!("{base}/"), fuzzy.to_owned()),
            None => (String::new(), normalized.clone()),
        };
        if normalized
            .split('/')
            .filter(|part| !part.is_empty() && *part != ".")
            .any(is_ignored_mention_dir)
        {
            return Ok(FileMentionSearchResult {
                items: Vec::new(),
                truncated: false,
            });
        }
        let base_dir = match safe_join(&root, &display_base) {
            Ok(path) => path,
            Err(HostDataError::Io(_) | HostDataError::NotDirectory) => {
                return Ok(FileMentionSearchResult {
                    items: Vec::new(),
                    truncated: false,
                });
            }
            Err(error) => return Err(error),
        };
        let mut walk = FileMentionWalk::new(root.as_path(), fuzzy.to_lowercase(), is_quoted);
        walk.collect(&base_dir, &display_base)?;
        walk.collected.sort_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then_with(|| left.1.description.cmp(&right.1.description))
        });
        Ok(FileMentionSearchResult {
            items: walk
                .collected
                .into_iter()
                .take(20)
                .map(|(_, item)| item)
                .collect(),
            truncated: walk.truncated,
        })
    }

    pub fn read_file_content(
        &self,
        workspace_id: &str,
        relative_path: &str,
    ) -> Result<FileContent, HostDataError> {
        let root = self.workspace_root(workspace_id)?;
        let path = safe_join(&root, relative_path)?;
        let metadata =
            std::fs::metadata(&path).map_err(|error| HostDataError::Io(error.to_string()))?;
        if !metadata.is_file() {
            return Err(HostDataError::NotFile);
        }

        let mut file =
            std::fs::File::open(&path).map_err(|error| HostDataError::Io(error.to_string()))?;
        let mut prefix = [0_u8; BINARY_PREFIX_BYTES];
        let prefix_len = file
            .read(&mut prefix)
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        let classification = classify_preview_file(&path, &prefix[..prefix_len]);
        let mtime_ms = file_mtime_ms(&metadata)?;

        if matches!(
            classification.kind,
            PreviewFileKind::Image | PreviewFileKind::Pdf
        ) {
            return Ok(FileContent {
                path: relative_path.to_owned(),
                content: String::new(),
                size: metadata.len(),
                mtime_ms,
                mime_type: classification.mime_type.to_owned(),
                is_binary: false,
                truncated: false,
                editable: false,
            });
        }

        if classification.kind != PreviewFileKind::Text {
            return Ok(FileContent {
                path: relative_path.to_owned(),
                content: String::new(),
                size: metadata.len(),
                mtime_ms,
                mime_type: classification.mime_type.to_owned(),
                is_binary: true,
                truncated: false,
                editable: false,
            });
        }

        let read_len = metadata.len().min(TEXT_READ_LIMIT as u64) as usize;
        let initial_len = prefix_len.min(read_len);
        let mut buf = Vec::with_capacity(read_len);
        buf.extend_from_slice(&prefix[..initial_len]);
        if read_len > initial_len {
            (&mut file)
                .take((read_len - initial_len) as u64)
                .read_to_end(&mut buf)
                .map_err(|error| HostDataError::Io(error.to_string()))?;
        }
        Ok(FileContent {
            path: relative_path.to_owned(),
            content: String::from_utf8_lossy(&buf).into_owned(),
            size: metadata.len(),
            mtime_ms,
            mime_type: classification.mime_type.to_owned(),
            is_binary: false,
            truncated: metadata.len() > TEXT_READ_LIMIT as u64,
            editable: classification.editable && metadata.len() <= EDIT_SIZE_LIMIT as u64,
        })
    }

    pub fn read_convertible_file(
        &self,
        workspace_id: &str,
        relative_path: &str,
    ) -> Result<Option<ConvertibleFile>, HostDataError> {
        let suffix = preview_extension(Path::new(relative_path));
        if !is_convertible_suffix(&suffix) {
            return Ok(None);
        }
        let root = self.workspace_root(workspace_id)?;
        let path = safe_join(&root, relative_path)?;
        let metadata =
            std::fs::metadata(&path).map_err(|error| HostDataError::Io(error.to_string()))?;
        if !metadata.is_file() {
            return Err(HostDataError::NotFile);
        }
        if metadata.len() > INPUT_BYTE_CAP {
            return Ok(Some(ConvertibleFile {
                path: relative_path.to_owned(),
                bytes: Vec::new(),
                suffix,
                size: metadata.len(),
                mtime_ms: file_mtime_ms(&metadata)?,
                mime_type: "application/octet-stream".into(),
            }));
        }
        let file =
            std::fs::File::open(&path).map_err(|error| HostDataError::Io(error.to_string()))?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(INPUT_BYTE_CAP + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        Ok(Some(ConvertibleFile {
            path: relative_path.to_owned(),
            bytes,
            suffix,
            size: metadata.len(),
            mtime_ms: file_mtime_ms(&metadata)?,
            mime_type: "application/octet-stream".into(),
        }))
    }

    pub fn raw_file_content(
        &self,
        workspace_id: &str,
        relative_path: &str,
    ) -> Result<RawFileContent, HostDataError> {
        let root = self.workspace_root(workspace_id)?;
        let path = safe_join(&root, relative_path)?;
        let metadata =
            std::fs::metadata(&path).map_err(|error| HostDataError::Io(error.to_string()))?;
        if !metadata.is_file() {
            return Err(HostDataError::NotFile);
        }
        let mut file =
            std::fs::File::open(&path).map_err(|error| HostDataError::Io(error.to_string()))?;
        let mut prefix = [0_u8; BINARY_PREFIX_BYTES];
        let prefix_len = file
            .read(&mut prefix)
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        let classification = classify_preview_file(&path, &prefix[..prefix_len]);
        if !matches!(
            classification.kind,
            PreviewFileKind::Image | PreviewFileKind::Pdf
        ) {
            return Err(HostDataError::NotFile);
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        bytes.extend_from_slice(&prefix[..prefix_len]);
        file.read_to_end(&mut bytes)
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        Ok(RawFileContent {
            bytes,
            mime_type: classification.mime_type.to_owned(),
            size: metadata.len(),
        })
    }

    pub fn write_file_content(
        &self,
        workspace_id: &str,
        relative_path: &str,
        content: &str,
        expected_mtime_ms: f64,
        force: bool,
    ) -> Result<WriteFileResult, HostDataError> {
        if content.len() > EDIT_SIZE_LIMIT {
            return Ok(WriteFileResult::Invalid);
        }
        let root = self.workspace_root(workspace_id)?;
        let path = safe_join(&root, relative_path)?;
        let metadata =
            std::fs::metadata(&path).map_err(|error| HostDataError::Io(error.to_string()))?;
        if !metadata.is_file() || metadata.len() > EDIT_SIZE_LIMIT as u64 {
            return Ok(WriteFileResult::Invalid);
        }
        let mut file =
            std::fs::File::open(&path).map_err(|error| HostDataError::Io(error.to_string()))?;
        let mut prefix = [0_u8; BINARY_PREFIX_BYTES];
        let prefix_len = file
            .read(&mut prefix)
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        if classify_preview_file(&path, &prefix[..prefix_len]).kind != PreviewFileKind::Text {
            return Ok(WriteFileResult::Invalid);
        }
        let current_mtime_ms = file_mtime_ms(&metadata)?;
        if !force && (current_mtime_ms - expected_mtime_ms).abs() > 1.0 {
            return Ok(WriteFileResult::Conflict);
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        file.write_all(content.as_bytes())
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        file.sync_all()
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        let metadata = file
            .metadata()
            .map_err(|error| HostDataError::Io(error.to_string()))?;
        Ok(WriteFileResult::Saved {
            size: metadata.len(),
            mtime_ms: file_mtime_ms(&metadata)?,
        })
    }
}

pub(crate) fn safe_join(root: &Path, relative_path: &str) -> Result<PathBuf, HostDataError> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(HostDataError::InvalidRelativePath);
    }
    let joined = root.join(relative);
    let canonical = joined
        .canonicalize()
        .map_err(|error| HostDataError::Io(error.to_string()))?;
    if !canonical.starts_with(root) {
        return Err(HostDataError::OutsideWorkspace);
    }
    Ok(canonical)
}

fn file_mtime_ms(metadata: &std::fs::Metadata) -> Result<f64, HostDataError> {
    let modified = metadata
        .modified()
        .map_err(|error| HostDataError::Io(error.to_string()))?;
    let duration = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| HostDataError::Io(error.to_string()))?;
    Ok(duration.as_secs_f64() * 1000.0)
}
