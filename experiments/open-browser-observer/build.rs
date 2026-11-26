use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=../../page-observation.mjs");
    // Use the same exported function as the production observer, including its visibility rules.
    let source = Command::new("node")
        .args(["--input-type=module", "-e",
            "import {inspectDocument} from '../../page-observation.mjs'; process.stdout.write(inspectDocument.toString())"])
        .output()
        .expect("Node.js is required to embed the existing document observer");
    assert!(
        source.status.success(),
        "{}",
        String::from_utf8_lossy(&source.stderr)
    );
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("inspect-document.js");
    fs::write(output, source.stdout).unwrap();
}
