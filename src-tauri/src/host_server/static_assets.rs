use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

/// 计算静态资源目录的指纹（通过各文件的相对路径、大小与修改时间），
/// 无需读取文件内容，快速生成 URL 静态版本前缀，保证静态资源更新时缓存及时失效。
pub fn fingerprint_static_dir(static_dir: &Path) -> String {
    fn walk(dir: &Path, out: &mut Vec<(PathBuf, fs::Metadata)>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if file_type.is_dir() {
                walk(&path, out);
            } else if file_type.is_file() {
                if let Ok(meta) = entry.metadata() {
                    out.push((path, meta));
                }
            }
        }
    }
    let mut files = Vec::new();
    walk(static_dir, &mut files);
    files.sort_by(|(a, _), (b, _)| a.cmp(b));

    let mut hasher = Sha256::new();
    for (path, meta) in &files {
        if let Ok(relative) = path.strip_prefix(static_dir) {
            hasher.update(relative.to_string_lossy().as_bytes());
        }
        hasher.update(meta.len().to_le_bytes());
        if let Ok(modified) = meta.modified() {
            if let Ok(since_epoch) = modified.duration_since(std::time::UNIX_EPOCH) {
                hasher.update(since_epoch.as_millis().to_le_bytes());
            }
        }
    }
    hex::encode(&hasher.finalize()[..8])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fingerprint_deterministic_and_changes_with_content() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!("pipline-test-fp-{nonce}"));
        fs::create_dir_all(&temp_dir).unwrap();
        let test_file = temp_dir.join("app.js");
        fs::write(&test_file, "console.log('v1');").unwrap();

        let fp1 = fingerprint_static_dir(&temp_dir);
        let fp2 = fingerprint_static_dir(&temp_dir);
        assert_eq!(fp1, fp2);
        assert_eq!(fp1.len(), 16);

        // 修改文件内容与大小后指纹发生改变
        fs::write(&test_file, "console.log('v2-longer-content');").unwrap();
        let fp3 = fingerprint_static_dir(&temp_dir);
        assert_ne!(fp1, fp3);

        let _ = fs::remove_dir_all(temp_dir);
    }
}
