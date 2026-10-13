// 文件预览分类、二进制前缀探测与 `@` 文件提及模糊搜索遍历工具。

use std::path::Path;

use crate::markitdown_preview::is_convertible_suffix;

use super::super::HostDataError;
use super::{FileMentionCandidate, BINARY_PREFIX_BYTES};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PreviewFileKind {
    Text,
    Image,
    Pdf,
    Binary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PreviewFileClassification {
    pub(super) mime_type: &'static str,
    pub(super) kind: PreviewFileKind,
    pub(super) editable: bool,
}

const IGNORED_MENTION_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    "build",
    "target",
    ".next",
    ".nuxt",
    ".cache",
    "coverage",
    ".venv",
    "venv",
    "__pycache__",
];

pub(super) fn is_ignored_mention_dir(name: &str) -> bool {
    IGNORED_MENTION_DIRS.contains(&name)
}

pub(super) struct FileMentionWalk<'a> {
    pub(super) root: &'a Path,
    pub(super) fuzzy: String,
    pub(super) is_quoted: bool,
    pub(super) visited: usize,
    pub(super) collected: Vec<(u16, FileMentionCandidate)>,
    pub(super) truncated: bool,
}

impl<'a> FileMentionWalk<'a> {
    pub(super) fn new(root: &'a Path, fuzzy: String, is_quoted: bool) -> Self {
        Self {
            root,
            fuzzy,
            is_quoted,
            visited: 0,
            collected: Vec::new(),
            truncated: false,
        }
    }

    pub(super) fn collect(&mut self, dir: &Path, display_base: &str) -> Result<(), HostDataError> {
        if self.visited >= 10_000 || self.collected.len() >= 200 {
            self.truncated = true;
            return Ok(());
        }
        let entries =
            std::fs::read_dir(dir).map_err(|error| HostDataError::Io(error.to_string()))?;
        for entry in entries.filter_map(Result::ok) {
            if self.visited >= 10_000 || self.collected.len() >= 200 {
                self.truncated = true;
                return Ok(());
            }
            self.visited += 1;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let is_directory = file_type.is_dir();
            if !is_directory && !file_type.is_file() {
                continue;
            }
            if is_directory && is_ignored_mention_dir(&name) {
                continue;
            }
            let display_path = format!("{display_base}{name}");
            let score = score_mention(&display_path, &name, &self.fuzzy, is_directory);
            if score > 0 {
                self.collected.push((
                    score,
                    build_file_mention_candidate(
                        &display_path,
                        is_directory,
                        is_quoted_display(self.is_quoted, &display_path),
                    ),
                ));
            }
            if is_directory {
                let path = entry.path();
                if path.starts_with(self.root) {
                    self.collect(&path, &format!("{display_path}/"))?;
                }
            }
        }
        Ok(())
    }
}

fn score_mention(display_path: &str, name: &str, fuzzy: &str, is_directory: bool) -> u16 {
    let base = if fuzzy.is_empty() {
        if is_directory {
            11
        } else {
            1
        }
    } else {
        let name = name.to_lowercase();
        if name == fuzzy {
            100
        } else if name.starts_with(fuzzy) {
            80
        } else if name.contains(fuzzy) {
            50
        } else if display_path.to_lowercase().contains(fuzzy) {
            30
        } else {
            0
        }
    };
    if base > 0 && is_directory {
        base + 10
    } else {
        base
    }
}

fn is_quoted_display(was_quoted: bool, display_path: &str) -> bool {
    was_quoted || display_path.contains(' ')
}

fn build_file_mention_candidate(
    display_path: &str,
    is_directory: bool,
    needs_quotes: bool,
) -> FileMentionCandidate {
    let value_path = if is_directory {
        format!("{display_path}/")
    } else {
        display_path.to_owned()
    };
    let value = if needs_quotes {
        format!("@\"{value_path}\"")
    } else {
        format!("@{value_path}")
    };
    let label = Path::new(display_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(display_path);
    FileMentionCandidate {
        value,
        label: format!("{label}{}", if is_directory { "/" } else { "" }),
        description: display_path.to_owned(),
        is_directory,
    }
}

pub(super) fn preview_extension(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| {
            name.rsplit_once('.')
                .map(|(_, ext)| ext.to_ascii_lowercase())
        })
        .unwrap_or_default()
}

pub(super) fn is_binary_by_prefix(prefix: &[u8]) -> bool {
    prefix
        .iter()
        .take(BINARY_PREFIX_BYTES)
        .any(|byte| *byte == 0)
}

pub(super) fn classify_preview_file(path: &Path, prefix: &[u8]) -> PreviewFileClassification {
    let ext = preview_extension(path);
    if ext == "pdf" || prefix.starts_with(b"%PDF") {
        return PreviewFileClassification {
            mime_type: "application/pdf",
            kind: PreviewFileKind::Pdf,
            editable: false,
        };
    }
    if let Some(mime_type) = image_mime_type(&ext) {
        return PreviewFileClassification {
            mime_type,
            kind: PreviewFileKind::Image,
            editable: false,
        };
    }
    if ext == "mbox" || is_convertible_suffix(&ext) {
        return PreviewFileClassification {
            mime_type: "application/octet-stream",
            kind: PreviewFileKind::Binary,
            editable: false,
        };
    }
    if is_binary_by_prefix(prefix) {
        return PreviewFileClassification {
            mime_type: "application/octet-stream",
            kind: PreviewFileKind::Binary,
            editable: false,
        };
    }
    PreviewFileClassification {
        mime_type: text_mime_type(&ext),
        kind: PreviewFileKind::Text,
        editable: true,
    }
}

fn image_mime_type(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

fn text_mime_type(ext: &str) -> &'static str {
    match ext {
        "js" | "jsx" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" | "mts" | "cts" => "text/typescript",
        "json" | "jsonc" => "application/json",
        "yaml" | "yml" => "text/yaml",
        "toml" => "application/toml",
        "xml" => "text/xml",
        "html" | "htm" => "text/html",
        "css" | "scss" | "sass" | "less" => "text/css",
        "md" | "markdown" | "mdown" | "mkd" => "text/markdown",
        "py" | "pyw" | "pyi" => "text/x-python",
        "r" => "text/x-r-source",
        "rb" => "text/x-ruby",
        "go" => "text/x-go",
        "rs" => "text/x-rust",
        "c" | "h" => "text/x-c",
        "cpp" | "hpp" | "cc" => "text/x-c++",
        "sh" | "bash" | "zsh" => "application/x-sh",
        "sql" => "application/sql",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "diff" | "patch" => "text/x-diff",
        _ => "text/plain",
    }
}
