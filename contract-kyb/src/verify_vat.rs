//! verify-vat: EU VIES VAT validation, called from inside the TEE.
//!
//! `GET https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{CC}/vat/{NUM}`
//! No API key required.
//!
//! VIES overloads `isValid: false`. It means "this VAT number is not
//! registered" only when `userError == "INVALID"`. The same field is also
//! false when the member state's registry throttled or dropped the query —
//! `MS_MAX_CONCURRENT_REQ`, `MS_UNAVAILABLE`, `TIMEOUT`, `SERVICE_UNAVAILABLE`
//! and friends. Observed live: three requests a few seconds apart returned
//! VALID, MS_MAX_CONCURRENT_REQ, VALID for the same number.
//!
//! Reading `isValid` alone therefore turns an upstream hiccup into "this
//! company's VAT number is fake", which for a compliance tool is the worst
//! direction to be wrong in. This module reports a three-state `status`
//! instead, and callers must treat `UNKNOWN` as "no answer", not "no".

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use serde::Deserialize;

#[derive(Deserialize, serde::Serialize)]
pub struct VatInput {
    pub country: String,
    pub vat_number: String,
}

/// Outcome of a VIES query.
///
/// `VALID` / `INVALID` are answers from the registry. `UNKNOWN` means VIES
/// did not answer — the number is neither confirmed nor refuted.
#[derive(serde::Serialize)]
pub struct VatResult {
    /// "VALID" | "INVALID" | "UNKNOWN"
    pub status: String,
    /// True only for `status == "VALID"`. Kept for convenience; prefer `status`.
    pub valid: bool,
    /// True when VIES failed to answer, i.e. `status == "UNKNOWN"`.
    pub inconclusive: bool,
    /// Raw `userError` from VIES: VALID, INVALID, MS_MAX_CONCURRENT_REQ, …
    pub upstream_code: String,
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
    request_date: Option<String>,
    #[serde(rename = "userError")]
    user_error: Option<String>,
    name: Option<String>,
    address: Option<String>,
    #[serde(rename = "vatNumber")]
    vat_number: Option<String>,
}

fn err_json(code: &str, detail: &str) -> String {
    format!("{{ \"code\": \"{code}\", \"detail\": \"{detail}\" }}")
}

/// Classify a VIES reply into VALID / INVALID / UNKNOWN.
///
/// Pure, so the native test suite can exercise every branch without HTTP.
/// `is_valid == true` is always VALID. Otherwise only an explicit `INVALID`
/// counts as a real negative; every other code — and a missing code — is
/// UNKNOWN, because VIES does not distinguish "not registered" from
/// "registry did not answer" in `isValid`.
pub fn classify(is_valid: bool, user_error: Option<&str>) -> &'static str {
    if is_valid {
        return "VALID";
    }
    match user_error {
        Some("INVALID") => "INVALID",
        _ => "UNKNOWN",
    }
}

pub fn verify(input: &[u8]) -> Result<Vec<u8>, String> {
    let req: VatInput = serde_json::from_slice(input)
        .map_err(|e| err_json("BadInput", &format!("invalid JSON: {e}")))?;

    let country = req.country.trim().to_uppercase();
    let vat = req.vat_number.trim().to_string();

    if country.len() != 2 || !country.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err(err_json("BadInput", "country must be a 2-letter ISO code"));
    }
    if vat.is_empty() || vat.len() > 15 || !vat.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(err_json("BadInput", "vat_number must be 1..=15 alphanumerics"));
    }

    let url =
        format!("https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{country}/vat/{vat}");

    #[cfg(target_arch = "wasm32")]
    {
        use crate::host::interfaces::http;
        use crate::host::interfaces::logging;

        let _ = logging::info(&format!("verify-vat: {country}/{vat}"));

        let resp = http::call(&http::Request {
            method: http::Verb::Get,
            url: url.clone(),
            headers: None,
            payload: None,
        })
        .map_err(|e| err_json("HttpError", &format!("VIES call failed: {e}")))?;

        // VIES answers 200 even for INVALID; anything else is a transport or
        // service problem, which is inconclusive rather than a negative.
        if resp.code != 200 {
            let _ = logging::error(&format!("VIES HTTP {}", resp.code));
            let result = VatResult {
                status: String::from("UNKNOWN"),
                valid: false,
                inconclusive: true,
                upstream_code: format!("HTTP_{}", resp.code),
                name: String::from("---"),
                address: String::from("---"),
                request_date: String::new(),
                country,
                vat_number: vat,
            };
            return serde_json::to_vec(&result)
                .map_err(|e| err_json("SerializeError", &e.to_string()));
        }

        let vies: ViesResponse = serde_json::from_slice(&resp.payload)
            .map_err(|e| err_json("ParseError", &format!("VIES response parse: {e}")))?;

        let upstream_code = vies.user_error.clone().unwrap_or_default();
        let status = classify(vies.is_valid, vies.user_error.as_deref());

        if status == "UNKNOWN" {
            let _ = logging::error(&format!(
                "VIES inconclusive for {country}/{vat}: {upstream_code}"
            ));
        }

        let result = VatResult {
            status: String::from(status),
            valid: status == "VALID",
            inconclusive: status == "UNKNOWN",
            upstream_code,
            name: vies.name.unwrap_or_else(|| String::from("---")),
            address: vies.address.unwrap_or_else(|| String::from("---")),
            request_date: vies.request_date.unwrap_or_default(),
            country,
            vat_number: vies.vat_number.unwrap_or(vat),
        };

        serde_json::to_vec(&result).map_err(|e| err_json("SerializeError", &e.to_string()))
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = url;
        Err(err_json("NotWasm", "HTTP calls only available in wasm32 target"))
    }
}

#[cfg(test)]
mod tests {
    use super::classify;

    #[test]
    fn valid_is_valid_regardless_of_code() {
        assert_eq!(classify(true, Some("VALID")), "VALID");
        assert_eq!(classify(true, None), "VALID");
    }

    #[test]
    fn only_explicit_invalid_is_a_negative() {
        assert_eq!(classify(false, Some("INVALID")), "INVALID");
    }

    /// The bug this module exists to prevent: a throttled query must never
    /// read as "VAT number not registered".
    #[test]
    fn throttling_and_outages_are_unknown() {
        for code in [
            "MS_MAX_CONCURRENT_REQ",
            "MS_UNAVAILABLE",
            "SERVICE_UNAVAILABLE",
            "TIMEOUT",
            "GLOBAL_MAX_CONCURRENT_REQ",
            "INVALID_INPUT",
        ] {
            assert_eq!(classify(false, Some(code)), "UNKNOWN", "code {code}");
        }
        assert_eq!(classify(false, None), "UNKNOWN");
    }
}
