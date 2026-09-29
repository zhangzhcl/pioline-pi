fn main() {
    println!("cargo:rerun-if-changed=../src/workflow_xpc_client.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
        && std::env::var_os("CARGO_FEATURE_WORKFLOW_CODE_RUNNER_PROTOTYPE").is_some()
    {
        cc::Build::new()
            .file("../src/workflow_xpc_client.m")
            .flag("-fobjc-arc")
            .compile("pipline_workflow_xpc_worker_check");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=Security");
    }
}
