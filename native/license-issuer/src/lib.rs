pub mod issuer;
pub mod permissions;
include!(concat!(env!("OUT_DIR"), "/trusted_keys.rs"));
