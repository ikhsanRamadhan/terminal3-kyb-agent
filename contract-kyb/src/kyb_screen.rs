//! kyb-screen: combined KYB verdict — VAT + LEI + risk scoring.
//!
//! Orchestrates `verify-vat` and `verify-lei`, scores the result, persists the
//! certificate to `z:<tid>:kyb-results`, and commits its SHA-256 to the
//! transaction's Merkle leaf via `set-claims-digest`.
//!
//! Scoring rule that matters: an upstream that did not answer is never scored
//! as a negative finding. VIES reports throttling as `isValid: false` (see
//! `verify_vat::classify`), so treating "no answer" as "not registered" would
//! flag legitimate companies as risky whenever the registry is busy. Anything
//! inconclusive lands in `inconclusive[]` and forces `risk_level: "UNKNOWN"`,
//! which a caller must handle as "re-run this", not as a pass or a fail.
//!
//! Size rule that matters just as much: the certificate is persisted to KV, and
//! a KV value has a hard ceiling of 508 bytes on this cluster (BUGS.md B1 —
//! 508 accepted, 512 rejected, and the refusal is reported as `access denied`).
//! Three things follow, and all three are consequences of that one measurement:
//!
//! - The subject's own name is **not** a field. B1 also established that the
//!   *key* does not count toward the value ceiling, and the key already is
//!   `<company>:<timestamp>` — so storing `company` in the value again would
//!   spend 49 of a 508-byte budget on a duplicate.
//! - Registry names are clipped to `MAX_NAME`. Legal names run to 67 bytes in
//!   the wild and two of them plus a 64-char digest is most of the budget.
//! - Derivable fields are not stored at all: `vat_status` subsumes the old
//!   `vat_valid`, and the two LEI statuses subsume the old `lei_valid`.
//!
//! `tests::worst_case_certificate_fits_kv_limit` asserts the bound with every
//! field at its type maximum, so adding a field cannot quietly reintroduce B1.

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

/// The certificate persisted to `z:<tid>:kyb-results` and returned to the
/// caller. One shape, so the digest the caller receives is the digest of the
/// bytes actually stored.
///
/// The subject is identified by the KV key (`<company>:<timestamp>`), not by a
/// field — see the module comment for why. `vat_name` is the name the tax
/// registry holds for that VAT number, which is the one worth auditing anyway.
#[derive(serde::Serialize)]
pub struct KybResult {
    /// "VALID" | "INVALID" | "UNKNOWN". Replaces the old `vat_valid` bool,
    /// which could not distinguish "not registered" from "VIES did not answer".
    pub vat_status: String,
    pub vat_name: String,
    /// "NOT_PROVIDED" | "NOT_FOUND" | "UNKNOWN" | GLEIF status (ISSUED/LAPSED/…).
    /// A LEI resolved iff this is none of the first three.
    pub lei_registration_status: String,
    /// "NOT_PROVIDED" | "NOT_FOUND" | "UNKNOWN" | ACTIVE | INACTIVE.
    pub lei_entity_status: String,
    pub lei_name: String,
    pub risk_score: u8,
    /// "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN". UNKNOWN when a source did not answer.
    pub risk_level: String,
    /// Which checks could not be completed, e.g. `vat:MS_MAX_CONCURRENT_REQ`.
    /// Non-empty ⇒ risk_level == "UNKNOWN".
    pub inconclusive: Vec<String>,
    pub timestamp: u64,
    pub contract_id: u32,
    pub digest: String,
}

/// Hard ceiling on a single KV value, measured on this cluster: 508 bytes
/// accepted, 512 rejected (BUGS.md B1). Exceeding it fails the write with a
/// message that names the permission subsystem, not the size, so the bound is
/// enforced here instead of being discovered in production.
const KV_VALUE_LIMIT: usize = 508;

/// Longest registry name persisted in a certificate.
const MAX_NAME: usize = 40;

/// Longest upstream status code persisted. Longest VIES `userError` observed is
/// `GLOBAL_MAX_CONCURRENT_REQ` (25).
const MAX_CODE: usize = 25;

/// Longest company fragment used to build the KV *key*. Keys do not count
/// toward `KV_VALUE_LIMIT` (B1), but they should still be bounded.
const MAX_KEY_NAME: usize = 96;

/// Clip to a byte budget on a char boundary. Byte-bounded rather than
/// char-bounded because the KV limit is in bytes and registry names are not
/// guaranteed ASCII; `&s[..n]` would panic mid-codepoint.
fn clip(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return String::from(s);
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    String::from(&s[..end])
}

fn err_json(code: &str, detail: &str) -> String {
    format!("{{ \"code\": \"{code}\", \"detail\": \"{detail}\" }}")
}

#[cfg(target_arch = "wasm32")]
fn tenant_map(tail: &str) -> String {
    let tid = crate::host::tenant::tenant_context::tenant_did();
    format!("z:{}:{tail}", hex::encode(&tid))
}

/// Map an additive risk score to a band. Pure, so it is unit-testable.
/// `has_inconclusive` wins over the score: a partial answer is not a verdict.
pub fn risk_band(score: u8, has_inconclusive: bool) -> &'static str {
    if has_inconclusive {
        return "UNKNOWN";
    }
    match score {
        0 => "LOW",
        1..=40 => "MEDIUM",
        _ => "HIGH",
    }
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

        let mut inconclusive: Vec<String> = Vec::new();

        // 1. VAT
        let vat_input = serde_json::to_vec(&verify_vat::VatInput {
            country: req.vat_country.clone(),
            vat_number: req.vat_number.clone(),
        })
        .map_err(|e| err_json("SerializeError", &e.to_string()))?;

        let (vat_status, vat_name, vat_upstream_code) = match verify_vat::verify(&vat_input) {
            Ok(bytes) => {
                let r: serde_json::Value = serde_json::from_slice(&bytes)
                    .map_err(|e| err_json("ParseError", &format!("vat result: {e}")))?;
                (
                    r["status"].as_str().unwrap_or("UNKNOWN").to_string(),
                    r["name"].as_str().unwrap_or("---").to_string(),
                    r["upstream_code"].as_str().unwrap_or("").to_string(),
                )
            }
            Err(e) => {
                let _ = logging::error(&format!("VAT check failed: {e}"));
                (
                    String::from("UNKNOWN"),
                    String::from("---"),
                    String::from("CALL_FAILED"),
                )
            }
        };
        if vat_status == "UNKNOWN" {
            let code = if vat_upstream_code.is_empty() {
                String::from("NO_CODE")
            } else {
                clip(&vat_upstream_code, MAX_CODE)
            };
            inconclusive.push(format!("vat:{code}"));
        }

        // 2. LEI (optional)
        let (lei_valid, lei_name, lei_registration_status, lei_entity_status) =
            match req.lei.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(lei) => {
                    let lei_input = serde_json::to_vec(&serde_json::json!({ "lei": lei }))
                        .map_err(|e| err_json("SerializeError", &e.to_string()))?;
                    match verify_lei::verify(&lei_input) {
                        Ok(bytes) => {
                            let r: serde_json::Value = serde_json::from_slice(&bytes)
                                .map_err(|e| err_json("ParseError", &format!("lei result: {e}")))?;
                            (
                                true,
                                r["legal_name"].as_str().unwrap_or("").to_string(),
                                r["registration_status"].as_str().unwrap_or("").to_string(),
                                r["entity_status"].as_str().unwrap_or("").to_string(),
                            )
                        }
                        Err(e) => {
                            // A GLEIF NotFound is a finding; anything else is
                            // an outage and must not be scored as one.
                            let not_found = e.contains("NotFound");
                            let _ = logging::error(&format!("LEI check failed: {e}"));
                            if !not_found {
                                inconclusive.push(String::from("lei:CALL_FAILED"));
                            }
                            (
                                false,
                                String::new(),
                                String::from(if not_found { "NOT_FOUND" } else { "UNKNOWN" }),
                                String::from(if not_found { "NOT_FOUND" } else { "UNKNOWN" }),
                            )
                        }
                    }
                }
                None => (
                    false,
                    String::new(),
                    String::from("NOT_PROVIDED"),
                    String::from("NOT_PROVIDED"),
                ),
            };

        // 3. Risk — only conclusive signals contribute.
        let mut risk: u8 = 0;
        if vat_status == "INVALID" {
            risk += 40;
        }
        if lei_registration_status == "NOT_FOUND" {
            risk += 30;
        }
        if lei_registration_status == "LAPSED" || lei_registration_status == "RETIRED" {
            risk += 20;
        }
        if lei_entity_status == "INACTIVE" {
            risk += 20;
        }
        if vat_status == "VALID" && lei_valid {
            let a = vat_name.to_lowercase();
            let b = lei_name.to_lowercase();
            if a != "---" && !a.is_empty() && !b.is_empty() && a != b {
                risk += 10;
            }
        }

        let risk_level = risk_band(risk, !inconclusive.is_empty());
        if risk_level == "UNKNOWN" {
            let _ = logging::error(&format!(
                "kyb-screen inconclusive for {}: {:?}",
                req.company, inconclusive
            ));
        }

        // 4. Certificate, then its digest over the digest-free form.
        // Every unbounded field is clipped here so the serialized certificate
        // cannot exceed KV_VALUE_LIMIT — see the module comment and B1.
        let contract_id = crate::host::tenant::tenant_context::contract_id();
        let result = KybResult {
            vat_status: vat_status.clone(),
            vat_name: clip(&vat_name, MAX_NAME),
            lei_registration_status: clip(&lei_registration_status, MAX_CODE),
            lei_entity_status: clip(&lei_entity_status, MAX_CODE),
            lei_name: clip(&lei_name, MAX_NAME),
            risk_score: risk,
            risk_level: String::from(risk_level),
            inconclusive,
            timestamp: now_secs,
            contract_id,
            digest: String::new(),
        };

        let unsigned =
            serde_json::to_vec(&result).map_err(|e| err_json("SerializeError", &e.to_string()))?;
        let hash = Sha256::digest(&unsigned);
        let result = KybResult {
            digest: hex::encode(hash),
            ..result
        };
        let result_bytes =
            serde_json::to_vec(&result).map_err(|e| err_json("SerializeError", &e.to_string()))?;

        // 5. Persist + commit the digest into this tx's Merkle leaf.
        // The bound is enforced by construction and by a unit test, so this can
        // only fire if the cluster's ceiling moved — worth a log line rather
        // than a surprise `access denied` (B1).
        if result_bytes.len() > KV_VALUE_LIMIT {
            let _ = logging::error(&format!(
                "certificate is {} bytes, over the {KV_VALUE_LIMIT}-byte KV ceiling",
                result_bytes.len()
            ));
        }
        let map_name = tenant_map("kyb-results");
        // The key carries the subject; the value does not repeat it (B1: keys do
        // not count toward the value ceiling). Bounded anyway.
        let key = format!(
            "{}:{}",
            clip(&req.company.trim().to_lowercase().replace(' ', "_"), MAX_KEY_NAME),
            now_secs
        );
        if let Err(e) = kv_store::put(&map_name, key.as_bytes(), &result_bytes) {
            // Surfaced, not swallowed: a certificate that was not stored is
            // not auditable, and the ACL-after-redeploy failure (BUGS.md B3)
            // shows up exactly here.
            return Err(err_json("KvWriteFailed", &format!("{map_name}: {e}")));
        }
        let _ = kv_store::set_claims_digest(&hash);

        let _ = logging::info(&format!(
            "kyb-screen done: {} vat={vat_status} risk={risk_level}",
            req.company
        ));

        Ok(result_bytes)
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = now_secs;
        Err(err_json("NotWasm", "HTTP calls only available in wasm32 target"))
    }
}

#[cfg(test)]
mod tests {
    use super::{clip, risk_band, KybResult, KV_VALUE_LIMIT, MAX_CODE, MAX_NAME};
    use alloc::string::String;
    use alloc::vec;

    #[test]
    fn bands_follow_the_score() {
        assert_eq!(risk_band(0, false), "LOW");
        assert_eq!(risk_band(10, false), "MEDIUM");
        assert_eq!(risk_band(40, false), "MEDIUM");
        assert_eq!(risk_band(41, false), "HIGH");
        assert_eq!(risk_band(90, false), "HIGH");
    }

    /// An unanswered source outranks the score: a partial check is not a verdict.
    #[test]
    fn inconclusive_overrides_every_band() {
        assert_eq!(risk_band(0, true), "UNKNOWN");
        assert_eq!(risk_band(90, true), "UNKNOWN");
    }

    #[test]
    fn clip_is_byte_bounded_and_never_splits_a_codepoint() {
        assert_eq!(clip("SIEMENS", 36), "SIEMENS");
        assert_eq!(clip(&"x".repeat(80), 36).len(), 36);
        // 'é' is two bytes: clipping at 5 must drop it rather than halve it.
        assert_eq!(clip("abcdé", 5), "abcd");
        assert!(clip("ÆØÅ", 4).len() <= 4);
    }

    /// The bound this module exists to guarantee. A KV value over ~508 bytes is
    /// refused with a message that blames permissions (BUGS.md B1), so the
    /// worst-case certificate has to fit — every field at its *type* maximum,
    /// not merely at a plausible maximum, so that adding a field or widening a
    /// bound cannot quietly reintroduce B1.
    #[test]
    fn worst_case_certificate_fits_kv_limit() {
        let max_name = "N".repeat(MAX_NAME);
        let max_code = "C".repeat(MAX_CODE);
        let worst = KybResult {
            vat_status: String::from("UNKNOWN"),
            vat_name: max_name.clone(),
            lei_registration_status: max_code.clone(),
            lei_entity_status: max_code.clone(),
            lei_name: max_name,
            risk_score: u8::MAX,
            risk_level: String::from("UNKNOWN"),
            inconclusive: vec![
                alloc::format!("vat:{max_code}"),
                alloc::format!("lei:{max_code}"),
            ],
            timestamp: u64::MAX,
            contract_id: u32::MAX,
            digest: "d".repeat(64),
        };
        let bytes = serde_json::to_vec(&worst).expect("certificate serializes");
        assert!(
            bytes.len() <= KV_VALUE_LIMIT,
            "worst-case certificate is {} bytes, KV ceiling is {KV_VALUE_LIMIT} \
             (BUGS.md B1) — lower MAX_NAME/MAX_CODE or drop a field",
            bytes.len()
        );
    }
}
