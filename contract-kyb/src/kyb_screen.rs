//! kyb-screen: Combined KYB verification — VAT + LEI + risk scoring.
//!
//! Orchestrates verify-vat and verify-lei, computes a simple risk score,
//! persists the result to KV, and commits a SHA-256 digest for audit.

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
pub struct KybInput {
    pub company: String,
    pub vat_country: String,
    pub vat_number: String,
    #[serde(default)]
    pub lei: Option<String>,
}

#[derive(serde::Serialize)]
pub struct KybResult {
    pub company: String,
    pub vat_valid: bool,
    pub vat_name: String,
    pub lei_valid: bool,
    pub lei_name: String,
    pub lei_registration_status: String,
    pub lei_entity_status: String,
    pub risk_score: u8,
    pub risk_level: String,
    pub timestamp: u64,
    pub contract_id: u32,
    pub digest: String,
}

fn err_json(code: &str, detail: &str) -> String {
    format!("{{ \"code\": \"{code}\", \"detail\": \"{detail}\" }}")
}

#[cfg(target_arch = "wasm32")]
fn tenant_map(tail: &str) -> String {
    let tid = crate::host::tenant::tenant_context::tenant_did();
    format!("z:{}:{tail}", hex::encode(&tid))
}

pub fn screen(input: &[u8], now_secs: u64) -> Result<Vec<u8>, String> {
    let req: KybInput = serde_json::from_slice(input)
        .map_err(|e| err_json("BadInput", &format!("invalid JSON: {e}")))?;

    if req.company.trim().is_empty() {
        return Err(err_json("BadInput", "company name required"));
    }
    if req.vat_country.trim().is_empty() || req.vat_number.trim().is_empty() {
        return Err(err_json("BadInput", "vat_country and vat_number required"));
    }

    #[cfg(target_arch = "wasm32")]
    {
        use crate::host::interfaces::kv_store;
        use crate::host::interfaces::logging;
        use crate::verify_lei;
        use crate::verify_vat;

        let _ = logging::info(&format!("kyb-screen: {}", req.company));

        // 1. VAT verification
        let vat_input = serde_json::to_vec(&serde_json::json!({
            "country": req.vat_country,
            "vat_number": req.vat_number,
        }))
        .map_err(|e| err_json("SerializeError", &e.to_string()))?;

        let (vat_valid, vat_name) = match verify_vat::verify(&vat_input) {
            Ok(bytes) => {
                let r: serde_json::Value = serde_json::from_slice(&bytes)
                    .map_err(|e| err_json("ParseError", &format!("vat result: {e}")))?;
                (
                    r["valid"].as_bool().unwrap_or(false),
                    r["name"].as_str().unwrap_or("---").to_string(),
                )
            }
            Err(e) => {
                let _ = logging::error(&format!("VAT check failed: {e}"));
                (false, String::from("ERROR"))
            }
        };

        // 2. LEI verification (optional)
        let (lei_valid, lei_name, lei_status) = if let Some(ref lei) = req.lei {
            if !lei.is_empty() {
                let lei_input = serde_json::to_vec(&serde_json::json!({ "lei": lei }))
                    .map_err(|e| err_json("SerializeError", &e.to_string()))?;
                match verify_lei::verify(&lei_input) {
                    Ok(bytes) => {
                        let r: serde_json::Value = serde_json::from_slice(&bytes)
                            .map_err(|e| err_json("ParseError", &format!("lei result: {e}")))?;
                        (
                            true,
                            r["legal_name"].as_str().unwrap_or("").to_string(),
                            r["status"].as_str().unwrap_or("").to_string(),
                        )
                    }
                    Err(e) => {
                        let _ = logging::error(&format!("LEI check failed: {e}"));
                        (false, String::from("ERROR"), String::from("NOT_FOUND"))
                    }
                }
            } else {
                (false, String::new(), String::from("NOT_PROVIDED"))
            }
        } else {
            (false, String::new(), String::from("NOT_PROVIDED"))
        };

        // 3. Risk scoring
        let mut risk: u8 = 0;
        if !vat_valid {
            risk += 40;
        }
        if req.lei.is_some() && !lei_valid {
            risk += 30;
        }
        if vat_valid && lei_valid {
            // Cross-check: names should roughly match
            let vat_lower = vat_name.to_lowercase();
            let lei_lower = lei_name.to_lowercase();
            if !vat_lower.is_empty() && !lei_lower.is_empty() && vat_lower != lei_lower {
                risk += 10; // minor discrepancy
            }
        }
        let risk_level = match risk {
            0..=10 => "LOW",
            11..=40 => "MEDIUM",
            _ => "HIGH",
        };

        // 4. Build result
        let contract_id = crate::host::tenant::tenant_context::contract_id();
        let result = KybResult {
            company: req.company.clone(),
            vat_valid,
            vat_name,
            lei_valid,
            lei_name,
            lei_registration_status,
            lei_entity_status,
            risk_score: risk,
            risk_level: risk_level.to_string(),
            timestamp: now_secs,
            contract_id,
            digest: String::new(), // filled below
        };

        // 5. Compute digest
        let result_json = serde_json::to_vec(&result)
            .map_err(|e| err_json("SerializeError", &e.to_string()))?;
        let mut hasher = Sha256::new();
        hasher.update(&result_json);
        let hash = hasher.finalize();
        let digest = hex::encode(hash);

        let result = KybResult { digest, ..result };

        // 6. Persist to KV
        let map_name = tenant_map("kyb-results");
        let key = format!("{}:{}", req.company.to_lowercase().replace(' ', "_"), now_secs);
        let result_bytes = serde_json::to_vec(&result)
            .map_err(|e| err_json("SerializeError", &e.to_string()))?;

        let _ = kv_store::put(&map_name, key.as_bytes(), &result_bytes);

        // 7. Commit digest for Merkle audit trail
        let _ = kv_store::set_claims_digest(&hash);

        let _ = logging::info(&format!(
            "kyb-screen complete: {} risk={}",
            req.company, risk_level
        ));

        Ok(result_bytes)
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        Err(err_json("NotWasm", "HTTP calls only available in wasm32 target"))
    }
}