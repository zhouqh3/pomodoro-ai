fn main() {
    println!("cargo:rerun-if-changed=../server.js");
    println!("cargo:rerun-if-changed=../public/index.html");
    println!("cargo:rerun-if-changed=../public/app.js");
    println!("cargo:rerun-if-changed=../public/style.css");
    println!("cargo:rerun-if-changed=../scripts/pack-sea.js");
    if std::env::var("PROFILE").ok().as_deref() == Some("release") {
        let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let script = std::path::Path::new(&manifest).join("../scripts/pack-sea.js");
        let out = std::env::var("OUT_DIR").unwrap();
        let status = std::process::Command::new("node")
            .arg(script)
            .arg(&out)
            .status()
            .expect("需要本机的 node 才能把服务打进 exe");
        if !status.success() {
            panic!("打包内置服务失败");
        }
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(
                tauri_build::AppManifest::new()
                    .commands(&["restore_window", "drag_window", "fit_compact", "compact_window"]),
            ),
    )
    .expect("failed to run tauri build script");
}
