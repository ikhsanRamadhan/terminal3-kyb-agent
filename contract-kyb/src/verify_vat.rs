//! verify-vat: EU VIES VAT number validation via HTTP inside the TEE.
//!
//! Calls `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{CC}/vat/{NUM}`
//! and returns the structured response. No API key required.

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct VatInput {
    pub country: String,
    pub vat_number: String,
}

#[derive(serde::Serialize)]
pub struct VatResult {
    pub valid: bool,
    pub name: String,
    pub address: String,
    pub request_date: String,
    pub country: String,
    pub vat_number: String,
}

#[derive(Deserialize)]
struct ViesResponse {
    #[serde(rename = "isValid")]
    is_valid: bool,
    #[serde(rename = "requestDate")]
    request_date: String,
    name: String,
    address: String,
    #[serde(rename = "vatNumber")]
    vat_number: String,
}

fn err_json(code: &str, detail: &str) -> String {
    format!("{{ \"code\": \"{code}\", \"detail\": \"{detail}\" }}")
}

pub fn verify(input: &[u8]) -> Result<Vec<u8>, String> {
    let req: VatInput = serde_json::from_slice(input)
        .map_err(|e| err_json("BadInput", &format!("invalid JSON: {e}")))?;

    let country = req.country.trim().to_uppercase();
    let vat = req.vat_number.trim().to_string();

    if country.len() != 2 {
        return Err(err_json("BadInput", "country must be a 2-letter ISO code"));
    }
    if vat.is_empty() || vat.len() > 15 {
        return Err(err_json("BadInput", "vat_number must be 1..=15 chars"));
    }

    let url = format!(
        "https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{country}/vat/{vat}"
    );

    #[cfg(target_arch = "wasm32")]
    {
        use crate::host::interfaces::http;
        use crate::host::interfaces::logging;

        let _ = logging::info(&format!("verify-vat: {country}/{vat}"));

        let resp = http::call(&http::Request {
            method: http::Verb::Get,
            url: &url,
            headers: None,
            payload: None,
        })
        .map_err(|e| err_json("HttpError", &format!("VIES call failed: {e}")))?;

        if resp.code != 200 {
            return Err(err_json(
                "HttpError",
                &format!("VIES returned HTTP {}", resp.code),
            ));
        }

        let vies: ViesResponse = serde_json::from_slice(&resp.payload)
            .map_err(|e| err_json("ParseError", &format!("VIES response parse: {e}")))?;

        let result = VatResult {
            valid: vies.is_valid,
            name: vies.name,
            address: vies.address,
            request_date: vies.request_date,
            country,
            vat_number: vies.vat_number,
        };

        serde_json::to_vec(&result).map_err(|e| err_json("SerializeError", &e.to_string()))
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = url;
        Err(err_json("NotWasm", "HTTP calls only available in wasm32 target"))
    }
}