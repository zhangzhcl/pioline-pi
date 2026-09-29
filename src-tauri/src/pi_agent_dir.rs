use std::path::{Path, PathBuf};

pub const PI_AGENT_DIR_ENV: &str = "PI_CODING_AGENT_DIR";

/// Resolve Pi's shared user-data directory. An explicit Pi override takes
/// precedence; otherwise the product reuses the user's standard `~/.pi/agent`.
pub fn resolve_agent_dir(override_dir: Option<&str>, home_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(value) = override_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(PathBuf::from(value));
    }
    home_dir.map(|home| home.join(".pi").join("agent"))
}

pub fn agent_dir() -> Option<PathBuf> {
    resolve_agent_dir(
        std::env::var(PI_AGENT_DIR_ENV).ok().as_deref(),
        dirs::home_dir().as_deref(),
    )
}

pub fn resolve_home_dir(
    home_override: Option<&str>,
    system_home: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(value) = home_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(PathBuf::from(value));
    }
    system_home.map(Path::to_path_buf)
}

pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let override_home = std::env::var("USERPROFILE").ok();
    #[cfg(not(windows))]
    let override_home = std::env::var("HOME").ok();

    resolve_home_dir(override_home.as_deref(), dirs::home_dir().as_deref())
}

pub fn sessions_dir() -> Option<PathBuf> {
    agent_dir().map(|path| path.join("sessions"))
}

#[cfg(test)]
mod tests {
    use super::{resolve_agent_dir, resolve_home_dir};
    use std::path::Path;

    #[test]
    fn explicit_pi_agent_directory_is_used_as_given() {
        assert_eq!(
            resolve_agent_dir(
                Some(r"C:\isolated\pi-agent"),
                Some(Path::new(r"C:\Users\me"))
            ),
            Some(Path::new(r"C:\isolated\pi-agent").to_path_buf())
        );
    }

    #[test]
    fn empty_override_falls_back_to_standard_pi_directory() {
        assert_eq!(
            resolve_agent_dir(Some("  "), Some(Path::new("/Users/me"))),
            Some(Path::new("/Users/me/.pi/agent").to_path_buf())
        );
    }

    #[test]
    fn missing_override_and_home_cannot_resolve_pi_directory() {
        assert_eq!(resolve_agent_dir(None, None), None);
    }

    #[test]
    fn explicit_user_home_is_independent_of_a_custom_pi_agent_directory() {
        assert_eq!(
            resolve_home_dir(Some(r"D:\Users\me"), Some(Path::new(r"C:\Users\me"))),
            Some(Path::new(r"D:\Users\me").to_path_buf())
        );
    }

    #[test]
    fn empty_user_home_override_falls_back_to_system_home() {
        assert_eq!(
            resolve_home_dir(Some("  "), Some(Path::new("/Users/me"))),
            Some(Path::new("/Users/me").to_path_buf())
        );
    }
}
