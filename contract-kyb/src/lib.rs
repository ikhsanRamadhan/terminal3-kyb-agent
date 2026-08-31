//! z-tenant-kyb — Confidential Know-Your-Business verification agent.
//!
//! All VIES/GLEIF calls happen inside the TEE via `host:interfaces/http`.
//! Company identifiers never leave the enclave; only the structured
//! verification result crosses the WIT boundary.
#![warn(clippy::style)]
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

extern crate alloc;

pub const CONTRACT_VERSION: &str = "0.1.0";

wit_bindgen::generate!({
    world: "tenant-kyb",
    path: "wit",
    additional_derives: [
        serde::Deserialize,
        serde::Serialize,
    ],
    generate_all,
});

mod verify_vat;
mod verify_lei;
mod kyb_screen;

struct Component;

#[cfg(target_arch = "wasm32")]
impl exports::z::tenant_kyb::contracts::Guest for Component {
    fn verify_vat(
        req: exports::z::tenant_kyb::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("verify-vat: missing input")?;
        verify_vat::verify(&input)
    }

    fn verify_lei(
        req: exports::z::tenant_kyb::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("verify-lei: missing input")?;
        verify_lei::verify(&input)
    }

    fn kyb_screen(
        req: exports::z::tenant_kyb::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("kyb-screen: missing input")?;
        let now_secs = crate::host::tenant::tenant_context::cluster_timestamp_secs();
        kyb_screen::screen(&input, now_secs)
    }
}

#[cfg(target_arch = "wasm32")]
export!(Component);