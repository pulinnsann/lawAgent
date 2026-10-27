#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod host;
mod platform;
mod diagnostics;
#[cfg(feature = "desktop-smoke")]
mod smoke;

fn main() {
    host::run();
}
