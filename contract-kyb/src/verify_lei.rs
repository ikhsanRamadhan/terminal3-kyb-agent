//! verify-lei: GLEIF Legal Entity Identifier lookup via HTTP inside the TEE.
//!
//! Calls `https://api.gleif.org/api/v1/lei-records/{LEI}` and returns
//! the entity's legal name, status, and jurisdiction. No API key required.

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct LeiInput {
    pub lei: String,
}

#[derive(serde::Serialize)]
pub struct LeiResult {
    pub lei: String,
    pub legal_name: String,
    pub status: String,
    pub hq_country: String,
    pub registration_date: String,
}

#[derive(Deserialize)]
struct GleifResponse {
    data: GleifData,
}

#[derive(Deserialize)]
struct GleifData {
    attributes: GleifAttributes,
}

#[derive(Deserialize)]
struct GleifAttributes {
    lei: String,
    entity: GleifEntity,
    #[serde(rename = "registrationDate")]
    registration_date: Option<String>,
    #[serde(rename = "status")]
    status: Option<String>,
}

#[derive(Deserialize)]
struct GleifEntity {
    #[serde(rename = "legalName")]
    legal_name: GleifLegalName,
    #[serde(rename = "headquartersAddress")]
    headquarters_address: Option<GleifAddress>,
}

#[derive(Deserialize)]
struct GleifLegalName {
    name: String,
}

#[derive(Deserialize)]
struct GleifAddress {
    country: Option<String>,
}

fn err_json(code: &str, detail: &str) -> String {
    format!("{{ \"code\": \"{code}\", \"detail\": \"{detail}\" }}")
}

pub fn verify(input: &[u8]) -> Result<Vec<u8>, String> {
    let req: LeiInput = serde_json::from_slice(input)
        .map_err(|e| err_json("BadInput", &format!("invalid JSON: {e}")))?;

    let lei = req.lei.trim().to_uppercase();
    if lei.len() != 20 {
        return Err(err_json("BadInput", "LEI must be exactly 20 characters"));
    }
    // LEI format: 4 alphanumeric + 2 digits + 14 alphanumeric
    if !lei.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(err_json("BadInput", "LEI must be alphanumeric only"));
    }

    let url = format!("https://api.gleif.org/api/v1/lei-records/{lei}");

    #[cfg(target_arch = "wasm32")]
    {
        use crate::host::interfaces::http;
        use crate::host::interfaces::logging;

        let _ = logging::info(&format!("verify-lei: {lei}"));

        let resp = http::call(&http::Request {
            method: http::Verb::Get,
            url: &url,
            headers: None,
            payload: None,
        })
        .map_err(|e| err_json("HttpError", &format!("GLEIF call failed: {e}")))?;

        if resp.code == 404 {
            return Err(err_json("NotFound", &format!("LEI {lei} not found in GLEIF")));
        }
        if resp.code != 200 {
            return Err(err_json(
                "HttpError",
                &format!("GLEIF returned HTTP {}", resp.code),
            ));
        }

        let gleif: GleifResponse = serde_json::from_slice(&resp.payload)
            .map_err(|e| err_json("ParseError", &format!("GLEIF response parse: {e}")))?;

        let attrs = &gleif.data.attributes;
        let result = LeiResult {
            lei: attrs.lei.clone(),
            legal_name: attrs.entity.legal_name.name.clone(),
            status: attrs.status.clone().unwrap_or_default(),
            hq_country: attrs
                .entity
                .headquarters_address
                .as_ref()
                .and_then(|a| a.country.clone())
                .unwrap_or_default(),
            registration_date: attrs.registration_date.clone().unwrap_or_default(),
        };

        serde_json::to_vec(&result).map_err(|e| err_json("SerializeError", &e.to_string()))
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = url;
        Err(err_json("NotWasm", "HTTP calls only available in wasm32 target"))
    }
}