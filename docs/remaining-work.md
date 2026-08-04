# What's left — every line of both specs, checked against the build

Audited 2026-08-04 against the two source documents:

- **REQ** — `for corofy dashboard.pdf` (the client's own requirements + Loom links)
- **WT** — `Campaign Analytics Dashboard — What You'll See.pdf` (walkthrough §1–§11)

Every row below was verified against the running code or the live API, not from
memory. `✅` means built and working in production today.

---

## The one that changes the most: the Replies view

REQ page 2 calls this **VIEW 3** and gives it a third of the document. WT §5.5
specifies it in full. **It is the single largest missing piece**, and everything
in this section is currently unbuilt.

It was cut from v1 for a stated reason — the plan said syncing 70K leads was "a
day-long job with zero v1 payoff". **Two facts found during this audit make that
reasoning obsolete:**

1. **We only need 6,675 leads, not 69,794.** Every one of the 7,988 replies
   carries a `lead_id`, and only 6,675 distinct people have ever replied. The
   breakdowns are *of repliers*, so the other 63,000 leads are irrelevant.
2. **EmailBison already holds every attribute the client asked for**, on
   `custom_variables` — verified against live leads:

   | REQ asks for | EmailBison field | Sample value | Coverage in sample |
   |---|---|---|---|
   | Brokerage | `company` | `Keller Williams South Park` | 15/15 |
   | Office / brand | `office city` | `Charlotte, NC` | 15/15 |
   | City / county | `office city`, `top producing city` | `Charlotte, NC` | 15/15 |
   | Sales-volume buckets | `sales volume` | `$1,001,000` | 15/15 |
   | Company | `company` | — | 15/15 |

   Also available and not asked for, but cheap to carry: `mls affiliation`,
   `estimated gci`, `closed transactions`, `average sales price`, `buy-side`,
   `list-side`, `closed rentals`, `courted profile`.

**Sales volume needs parsing, and that is the one real risk.** It arrives as a
formatted string (`"$1,001,000"`), so bucketing means parsing currency text. A
value that fails to parse must land in an explicit "unknown" bucket and be
counted there — never silently dropped, or the bars will quietly under-report.

### Work

| # | Item | Notes |
|---|---|---|
| R1 | `leads` + `lead_attributes` tables | Keyed on EmailBison lead id; attributes stored long (name/value) so a new custom variable is a row, not a migration |
| R2 | `sync-leads` job | Scoped to leads that appear in `replies`. One-time ~700 calls at 100/page; incremental thereafter |
| R3 | Sales-volume bucketing | Parse currency strings into bands; unparseable → explicit `unknown` bucket, reported |
| R4 | `reply_dimension_config` | WT §5.5: "These groupings are configurable per client… another client can be set up with their own list without a rebuild" |
| R5 | Replies sub-view UI | Breakdown cards (bar charts) per dimension, each with its own reply count and an honest "No data available" |
| R6 | All-replies / positive-only toggle | REQ: "toggle positive vs all replies". Switches every chart at once |
| R7 | The reply list underneath | Filterable by the same attributes |
| R8 | Reply filters in the filter bar | REQ: brokerage, office/brand, city/county, sales-volume, company |
| R9 | **Log an outcome from a reply** | WT §5.5 + §7: "Outcomes reach the system two ways: logged by hand from a reply, or fed in automatically." Only the automatic half exists |

> R9 note: the outcomes table already models this correctly — a hand-logged
> outcome is just a row with `source_platform = 'direct'`, which the resolver
> already knows how to attribute. The write path and the UI are what's missing.

---

## Metric definitions that are wrong or missing

| # | Item | Status |
|---|---|---|
| M1 | **"Positive" reads 113 where the reference showed 389** | **Blocked on a decision.** `replies.interested` is set on 115 of 7,988 replies (1.4%); the reference implies ~10%. Distorts Positive, Positive Rate (2.9% vs 10.6%) and Lead-to-Email (1:2,062 vs 1:700). Cannot be fixed by code — needs to know what counts as positive |
| M2 | **Sentiment `−` (negative)** | Column exists and renders, but nothing populates it. WT §5.3 and REQ both list it. Needs a category vocabulary — same decision as M1 |
| M3 | **Bounces split soft / hard** | REQ page 2: "Bounces (soft/hard)". Only a combined total today. Need to confirm EmailBison exposes the split |
| M4 | **Average Reply Time** | REQ page 2 lists "Reply Time, **Average** Reply Time" as two things, and the outfound reference shows "Avg Reply Time 8.4d". We ship median only. Median is the better statistic for skewed reply data — recommend keeping it and *adding* mean rather than swapping |

---

## Missing columns

| # | Where | Missing |
|---|---|---|
| C1 | Copy & Offer table | **Positive, Negative, Neutral, Meetings** as raw counts (WT §6.1 lists 9 columns; we show 5) |
| C2 | Campaigns table | **Median Follow-up** (WT §5.3) |
| C3 | Campaigns table | **Events group: Signups, Meetings, Visits, Customers, E:S, E:M** (WT §5.3 + §7: "The same event counts also appear as optional columns in the Campaigns table") |
| C4 | Offers | Roll up by client / brand (REQ page 1: "aggregate positive-rate by client/brand"; WT §6.2) |

C3 is now cheap — `outcome_events` is populated and already joins to campaign.

---

## Filter bar

| # | Item | Status |
|---|---|---|
| F1 | **Platform filter** | Missing. WT §3 specifies it with removable chips; REQ page 3 highlights it. **This is now real, not cosmetic** — the outcomes feed proved EmailBison and Instantly are both live sending platforms, and `outcome_events.source_platform` already distinguishes them. Note: only outcomes carry platform today; campaign/reply data is EmailBison-only, so the filter's scope needs deciding |

---

## Campaign management gaps

| # | Item | Spec | Status |
|---|---|---|---|
| G1 | **Drag to reorder steps** | WT §9.3 | Not built |
| G2 | **Warn on leaving with unsaved edits** | WT §9.3: "If you try to leave with unsaved edits, you'll be warned. Nothing goes live by accident." | Dirty state is tracked; no navigation guard |
| G3 | **Rich text formatting** | WT §9.3: "Write the email with formatting" | Plain textarea today |
| G4 | **Insert placeholders from a menu** | WT §9.3: "rather than typing them by hand" | Not built |
| G5 | **Copy & Offer as its own detail tab** | WT §9.2 lists 5 tabs | Panel exists but is nested inside Sequence; detail has 4 tabs |
| G6 | **Tag filter on the campaign list** | WT §9.1, REQ page 4 | Search and status filters exist; tag filter does not |

---

## Already done — no action

Verified working in production, not just present in code.

**WT §1–§4** · four tabs · five screens · quick ranges · date range with Apply ·
Campaigns and Clients filters with search · Compare previous with named period ·
filters in the URL and shareable · 12 headline tiles (the 10 specified plus Human
Replies and Human Rate) · compact/exact number formatting · dash instead of a
misleading zero.

**WT §5.1–§5.4** · Volume/Rates · five series toggles with entity-fixed colours ·
Normalize · Exclude weekends · crosshair tooltip · faded compare overlay · last
good data kept on error · three-level expansion · medals above a sample floor ·
column picker with groups and search, persisted · pinned first column ·
Preview / Spintax / Shuffle / BLUEPRINT · placeholders shown as-is.

**WT §6** seven dimensions · five subject-line types · offers as first-class
entities · medals · red bounce rate · tagging in the sequence editor.

**WT §7** all outcome types · all three conversion measures · first-touch
attribution · coverage reporting · every event visible.

**WT §8** inbox / domain / provider breakdowns · problem accounts by bounce rate ·
sending forecast.

**WT §9.1–§9.2, §9.4–§9.5** status tabs with live counts · More menu covering
every status · search · list/grid toggle · Pause / Resume / Duplicate / Copy
sequence / Archive · Overview with progress, funnel and stats · Activity log ·
the five-step guided copy flow with preview, Replace/Append and named
confirmation · previous sequence recorded before overwrite · honest failure
reporting.

**WT §10** sending schedule. **WT §11** every carry-over item.

**REQ page 4** all six statuses · campaign detail with steps and subject lines.

---

## Suggested order

1. **M1 + M2 (the Positive definition).** Everything downstream — Positive Rate,
   Lead-to-Email, Sentiment, the Copy table's sort column, medal ranking — is
   computed from it. Building C1 on a definition that changes means building it
   twice. **This needs an answer, not code.**
2. **C1–C4 + F1 + G5/G6.** Small, independent, no new data. A day of work that
   closes most of the "missing column" surface.
3. **The Replies view (R1–R9).** The largest piece, now unblocked by the lead
   attribute finding. R1–R3 first (data), then R5–R7 (UI), then R4 and R8, with
   R9 last since it depends on the reply list existing.
4. **G1–G4 (editor polish).** Real work, lowest risk to numbers.
5. **M3/M4** once confirmed EmailBison exposes the soft/hard split.

## Open questions I cannot answer from the data

- **What counts as "Positive"?** (M1) — blocks the most.
- **Is there a negative/neutral vocabulary**, or should sentiment stay `+`/`~`? (M2)
- **Should the Platform filter scope the whole dashboard**, when only outcomes
  currently carry a platform? (F1)
- **Where do credits come from?** The meter is built and renders nothing by
  design until it has a source.
