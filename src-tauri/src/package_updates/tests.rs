use super::{
    check_package_update, latest_npm_version, npm_package_spec, parse_ls_remote_reference,
    parse_source, split_git_ref, ParsedSource,
};
use crate::pi_launch::PiPackageInfo;

fn info(source: &str, installed_path: Option<&str>, version: Option<&str>) -> PiPackageInfo {
    PiPackageInfo {
        source: source.to_string(),
        scope: "global".to_string(),
        installed_path: installed_path.map(ToOwned::to_owned),
        disabled: false,
        package_name: None,
        version: version.map(ToOwned::to_owned),
        description: None,
        counts: Default::default(),
        resources: Vec::new(),
    }
}

// Tests must never touch the real registry or remote hosts: PI_OFFLINE=1
// makes run_update_command fail before spawning any subprocess.

#[test]
fn parse_source_distinguishes_npm_git_and_local() {
    assert!(matches!(
        parse_source("npm:foo"),
        Ok(ParsedSource::Npm { ref name, .. }) if name == "foo"
    ));
    assert!(matches!(
        parse_source("npm:@scope/name@^2.0.0"),
        Ok(ParsedSource::Npm { ref version, .. }) if version.as_deref() == Some("^2.0.0")
    ));
    assert!(matches!(
        parse_source("git:https://github.com/a/b#v1"),
        Ok(ParsedSource::Git { reference: Some(_) })
    ));
    assert!(matches!(
        parse_source("github:a/b"),
        Ok(ParsedSource::Git { reference: None })
    ));
    assert!(matches!(
        parse_source("./local/path"),
        Ok(ParsedSource::Local)
    ));
}

#[test]
fn npm_package_spec_parses_scoped_pinned_and_range_specs() {
    assert_eq!(npm_package_spec("foo").unwrap(), ("foo".to_string(), None));
    assert_eq!(
        npm_package_spec("foo@1.2.3").unwrap(),
        ("foo".to_string(), Some("1.2.3".to_string()))
    );
    assert_eq!(
        npm_package_spec("foo@^1.0.0").unwrap(),
        ("foo".to_string(), Some("^1.0.0".to_string()))
    );
    assert_eq!(
        npm_package_spec("@scope/name").unwrap(),
        ("@scope/name".to_string(), None)
    );
    assert_eq!(
        npm_package_spec("@scope/name@2.0.0").unwrap(),
        ("@scope/name".to_string(), Some("2.0.0".to_string()))
    );
    assert!(npm_package_spec("").is_err());
    assert!(npm_package_spec("@missing-slash").is_err());
}

#[test]
fn split_git_ref_extracts_hash_and_at_references() {
    assert_eq!(split_git_ref("a/b"), ("a/b", None));
    assert_eq!(split_git_ref("a/b#v1"), ("a/b", Some("v1")));
    assert_eq!(
        split_git_ref("https://host/a/b@main"),
        ("https://host/a/b", Some("main"))
    );
    assert_eq!(split_git_ref("host:a/b@main"), ("host:a/b", Some("main")));
}

#[test]
fn latest_npm_version_handles_string_and_array_shapes() {
    assert_eq!(
        latest_npm_version("\"1.2.3\"", None).as_deref(),
        Some("1.2.3")
    );
    assert_eq!(
        latest_npm_version("[\"1.5.0\", \"2.0.0\", \"1.0.0\"]", None).as_deref(),
        Some("2.0.0")
    );
    assert_eq!(latest_npm_version("not json", None), None);
    assert_eq!(latest_npm_version("null", None), None);
}

#[test]
fn latest_npm_version_filters_invalid_versions_and_applies_range() {
    assert_eq!(
        latest_npm_version("[\"latest\", \"1.0.0\", \"not-semver\"]", None).as_deref(),
        Some("1.0.0")
    );
    let range = semver::VersionReq::parse("^1.0.0").unwrap();
    assert_eq!(
        latest_npm_version("[\"3.0.0\", \"2.0.0\", \"1.5.0\", \"1.0.0\"]", Some(&range)).as_deref(),
        Some("1.5.0")
    );
}

#[test]
fn parse_ls_remote_selects_only_matching_reference_heads() {
    let sha = "0123456789abcdef0123456789abcdef01234567"; // 40 hex chars
    assert_eq!(
        parse_ls_remote_reference(&format!("{sha}\tHEAD")).as_deref(),
        Some(sha)
    );
    assert_eq!(
        parse_ls_remote_reference(&format!("{sha}\trefs/heads/main")).as_deref(),
        Some(sha)
    );
    assert_eq!(
        parse_ls_remote_reference(&format!("{sha}\trefs/tags/v1.0.0")),
        None
    );
    assert_eq!(parse_ls_remote_reference("deadbeef\tHEAD"), None);
    assert_eq!(
        parse_ls_remote_reference(&format!("{sha}\tHEAD\textra")),
        Some(sha.to_string())
    );
    assert_eq!(parse_ls_remote_reference(""), None);
}

#[tokio::test]
async fn check_short_circuits_without_network_for_pinned_local_and_refed_git() {
    std::env::set_var("PI_OFFLINE", "1");
    for record in [
        info("npm:foo@1.2.3", Some("/tmp/installed"), Some("1.0.0")),
        info("./local/pkg", Some("/tmp/local"), None),
        info("git:https://github.com/a/b#v1", Some("/tmp/gitpkg"), None),
        info("npm:foo", None, None),
        info("npm:foo", Some("/tmp/x"), None), // no installed version
    ] {
        let locations = super::locations_for_workspace(None).unwrap();
        assert!(
            !check_package_update(&record, &locations).await,
            "expected no update probe for {}",
            record.source
        );
    }
    std::env::remove_var("PI_OFFLINE");
}

#[tokio::test]
async fn offline_guard_blocks_the_unpinned_npm_probe_before_spawning() {
    // Unpinned npm with an installed version is the one shape that reaches
    // the subprocess path; under PI_OFFLINE it must fail closed (no update)
    // without ever spawning npm.
    std::env::set_var("PI_OFFLINE", "1");
    let locations = super::locations_for_workspace(None).unwrap();
    assert!(
        !check_package_update(&info("npm:foo", Some("/tmp/x"), Some("1.0.0")), &locations).await
    );
    std::env::remove_var("PI_OFFLINE");
}
