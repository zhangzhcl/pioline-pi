use crate::native_pi_manager::NativeLaunchSpec;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

mod extensions;
mod external_apps;
mod packages;

use extensions::resolve_bundled_extensions;
pub use external_apps::{list_installed_apps, open_external, open_in_app};
pub use packages::{set_package_disabled, settings_path, PiPackageInfo};

const PI_VERSION_JSON: &str = include_str!("../../scripts/pi-version.json");

pub fn locked_pi_version() -> &'static str {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED.get_or_init(|| {
        let needle = "\"version\"";
        let bytes = PI_VERSION_JSON;
        let start = bytes
            .find(needle)
            .expect("pi-version.json: missing \"version\" key");
        let after_key = &bytes[start + needle.len()..];
        let colon = after_key
            .find(':')
            .expect("pi-version.json: malformed \"version\" entry");
        let after_colon = &after_key[colon + 1..];
        let first_quote = after_colon
            .find('"')
            .expect("pi-version.json: \"version\" value not quoted");
        let rest = &after_colon[first_quote + 1..];
        let end_quote = rest
            .find('"')
            .expect("pi-version.json: unterminated \"version\" value");
        rest[..end_quote].to_string()
    })
}

#[derive(Clone)]
pub struct PiLaunchResolver {
    static_dir: PathBuf,
}

impl PiLaunchResolver {
    pub fn new(static_dir: PathBuf) -> Self {
        Self { static_dir }
    }

    pub fn native_launch_spec(
        &self,
        cwd: &str,
        session_path: Option<&str>,
    ) -> Result<NativeLaunchSpec, String> {
        let binary = self.resolve_bundled_pi()?;
        let extensions =
            resolve_bundled_extensions(&self.static_dir, Path::new(cwd), session_path.is_some())?;
        let cwd_path = PathBuf::from(strip_verbatim_prefix(cwd));
        let pi_agent_dir = crate::pi_agent_dir::agent_dir();
        Ok(NativeLaunchSpec {
            binary,
            cwd: cwd_path.clone(),
            session_path: session_path.map(|path| PathBuf::from(strip_verbatim_prefix(path))),
            extensions,
            pi_version: locked_pi_version().to_owned(),
            path_env: build_augmented_path(),
            approve: true,
            windows_powershell_fallback: crate::pi_shell_compat::windows_powershell_fallback(
                &cwd_path,
                pi_agent_dir.as_deref(),
            ),
        })
    }

    /// Run the embedded `pi` CLI with the given arguments and return trimmed stdout.
    /// Blocking; callers on an async runtime should wrap this in `spawn_blocking`.
    pub fn run_pi_command(&self, args: &[&str]) -> Result<String, String> {
        let pi_bin = self.resolve_bundled_pi()?;
        let pi_bin_str = strip_verbatim_prefix(&pi_bin.to_string_lossy());
        let augmented_path = build_augmented_path();
        let mut command = Command::new(&pi_bin_str);
        crate::windows_child::hide_console(&mut command);
        crate::appimage_env::scrub(&mut command);
        command
            .args(args)
            .env("PATH", augmented_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(agent_dir) = crate::pi_agent_dir::agent_dir() {
            command.env(crate::pi_agent_dir::PI_AGENT_DIR_ENV, agent_dir);
        }
        let output = command.output().map_err(|error| {
            format!("Failed to run embedded pi command ({pi_bin_str} {args:?}): {error}")
        })?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let details = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("exit status {}", output.status)
        };
        Err(format!(
            "Embedded pi command failed: {pi_bin_str} {args:?}: {details}"
        ))
    }

    pub fn resolve_bundled_pi_for_spawn(&self) -> Result<(String, String), String> {
        let binary = self.resolve_bundled_pi()?;
        let binary_str = strip_verbatim_prefix(&binary.to_string_lossy());
        Ok((binary_str, build_augmented_path()))
    }

    pub fn bundled_pi_path(&self) -> Result<PathBuf, String> {
        self.resolve_bundled_pi()
    }

    fn resolve_bundled_pi(&self) -> Result<PathBuf, String> {
        let bin_name = if cfg!(target_os = "windows") {
            "pi.exe"
        } else {
            "pi"
        };

        let mut tried = Vec::new();
        if let Some(candidate) = self
            .static_dir
            .parent()
            .map(|parent| parent.join("pi").join(bin_name))
        {
            if candidate.is_file() {
                return Ok(candidate);
            }
            tried.push(candidate);
        }

        if cfg!(debug_assertions) {
            let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("pi")
                .join(bin_name);
            if dev_path.is_file() {
                return Ok(dev_path);
            }
            tried.push(dev_path);
        }

        Err(format!(
            "Could not find embedded pi binary. Tried:\n{}\n\n\
             For dev: run `bun run fetch:pi` from the repo root.\n\
             For release: the .app bundle is missing `resources/pi/{bin_name}`. \
             Reinstall Pipline.",
            tried
                .iter()
                .map(|path| format!("  - {}", path.display()))
                .collect::<Vec<_>>()
                .join("\n")
        ))
    }
}

pub(crate) fn build_augmented_path() -> String {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    crate::appimage_env::strip_bundle_path_entries(&mut dirs);

    #[cfg(not(target_os = "windows"))]
    {
        let mut extras = vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/opt/homebrew/sbin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/sbin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ];

        if let Ok(home) = std::env::var("HOME") {
            let home = Path::new(&home);
            extras.push(pi_extension_npm_bin_dir(home));
            extras.push(home.join(".local/bin"));
            extras.push(home.join(".bun/bin"));
            extras.push(home.join(".volta/bin"));
            extras.push(home.join(".cargo/bin"));
            extras.push(home.join(".local/share/mise/shims"));
            let nvm_root = home.join(".nvm/versions/node");
            if let Ok(entries) = std::fs::read_dir(nvm_root) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin");
                    if bin.is_dir() {
                        extras.push(bin);
                    }
                }
            }
        }

        for extra in extras {
            if !dirs.iter().any(|dir| dir == &extra) {
                dirs.push(extra);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let mut extras = Vec::new();
        if let Ok(appdata) = std::env::var("APPDATA") {
            extras.push(Path::new(&appdata).join("npm"));
        }
        if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            let home = Path::new(&home);
            extras.push(pi_extension_npm_bin_dir(home));
            extras.push(home.join(".cargo").join("bin"));
            extras.push(home.join(".bun").join("bin"));
            extras.push(home.join("scoop").join("shims"));
        }
        for extra in extras {
            if !dirs.iter().any(|dir| dir == &extra) {
                dirs.push(extra);
            }
        }
    }

    std::env::join_paths(dirs).ok().map_or_else(
        || std::env::var("PATH").unwrap_or_default(),
        |path| path.to_string_lossy().to_string(),
    )
}

fn pi_extension_npm_bin_dir(home: &Path) -> PathBuf {
    home.join(".pi")
        .join("agent")
        .join("npm")
        .join("node_modules")
        .join(".bin")
}

fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{strip_verbatim_prefix, PiLaunchResolver};
    use std::sync::Mutex;

    static PI_BIN_ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn resolves_the_bundled_pi_even_when_pi_bin_is_set() {
        let _lock = PI_BIN_ENV_LOCK.lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let resource_root = temp.path().join("resources");
        let static_dir = resource_root.join("public");
        let bin_name = if cfg!(target_os = "windows") {
            "pi.exe"
        } else {
            "pi"
        };
        let bundled_pi = resource_root.join("pi").join(bin_name);
        let external_pi = temp.path().join(format!("external-{bin_name}"));
        std::fs::create_dir_all(&static_dir).unwrap();
        std::fs::create_dir_all(bundled_pi.parent().unwrap()).unwrap();
        std::fs::write(&bundled_pi, b"bundled").unwrap();
        std::fs::write(&external_pi, b"external").unwrap();

        let previous = std::env::var_os("PI_BIN");
        std::env::set_var("PI_BIN", &external_pi);
        let resolved = PiLaunchResolver::new(static_dir).bundled_pi_path().unwrap();
        if let Some(value) = previous {
            std::env::set_var("PI_BIN", value);
        } else {
            std::env::remove_var("PI_BIN");
        }

        assert_eq!(resolved, bundled_pi);
    }

    #[test]
    fn strip_verbatim_prefix_removes_extended_length_prefix() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\C:\Users\WIN10\.pi\agent"),
            r"C:\Users\WIN10\.pi\agent"
        );
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share\dir"),
            r"\\server\share\dir"
        );
        assert_eq!(strip_verbatim_prefix(r"C:\Users\WIN10"), r"C:\Users\WIN10");
        assert_eq!(
            strip_verbatim_prefix("/home/user/.pi/agent"),
            "/home/user/.pi/agent"
        );
        assert_eq!(strip_verbatim_prefix(""), "");
    }
}
