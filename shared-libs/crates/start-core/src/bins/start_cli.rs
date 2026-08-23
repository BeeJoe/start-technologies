use std::ffi::OsString;

use rpc_toolkit::CliApp;
use serde_json::Value;

use crate::context::CliContext;
use crate::context::config::ClientConfig;
use crate::util::logger::LOGGER;

fn app() -> CliApp<CliContext, ClientConfig> {
    CliApp::new(
        |cfg: ClientConfig| Ok(CliContext::init(cfg.load()?)?),
        crate::main_api(),
    )
    .mutate_command(super::translate_cli)
    .mutate_command(|cmd| cmd.name("start-cli").version(super::cli_version()))
}

pub fn main(args: impl IntoIterator<Item = OsString>) {
    LOGGER.enable();

    if let Err(e) = app().run(args) {
        match e.data {
            Some(Value::String(s)) => eprintln!("{}: {}", e.message, s),
            Some(Value::Object(o)) => {
                if let Some(Value::String(s)) = o.get("details") {
                    eprintln!("{}: {}", e.message, s);
                    if let Some(Value::String(s)) = o.get("debug") {
                        tracing::debug!("{}", s)
                    }
                }
            }
            Some(a) => eprintln!("{}: {}", e.message, a),
            None => eprintln!("{}", e.message),
        }

        std::process::exit(e.code);
    }
}

#[test]
fn no_shadowed_args_start_cli() {
    super::assert_no_shadowed_args(app().into_command());
}

#[test]
fn export_manpage_start_cli() {
    // Pages live with the start-cli product; anchored to start-core's crate dir.
    let dir = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../projects/start-cli/man"
    );
    std::fs::create_dir_all(dir).unwrap();
    let existing = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            (path.extension().and_then(|extension| extension.to_str()) == Some("1")).then(|| {
                let contents = std::fs::read_to_string(&path).unwrap();
                (path, contents)
            })
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    clap_mangen::generate_to(app().into_command(), dir).unwrap();
    let normalize = |contents: &str| {
        format!(
            "{}\n",
            contents
                .lines()
                .map(str::trim_end)
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("1") {
            continue;
        }
        let contents = std::fs::read_to_string(&path).unwrap();
        let normalized = normalize(&contents);
        let contents = match existing.get(&path) {
            Some(previous) if normalize(previous) == normalized => previous.clone(),
            _ => normalized,
        };
        std::fs::write(path, contents).unwrap();
    }
}
