//! Small, explicit commands for the native migration experiment.
//! No production workspace is selected implicitly and no arbitrary SQL is exposed.

use law_agent_core::resources::{Admission, ResourceGovernor, ResourcePolicy, WorkKind, WorkRequest};
use law_agent_core::store::{DiskStore, MAX_ROW_LIMIT};
use serde::Serialize;
use serde_json::json;
use std::error::Error;
use std::io::{self, Write};
use std::time::{Duration, Instant};

const UPDATE_PAYLOAD: &str = "Synthetic deterministic update";
const HELP: &str = "Experimental native core (not the desktop application)
  seed <new-synthetic.sqlite> [rows=4096] [payload-bytes=16384]
  summary <database.sqlite>
  check-workspace <closed-workspace-copy.sqlite>
  page <synthetic.sqlite> [after-id=0] [limit=64]
  exercise <synthetic.sqlite> [iterations=4] [page-limit=64] [hold-ms=250]
  backup <source.sqlite> <new-destination.sqlite>
  policy

Writes are limited to empty or explicitly marked synthetic databases.
check-workspace reads only the schema marker; it does not establish feature parity.
";

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn invalid(message: &str) -> Box<dyn Error> {
    Box::new(io::Error::new(io::ErrorKind::InvalidInput, message))
}

fn required<'a>(args: &'a [String], index: usize, name: &str) -> Result<&'a str> {
    args.get(index).map(String::as_str).ok_or_else(|| invalid(name))
}

fn number(args: &[String], index: usize, default: u64, minimum: u64, maximum: u64) -> Result<u64> {
    let value = args.get(index).map(|value| value.parse::<u64>()).transpose()?.unwrap_or(default);
    if !(minimum..=maximum).contains(&value) {
        return Err(invalid(&format!("Argument {index} must be between {minimum} and {maximum}")));
    }
    Ok(value)
}

fn emit(value: impl Serialize) -> Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &value)?;
    writeln!(stdout)?;
    Ok(())
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("help");
    let maximum_args = match command {
        "help" | "--help" | "-h" | "policy" => 1,
        "summary" | "check-workspace" => 2,
        "backup" => 3,
        "seed" | "page" => 4,
        "exercise" => 5,
        _ => return Err(invalid("Unknown command; use --help")),
    };
    if args.len() > maximum_args { return Err(invalid("Too many arguments")); }
    match command {
        "help" | "--help" | "-h" => { print!("{HELP}"); Ok(()) }
        "policy" => {
            let policy = ResourcePolicy::default();
            let governor = ResourceGovernor::new(policy.clone())?;
            emit(json!({
                "experimental": true,
                "policy": policy,
                "snapshot": governor.snapshot(),
                "scope": "Cooperative job reservations; not a total RSS cap or third-party model monitor"
            }))
        }
        "seed" => {
            let path = required(&args, 1, "A new synthetic database path is required")?;
            let rows = number(&args, 2, 4096, 1, 1_000_000)?;
            let bytes = number(&args, 3, 16384, 1, 2 * 1024 * 1024)?;
            if rows.checked_mul(bytes).is_none_or(|total| total > 256 * 1024 * 1024) {
                return Err(invalid("Synthetic seed payload is limited to 256 MiB"));
            }
            let mut store = DiskStore::open(path, false)?;
            let seed = store.seed_synthetic(rows, bytes as usize)?;
            emit(json!({"seed": seed, "store": store.summarize()?}))
        }
        "summary" => {
            let store = DiskStore::open(required(&args, 1, "A database path is required")?, true)?;
            emit(store.summarize()?)
        }
        "check-workspace" => {
            let store = DiskStore::open(required(&args, 1, "A closed workspace copy path is required")?, true)?;
            emit(store.check_workspace_schema7()?)
        }
        "page" => {
            let store = DiskStore::open(required(&args, 1, "A synthetic database path is required")?, true)?;
            let after = number(&args, 2, 0, 0, i64::MAX as u64)?;
            let limit = number(&args, 3, 64, 1, MAX_ROW_LIMIT as u64)?;
            emit(store.page(after as i64, limit as usize)?)
        }
        "backup" => {
            let store = DiskStore::open(required(&args, 1, "A source database path is required")?, true)?;
            emit(store.backup_to(required(&args, 2, "A new backup path is required")?)?)
        }
        "exercise" => {
            let path = required(&args, 1, "A synthetic database path is required")?;
            let iterations = number(&args, 2, 4, 1, 128)?;
            let limit = number(&args, 3, 64, 1, MAX_ROW_LIMIT as u64)?;
            let hold_ms = number(&args, 4, 250, 0, 1000)?;
            let governor = ResourceGovernor::new(ResourcePolicy::default())?;
            let mut request = WorkRequest::new(WorkKind::RetrievalQuery, 16 * 1024 * 1024);
            request.cache_bytes = 8 * 1024 * 1024;
            request.query_chunks = 1;
            request.job_items = iterations as u32;
            let permit = match governor.try_acquire(request) {
                Admission::Granted(permit) => permit,
                Admission::Deferred(reason) => return Err(invalid(&format!("Work deferred: {reason:?}"))),
                Admission::Rejected(reason) => return Err(invalid(&format!("Work rejected: {reason:?}"))),
            };
            let started = Instant::now();
            let mut store = DiskStore::open(path, false)?;
            let mut after = 0;
            let mut rows_read = 0;
            let mut total_payload_bytes = 0;
            let mut revision = 0;
            for _ in 0..iterations {
                {
                    let rows = store.page(after, limit as usize)?;
                    rows_read += rows.len();
                    total_payload_bytes += rows.iter().map(|row| row.payload.len()).sum::<usize>();
                    after = rows.last().map(|row| row.id).unwrap_or(0);
                }
                revision = store.update(1, UPDATE_PAYLOAD)?.revision;
                std::thread::sleep(Duration::from_millis(hold_ms));
            }
            let summary = store.summarize()?;
            drop(store);
            drop(permit);
            emit(json!({
                "backend": "rust-rusqlite", "experimental": true,
                "iterations": iterations, "pageLimit": limit, "rowsRead": rows_read,
                "totalPayloadBytes": total_payload_bytes, "updateRevision": revision,
                "elapsedMs": started.elapsed().as_millis(), "store": summary,
                "finalReservations": governor.snapshot(),
            }))
        }
        _ => unreachable!(),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{}", json!({"error": error.to_string(), "experimental": true}));
        std::process::exit(1);
    }
}
