# Social post draft — bonus criterion

Bounty criterion 5: *"Bonus: sharing on social media tagging @terminal3io on X."*

Post the thread below, then tick the checklist item in `GOOGLE-DOC-DRAFT.md`
and paste the post URL into the submission doc.

---

## Option A — single post (recommended, highest completion rate)

> Built a confidential KYB compliance agent on @terminal3io's T3N testnet.
>
> EU VAT + GLEIF LEI verification runs inside a TEE — the counterparty
> identifiers you're screening never touch the calling app. Only the signed
> verdict leaves the enclave, and its SHA-256 is committed to the tx Merkle
> leaf so any auditor can verify it.
>
> The interesting part wasn't the crypto. EU VIES returns `isValid: false`
> both for "this VAT number is fake" AND for "the member state throttled
> you". Read it as a boolean and your compliance tool accuses a real company
> of fraud because a government API was busy.
>
> Caught it live mid-deploy: a Dutch supermarket came back
> MS_MAX_CONCURRENT_REQ. v0.2.0 reports UNKNOWN instead of a verdict.
>
> 8 platform bugs filed with measured repros. Full writeup + repo 👇
> https://github.com/ikhsanRamadhan/terminal3-kyb-agent

Attach: the `kyb-screen` output screenshot showing
`"vat_status":"UNKNOWN"` + `"inconclusive":["vat:MS_MAX_CONCURRENT_REQ"]`.
That single frame is the whole story.

---

## Option B — thread (more surface area, more effort)

**1/**
> Built a confidential KYB compliance agent on @terminal3io T3N testnet.
> Company identity verification (EU VAT + GLEIF LEI) inside a TEE.
> Only the verdict leaves the enclave. 🧵

**2/**
> Why a TEE for public-registry lookups? Because the *question* is the
> sensitive part. A KYB lookup reveals your pipeline: who you're onboarding,
> who you're diligencing, whose credit you're re-checking.
>
> Normal backend → that lands in logs, APM traces, and an LLM context window.

**3/**
> Every verdict is auditable. `set-claims-digest` commits SHA-256 of the
> certificate into the transaction's Merkle leaf.
>
> Anyone holding a certificate can recompute the hash offline and check it.
> No trusting my database.

**4/**
> The bug that shaped v0.2.0 wasn't in T3N — it was upstream.
>
> EU VIES returns `isValid: false` for BOTH "not registered" and "member state
> throttled you". Three requests seconds apart: VALID,
> MS_MAX_CONCURRENT_REQ, VALID. Same number.

**5/**
> Read as a boolean, that's a compliance tool calling a real company
> fraudulent because a government API was busy. Worst possible direction to
> be wrong in.
>
> Now: three-state VALID/INVALID/UNKNOWN. UNKNOWN forces risk_level UNKNOWN.
> Never scored as a negative.

**6/**
> It fired during the deploy's own test run — ALBERT HEIJN B.V. came back
> MS_MAX_CONCURRENT_REQ. Output says "re-run this", not "risky company".
>
> [screenshot]

**7/**
> Also filed 8 platform bugs with measured token costs and repros. Favourite:
> a KV value-size ceiling (508 bytes) reported as `access denied ... cannot
> write map`.
>
> An authorization decision can't depend on payload length. Cost me an hour
> in the ACL before bisecting sizes.

**8/**
> Full writeup, repro steps, handover runbook, measured token costs:
> https://github.com/ikhsanRamadhan/terminal3-kyb-agent
>
> Deployed and running on testnet. I intend to keep operating it.
> Thanks @terminal3io 🙏

---

## Notes

- Tag is **@terminal3io** on X — verify the handle before posting.
- Do not screenshot anything showing `T3N_API_KEY`. The tenant DID and the
  signing address are public identifiers and safe to show; the key is not.
  `npm run state` and `npm run health` print only safe fields.
- Post URL goes in the submission doc so the judge can find it.
