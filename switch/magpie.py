#!/usr/bin/env python3
"""Magpie GST Close Room client for Switch agents (stdlib only, one file).

Use it as a CLI (`python3 magpie.py --help`) or import it as a library:

    import magpie
    magpie.gst_exceptions("2026-10", type="NOT_IN_2B")
    magpie.decide_itc(exception_id, "defer", approved_by="Asha (accountant)")

Configuration comes from the environment, or from a `magpie.env` file (KEY=VALUE
lines) next to this script or in the current directory. The token is never printed.

    MAGPIE_API_URL         e.g. http://localhost:3000
    MAGPIE_SWITCH_TOKEN    Switch bearer token
    SWITCH_AGENT_NAME      your role name, recorded as the actor on every write
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

TIMEOUT = 30
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
GATE_HINT = "This is a human approval gate; ask the accountant/CA in the room."
MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]


# ─────────────────────────────── errors ────────────────────────────────


class MagpieError(RuntimeError):
    """Magpie refused a call (`status` is the HTTP status) or could not be reached (`status` None)."""

    def __init__(self, message: str, status: int | None = None, detail=None):
        super().__init__(message)
        self.status = status
        self.detail = detail


class CliError(Exception):
    """A usage or lookup problem found before/after calling the API. Exit code 2."""


# ───────────────────────────── configuration ───────────────────────────


def _parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def config() -> dict[str, str]:
    """Environment wins, then ./magpie.env, then magpie.env next to this script."""
    merged: dict[str, str] = {}
    for path in (Path(__file__).resolve().parent / "magpie.env", Path.cwd() / "magpie.env"):
        merged.update(_parse_env_file(path))
    for key in ("MAGPIE_API_URL", "MAGPIE_SWITCH_TOKEN", "SWITCH_AGENT_NAME"):
        if os.environ.get(key):
            merged[key] = os.environ[key]
    return merged


# ───────────────────────────── HTTP layer ──────────────────────────────


def _request(method: str, path: str, payload: dict | None = None, query: dict | None = None,
             approved_by: str | None = None, raw: bool = False):
    """Call Magpie. Returns parsed JSON (or text when raw=True). Raises MagpieError."""
    cfg = config()
    base = cfg.get("MAGPIE_API_URL", "").rstrip("/")
    token = cfg.get("MAGPIE_SWITCH_TOKEN", "")
    if not base or not token:
        raise CliError("MAGPIE_API_URL and MAGPIE_SWITCH_TOKEN must be set (environment or magpie.env next to magpie.py).")
    if query:
        clean = {k: v for k, v in query.items() if v not in (None, "")}
        if clean:
            path += ("&" if "?" in path else "?") + urllib.parse.urlencode(clean)
    headers = {
        "Authorization": f"Bearer {token}",
        "X-Switch-Agent": cfg.get("SWITCH_AGENT_NAME") or "switch-agent",
        "Content-Type": "application/json",
    }
    body = None
    if method != "GET":
        payload = dict(payload or {})
        if approved_by:
            payload["approvedBy"] = approved_by  # the body is UTF-8 safe and takes precedence server-side
        body = json.dumps(payload).encode("utf-8")
    if approved_by:
        try:
            approved_by.encode("latin-1")
            headers["X-Switch-Approved-By"] = approved_by
        except UnicodeEncodeError:
            pass  # non-latin-1 names travel in the JSON body only
    req = urllib.request.Request(base + path, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as err:
        text = err.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = {}
        message = parsed.get("error") if isinstance(parsed, dict) else None
        raise MagpieError(message or text.strip()[:300] or str(err.reason), err.code,
                          parsed.get("detail") if isinstance(parsed, dict) else None) from None
    except urllib.error.URLError as err:
        raise MagpieError(f"Magpie is unreachable at {base}: {err.reason}") from None
    except OSError as err:  # includes timeouts
        raise MagpieError(f"Magpie request failed: {err}") from None
    if raw:
        return data
    try:
        return json.loads(data)
    except ValueError:
        raise MagpieError(f"Magpie returned a non-JSON response: {data[:200]}") from None


# ───────────────────────────── periods ─────────────────────────────────


def normalize_period(value: str) -> str:
    """Accept 2026-10, 2026/10, 10/2026, oct-2026, 'october 2026', 2026-oct. Returns YYYY-MM."""
    text = str(value).strip().lower()
    year = month = None
    m = re.fullmatch(r"(\d{4})\s*[-/ .]?\s*(\d{1,2})", text)
    if m:
        year, month = int(m.group(1)), int(m.group(2))
    else:
        m = re.fullmatch(r"(\d{1,2})\s*[-/ .]\s*(\d{4})", text)
        if m:
            month, year = int(m.group(1)), int(m.group(2))
        else:
            m = re.fullmatch(r"([a-z]{3,9})\.?[\s,/-]*(\d{4})", text)
            if m:
                name, year = m.group(1)[:3], int(m.group(2))
            else:
                m = re.fullmatch(r"(\d{4})[\s,/-]*([a-z]{3,9})", text)
                if m:
                    year, name = int(m.group(1)), m.group(2)[:3]
            if m:
                month = MONTHS.index(name) + 1 if name in MONTHS else None
    if year is None or month is None or not 1 <= month <= 12:
        raise ValueError(f"cannot read period {value!r}; use YYYY-MM (for example 2026-10) or 'oct-2026'")
    return f"{year:04d}-{month:02d}"


def period_arg(value: str) -> str:
    try:
        return normalize_period(value)
    except ValueError as err:
        raise argparse.ArgumentTypeError(str(err)) from None


def list_periods() -> list[dict]:
    return _request("GET", "/api/switch/gst/periods").get("periods", [])


def resolve_period(period: str | None) -> str:
    """The given period (normalized), else the latest period that has data."""
    if period:
        return normalize_period(period)
    for item in list_periods():  # server returns newest first
        if item.get("purchaseInvoices", 0) > 0 or item.get("gstr2bLines", 0) > 0:
            return item["period"]
    raise CliError("No period with data yet. Pass --period and import-register / import-2b first.")


# ─────────────────────────── library functions ─────────────────────────


def finance(domain: str = "overview", period: str | None = None) -> dict:
    """GET /api/switch/finance. domain: overview | gst | taxonomy. Period defaults server-side."""
    if domain not in {"overview", "gst", "taxonomy"}:
        raise ValueError("domain must be overview, gst or taxonomy")
    return _request("GET", "/api/switch/finance", query={"domain": domain, "period": period and normalize_period(period)})


def gst_exceptions(period: str | None = None, **filters) -> dict:
    """Exception queue: {period, count, exceptions}. Filters: type, status, vendor, id."""
    allowed = {"type", "status", "vendor", "id"}
    bad = set(filters) - allowed
    if bad:
        raise TypeError(f"unknown filter(s) {sorted(bad)}; allowed: {sorted(allowed)}")
    return _request("GET", "/api/switch/gst/exceptions", query={"period": resolve_period(period), **filters})


def decide_itc(exception_id: str, decision: str, approved_by: str, note: str | None = None, scope: str | None = None) -> dict:
    """Record claim | defer | reverse for one exception. approved_by is the human who approved it."""
    if decision not in {"claim", "defer", "reverse"}:
        raise ValueError("decision must be claim, defer or reverse")
    payload = {"exceptionId": exception_id, "decision": decision, "scope": scope, "note": note}
    return _request("POST", "/api/switch/gst/decision", {k: v for k, v in payload.items() if v}, approved_by=approved_by)


def decide_many(decisions: list[dict], approved_by: str) -> dict:
    """decisions: [{exceptionId, decision, scope?, note?}] (max 200). Returns {applied, refused, results}."""
    return _request("POST", "/api/switch/gst/decision", {"decisions": decisions}, approved_by=approved_by)


def followup(vendor_id: str, period: str, action: str = "draft", draft: str | None = None,
             approved_by: str | None = None, resolution: str | None = None) -> dict:
    """Vendor follow-up lifecycle: draft -> approve (human) -> send -> resolve."""
    if action not in {"draft", "approve", "send", "resolve"}:
        raise ValueError("action must be draft, approve, send or resolve")
    payload = {"vendorId": vendor_id, "period": normalize_period(period), "action": action, "draft": draft, "resolution": resolution}
    return _request("POST", "/api/switch/gst/followup", {k: v for k, v in payload.items() if v}, approved_by=approved_by)


def gst_summary(period: str | None = None) -> dict:
    """Live summary: funnel, exceptions by type, non-filers, blocked credits, Table 4, filing blockers."""
    return _request("GET", "/api/switch/gst/summary", query={"period": resolve_period(period)})


def _summary_action(period: str | None, action: str, approved_by: str | None = None, reason: str | None = None) -> dict:
    payload = {"period": resolve_period(period), "action": action, "reason": reason}
    return _request("POST", "/api/switch/gst/summary", {k: v for k, v in payload.items() if v}, approved_by=approved_by)


# Old names, kept so existing agent code keeps working.
def gst_decision(exception_id: str, decision: str, scope: str | None = None, note: str | None = None, approved_by: str | None = None) -> dict:
    if not approved_by:
        raise ValueError("approved_by is required: decisions need the name of the human who approved them")
    return decide_itc(exception_id, decision, approved_by, note=note, scope=scope)


def vendor_followup(vendor_id: str, period: str, draft: str | None = None, action: str = "draft", approved_by: str | None = None) -> dict:
    return followup(vendor_id, period, action=action, draft=draft, approved_by=approved_by)


def approve_gst_summary(period: str | None = None, approved_by: str | None = None) -> dict:
    """The CA's sign-off. Requires the CA's name in approved_by."""
    if not approved_by:
        raise ValueError("approved_by is required: only the CA can approve")
    return _summary_action(period, "ca_approve", approved_by)


# ───────────────────────────── formatting ──────────────────────────────


def inr(paise) -> str:
    """Paise -> ₹ with Indian digit grouping (prefer the API's own strings when present)."""
    sign = "-" if paise < 0 else ""
    whole, frac = divmod(abs(int(paise)), 100)
    digits = str(whole)
    head, tail = digits[:-3], digits[-3:]
    head = re.sub(r"\B(?=(\d{2})+(?!\d))", ",", head)
    return f"{sign}₹{head + ',' if head else ''}{tail}.{frac:02d}"


def clip(text, width: int) -> str:
    text = " ".join(str(text if text is not None else "-").split())
    return text if len(text) <= width else text[: width - 1] + "…"


def table(headers: list[str], rows: list[list], right: set[int] | None = None, max_width: int = 48) -> str:
    right = right or set()
    cells = [[clip(c, max_width) for c in row] for row in rows]
    widths = [max([len(h)] + [len(r[i]) for r in cells]) for i, h in enumerate(headers)]

    def fmt(row):
        return "  ".join(c.rjust(widths[i]) if i in right else c.ljust(widths[i]) for i, c in enumerate(row)).rstrip()

    return "\n".join([fmt(headers), "  ".join("-" * w for w in widths)] + [fmt(r) for r in cells])


def short(identifier: str | None) -> str:
    return (identifier or "")[:8]


def when(value) -> str:
    return str(value)[:16].replace("T", " ") if value else "-"


def say(text: str = "") -> None:
    print(text)


def dump(data) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


def error_lines(err: MagpieError) -> list[str]:
    lines = [f"ERROR {err.status}: {err}" if err.status else f"ERROR: {err}"]
    detail = err.detail
    if isinstance(detail, dict):
        for item in detail.get("blockers") or []:
            lines.append(f"  blocker: {item}")
        for item in detail.get("rejected") or []:
            lines.append("  rejected: " + (item if isinstance(item, str) else json.dumps(item, ensure_ascii=False)))
        for key, value in detail.items():
            if key not in ("blockers", "rejected") and isinstance(value, (str, int, float)):
                lines.append(f"  {key}: {value}")
    elif detail:
        lines.append(f"  detail: {detail}")
    if err.status == 409:
        lines.append(f"  hint: {GATE_HINT}")
    elif err.status == 401:
        lines.append("  hint: check MAGPIE_SWITCH_TOKEN (write commands need the write token).")
    return lines


# ───────────────────────────── lookups ─────────────────────────────────


def fetch_exceptions(period: str, **filters) -> list[dict]:
    return gst_exceptions(period, **filters)["exceptions"]


def resolve_exception(period: str, ident: str) -> dict:
    """Find one exception by full UUID, 8+ char UUID prefix, or stableId."""
    needle = ident.strip().lower()
    found = [e for e in fetch_exceptions(period) if e["id"].lower().startswith(needle) or (e.get("stableId") or "").lower() == needle]
    exact = [e for e in found if e["id"].lower() == needle or (e.get("stableId") or "").lower() == needle]
    found = exact or found
    if not found:
        raise CliError(f"No exception matches {ident!r} in {period}. List them with: exceptions --period {period}")
    if len(found) > 1:
        raise CliError(f"{ident!r} is ambiguous in {period}; use more characters. Candidates: " + ", ".join(e["id"][:12] for e in found[:6]))
    return found[0]


def resolve_vendor(period: str, ident: str) -> dict:
    """Pick a vendor from the follow-up queue by id, GSTIN or unambiguous name substring."""
    vendors = _request("GET", "/api/switch/gst/followup", query={"period": period}).get("vendors", [])
    needle = ident.strip().lower()
    hits = [v for v in vendors if v["vendorId"].lower() == needle or v["gstin"].lower() == needle]
    if not hits and len(needle) >= 6:
        hits = [v for v in vendors if v["vendorId"].lower().startswith(needle)]
    if not hits:
        hits = [v for v in vendors if needle in v["vendor"].lower()]
    if len(hits) == 1:
        return hits[0]
    if not hits:
        if UUID_RE.match(ident):
            return {"vendorId": ident, "vendor": ident, "followup": None}
        raise CliError(f"No vendor in {period}'s follow-up queue matches {ident!r}. See: vendors --period {period}")
    names = "\n".join(f"  {short(v['vendorId'])}  {v['vendor']}  {v['gstin']}" for v in hits)
    raise CliError(f"{ident!r} matches {len(hits)} vendors; be more specific or pass a GSTIN / id prefix:\n{names}")


# ───────────────────────────── commands ────────────────────────────────


def cmd_periods(a):
    periods = list_periods()
    if a.json:
        return dump(periods)
    if not periods:
        return say("No periods yet. Import a purchase register and GSTR-2B first.")
    say(table(["PERIOD", "STATUS", "BUSINESS", "INVOICES", "2B LINES", "OPEN EXC", "MATCHED", "SIGNED OFF BY"],
              [[p["period"], p["status"], p.get("businessName") or "-", p["purchaseInvoices"], p["gstr2bLines"], p["openExceptions"],
                when(p.get("matchedAt")), p.get("signedOffBy") or "-"] for p in periods], right={3, 4, 5}))


def cmd_status(a):
    period = resolve_period(a.period)
    s = gst_summary(period)
    if a.json:
        return dump(s)
    biz = s["business"]
    say(f"GST {period} | {biz.get('name') or 'unnamed business'} ({biz.get('gstin') or 'no GSTIN'}) | status: {s['status']}")
    src = s["source"]
    say(f"Sources: {src['purchaseInvoices']} purchase invoices, {src['gstr2bLines']} GSTR-2B lines, matched at {when(src.get('matchedAt'))}")
    f = s["funnel"]
    m = f["matched"]
    exact = f" (exact {m['exact']}, fuzzy {m['fuzzy']})" if m.get("exact") is not None else ""
    say("\nFunnel (ITC):")
    say(f"  in books  {f['inBooks']['invoices']:>4} invoices   {f['inBooks']['itc']}")
    say(f"  matched   {m['invoices']:>4} invoices   {m['itc']}{exact}")
    say(f"  at risk   {f['atRisk']['exceptions']:>4} exceptions  {f['atRisk']['itc']}")
    say(f"  claimed   net Table 4C  {f['claimed']['itc']}")
    e = s["exceptions"]
    say(f"\nExceptions: {e['total']} total | open {e['open']} | claimed {e['claimed']} | deferred {e['deferred']} | reversed {e['reversed']}")
    if e["byType"]:
        say(table(["TYPE", "COUNT", "OPEN", "ITC"], [[t, v["count"], v["open"], v["itc"]] for t, v in e["byType"].items()], right={1, 2, 3}))
    d = s["itc"]
    say(f"Decided ITC: claim {inr(d['claimPaise'])} | defer {inr(d['deferPaise'])} | reverse {inr(d['reversePaise'])}")
    if s["nonFilers"]:
        say("\nNon-filers (invoices missing from 2B):")
        say(table(["VENDOR", "GSTIN", "INV", "ITC", "FOLLOW-UP"],
                  [[n["vendor"], n["gstin"], n["invoices"], n["itc"], n.get("followup") or "none"] for n in s["nonFilers"]], right={2, 3}))
    if s["blockedCredits"]:
        say("\nBlocked credits (Section 17(5)):")
        say(table(["EXC", "VENDOR", "INVOICE", "CLAUSE", "ITC", "STATUS"],
                  [[short(b["exceptionId"]), b["vendor"], b["invoiceNo"], b["clause"], b["itc"], b["status"]] for b in s["blockedCredits"]], right={4}))
    if s["unbookedIn2b"]["lines"]:
        say(f"\nIn 2B but not in books: {s['unbookedIn2b']['lines']} open lines, {s['unbookedIn2b']['itc']}")
    fu = s["followups"]
    say(f"\nFollow-ups: {fu['total']} (draft {fu['draft']}, approved {fu['approved']}, sent {fu['sent']}, resolved {fu['resolved']})")
    so = s["signoff"]
    if so.get("signedOffBy"):
        say(f"Signed off by {so['signedOffBy']} at {when(so.get('signedOffAt'))}")
    elif so.get("requestedAt"):
        say(f"Sign-off requested by {so.get('requestedBy')} at {when(so['requestedAt'])}; waiting for the CA")
    fil = s["filing"]
    say(f"\nFiling: {'READY' if fil['ready'] else 'NOT READY'}. {fil['message']}")
    for blocker in fil["blockers"]:
        say(f"  blocker: {blocker}")


def _invoice_label(e: dict) -> str:
    books = (e.get("books") or {}).get("invoiceNo")
    gst2b = (e.get("gstr2b") or {}).get("invoiceNo")
    if books and gst2b and books != gst2b:
        return f"{books} / 2B:{gst2b}"
    return books or gst2b or "-"


def exception_line(e: dict) -> str:
    ev = e.get("evidence")
    evidence = (ev[0] if ev else "") if isinstance(ev, list) else str(ev or "")
    return (f"{short(e['id'])}  {e['type']:<15} {e['status']:<8} {clip(e['vendor'], 26):<26}  inv {clip(_invoice_label(e), 28):<28}  "
            f"{e['itc']:>12}  | {clip(evidence, 90)} | allowed: {'/'.join(e.get('allowedDecisions', []))}")


def cmd_exceptions(a):
    period = resolve_period(a.period)
    items = fetch_exceptions(period, type=a.type, status=a.status, vendor=a.vendor)
    if a.id:
        needle = a.id.lower()
        items = [e for e in items if e["id"].lower().startswith(needle) or (e.get("stableId") or "").lower() == needle]
    if a.json:
        return dump({"period": period, "count": len(items), "exceptions": items})
    filters = "".join(f" {k}={v}" for k, v in (("type", a.type), ("status", a.status), ("vendor", a.vendor), ("id", a.id)) if v)
    say(f"{len(items)} exception(s) in {period}{filters}")
    for e in items:
        say(exception_line(e))
    if items:
        say("(id = first 8 chars of the UUID; `explain <id>` for detail, `--json` for full ids)")


def cmd_explain(a):
    period = resolve_period(a.period)
    e = resolve_exception(period, a.id)
    history = []
    try:
        events = _request("GET", "/api/switch/gst/events", query={"period": period, "limit": 200}).get("events", [])
        history = [ev for ev in events if (ev.get("detail") or {}).get("exceptionId") == e["id"]]
    except MagpieError:
        pass
    if a.json:
        return dump({"exception": e, "decisionEvents": history})
    say(f"{e['id']}  (stable: {e.get('stableId')})")
    say(f"{e['type']} | {e['status']} | {e['vendor']} {e.get('gstin') or ''} | ITC {e['itc']}")
    books, b2 = e.get("books") or {}, e.get("gstr2b") or {}
    fields = [("Invoice no", "invoiceNo"), ("Date", "date"), ("Taxable", "taxable"), ("IGST", "igst"), ("CGST", "cgst"), ("SGST", "sgst")]
    rows = [[label, books.get(key, "-"), b2.get(key, "-")] for label, key in fields]
    if books:
        rows += [["Ledger / HSN", f"{books.get('ledger') or '-'} / {books.get('hsn') or '-'}", ""],
                 ["17(5) clause", books.get("blockedClause") or "-", ""],
                 ["17(5) overridden", str(books.get("blockedOverride")), ""]]
    if b2:
        rows.append(["2B period", "", b2.get("period") or "-"])
    say("\n" + table(["", "BOOKS" if books else "BOOKS (none)", "GSTR-2B" if b2 else "GSTR-2B (none)"], rows))
    say("\nEvidence:")
    for line in e.get("evidence") or []:
        say(f"  - {line}")
    say(f"\nAllowed decisions: {', '.join(e.get('allowedDecisions', []))}")
    if books.get("invoiceId"):
        say(f"Books invoice id (for `override`): {books['invoiceId']}")
    latest = e.get("latestDecision")
    if latest:
        note = f" - {latest['note']}" if latest.get("note") else ""
        say(f"Latest decision: {latest['decision']} by {latest.get('actor')}, approved by {latest.get('approvedBy')} at {when(latest.get('at'))}{note}")
    else:
        say("Latest decision: none")
    say(f"Decisions recorded: {e.get('history', 0)}")
    for ev in history:
        d = ev.get("detail") or {}
        note = f" - {d['note']}" if d.get("note") else ""
        say(f"  {when(ev['createdAt'])}  {d.get('previous') or '-'} -> {d.get('decision')}  actor {ev['actor']}, approved by {ev.get('approvedBy')}{note}")


def _decision_result_line(item: dict, by_id: dict) -> str:
    e = by_id.get(item.get("exceptionId"), {})
    label = f"{short(item.get('exceptionId'))} {clip(e.get('vendor', ''), 24)} {e.get('itc', '')}".strip()
    if item.get("ok"):
        return f"OK       {label} -> {item.get('status')}" + (" (already recorded)" if item.get("idempotent") else "")
    return f"REFUSED  {label} [{item.get('status')}] {item.get('error')}"


def cmd_decide(a):
    period = resolve_period(a.period)
    e = resolve_exception(period, a.id)
    result = decide_itc(e["id"], a.decision, a.approved_by, note=a.note, scope=a.scope)
    if a.json:
        return dump(result)
    say(_decision_result_line({"ok": True, **result}, {e["id"]: e}))
    say(f"Recorded: {a.decision} for {e['vendor']} {_invoice_label(e)}, approved by {a.approved_by}")


def cmd_decide_many(a):
    period = resolve_period(a.period)
    if a.ids:
        targets = [resolve_exception(period, x.strip()) for x in a.ids.split(",") if x.strip()]
    elif a.type or a.vendor or a.status:
        targets = fetch_exceptions(period, type=a.type, status=a.status or "OPEN", vendor=a.vendor)
    else:
        raise CliError("decide-many needs --ids a,b,c or at least one of --type / --vendor / --status.")
    if not targets:
        raise CliError("No exceptions matched; nothing to decide.")
    by_id = {e["id"]: e for e in targets}
    batch = [{"exceptionId": e["id"], "decision": a.decision, **({"note": a.note} if a.note else {}), **({"scope": a.scope} if a.scope else {})} for e in targets]
    if a.dry_run:
        say(f"DRY RUN: would record '{a.decision}' for {len(batch)} exception(s) in {period}, approved by {a.approved_by}:")
        for e in targets:
            say("  " + exception_line(e))
        return
    results, applied, refused = [], 0, 0
    for i in range(0, len(batch), 200):
        out = decide_many(batch[i:i + 200], a.approved_by)
        results += out.get("results", [])
        applied += out.get("applied", 0)
        refused += out.get("refused", 0)
    if a.json:
        dump({"applied": applied, "refused": refused, "results": results})
    else:
        for item in results:
            say(_decision_result_line(item, by_id))
        say(f"\n{applied} applied, {refused} refused ({a.decision}, approved by {a.approved_by})")
    if refused:
        sys.exit(2)


def cmd_taxonomy(a):
    period = resolve_period(a.period)
    t = _request("GET", "/api/switch/gst/taxonomy", query={"period": period})
    if a.json:
        return dump(t)
    say(f"Taxonomy {period}: {t['invoices']} invoices | tax still blocked under 17(5): {t['blockedTax']}")
    say("\nClasses:")
    say(table(["CLASS", "LABEL", "INV", "TAX", "17(5) CLAUSE"],
              [[c["expenseClass"], c["label"], c["invoices"], c["tax"], c.get("blockedClause") or "-"] for c in t["classes"]], right={2, 3}))
    if t["blockedCredits"]:
        say("\nBlocked credits (override by invoice id prefix or invoice no):")
        say(table(["INVOICE ID", "INVOICE", "VENDOR", "LEDGER", "TAX", "CLAUSE", "STATE", "CONF"],
                  [[short(b["invoiceId"]), b["invoiceNo"], b["vendor"], b["ledger"], b["tax"], b["clause"] or "-",
                    "OVERRIDDEN" if b["overridden"] else "blocked", b.get("confidence", "-")] for b in t["blockedCredits"]], right={4}))
        for b in t["blockedCredits"]:
            say(f"  {b['invoiceNo']}: {b.get('reason') or '-'} | basis: {b.get('basis') or '-'}")
            if b.get("override"):
                say(f"    override by {b['override'].get('approvedBy')}: {b['override'].get('reason')}")
    else:
        say("\nNo blocked credits.")
    if t["unclassified"]:
        say(f"\n{len(t['unclassified'])} unclassified invoice(s): " + ", ".join(f"{u['invoiceNo']} ({u['ledger']})" for u in t["unclassified"][:10]))


def cmd_override(a):
    ident = a.invoice
    if not UUID_RE.match(ident):
        period = resolve_period(a.period)
        flags = _request("GET", "/api/switch/gst/taxonomy", query={"period": period}).get("blockedCredits", [])
        hits = [b for b in flags if b["invoiceId"].lower().startswith(ident.lower()) or b["invoiceNo"].lower() == ident.lower()]
        if len(hits) != 1:
            raise CliError(f"{ident!r} matches {len(hits)} flagged invoices in {period}; use the full invoice id (see `taxonomy`).")
        ident = hits[0]["invoiceId"]
    result = _request("POST", "/api/switch/gst/taxonomy", {"invoiceId": ident, "blocked": a.block, "reason": a.reason}, approved_by=a.approved_by)
    if a.json:
        return dump(result)
    state = "restored (credit blocked)" if a.block else "lifted (credit may be claimed)"
    say(f"Section 17(5) flag {state} on invoice {short(ident)}" + (" - already in that state" if result.get("idempotent") else ""))
    r = result.get("rematch")
    if r:
        say(f"Re-matched: {r.get('matched')} matched, {r.get('exceptions')} exceptions, created {r.get('created')}, removed {len(r.get('removed') or [])}")


def cmd_vendors(a):
    period = resolve_period(a.period)
    q = _request("GET", "/api/switch/gst/followup", query={"period": period})
    vendors = sorted(q["vendors"], key=lambda v: (not v["nonFiler"], -v["itcAtRiskPaise"]))
    if a.json:
        return dump({**q, "vendors": vendors})
    if not vendors:
        return say(f"No vendors with open vendor-fixable exceptions in {period}.")
    say(f"{len(vendors)} vendor(s) to chase in {period} (non-filers first)")
    say(table(["ID", "VENDOR", "GSTIN", "NON-FILER", "AT RISK", "INV", "FOLLOW-UP"],
              [[short(v["vendorId"]), v["vendor"], v["gstin"], "yes" if v["nonFiler"] else "no", v["itcAtRisk"], len(v["invoices"]),
                (v["followup"] or {}).get("status", "none")] for v in vendors], right={4, 5}))


def _print_followup(res: dict, label: str):
    f = res["followup"]
    vendor = res.get("vendor", {}).get("name") or f.get("vendorId")
    line = f"{label}: {vendor} | follow-up status {f['status']}"
    if f.get("approvedBy"):
        line += f" | approved by {f['approvedBy']}"
    if f.get("sentVia"):
        line += f" | sent via {f['sentVia']}"
    say(line + (" (no change)" if res.get("idempotent") else ""))
    if label == "DRAFT" and f.get("draft"):
        say("\n" + f["draft"])
        say("\nNext: show this to the accountant; after they approve run `approve-followup <vendor> --approved-by NAME`.")


def cmd_draft(a):
    period = resolve_period(a.period)
    v = resolve_vendor(period, a.vendor)
    text = Path(a.text_file).read_text(encoding="utf-8") if a.text_file else a.text
    res = followup(v["vendorId"], period, "draft", draft=text)
    return dump(res) if a.json else _print_followup(res, "DRAFT")


def cmd_approve_followup(a):
    period = resolve_period(a.period)
    v = resolve_vendor(period, a.vendor)
    stored = (v.get("followup") or {}).get("draft")
    if not stored:
        raise CliError(f"{v['vendor']} has no stored draft in {period}; run `draft {short(v['vendorId'])}` first.")
    res = followup(v["vendorId"], period, "approve", draft=stored, approved_by=a.approved_by)
    return dump(res) if a.json else _print_followup(res, "APPROVED")


def cmd_send_followup(a):
    period = resolve_period(a.period)
    v = resolve_vendor(period, a.vendor)
    res = followup(v["vendorId"], period, "send")
    return dump(res) if a.json else _print_followup(res, "SENT")


def cmd_resolve_followup(a):
    period = resolve_period(a.period)
    v = resolve_vendor(period, a.vendor)
    res = followup(v["vendorId"], period, "resolve", resolution=a.resolution)
    return dump(res) if a.json else _print_followup(res, "RESOLVED")


def cmd_match(a):
    period = resolve_period(a.period)
    r = _request("POST", "/api/switch/gst/match", {"period": period})
    if a.json:
        return dump(r)
    say(f"Matched {period}: {r.get('matched')} invoices (exact {r.get('matchedExact')}, fuzzy {r.get('matchedFuzzy')}), {r.get('exceptions')} exceptions "
        f"(new {r.get('created')}, kept {r.get('kept')}), false-match safe: {r.get('falseMatchSafe')}")
    if r.get("byType"):
        say("By type: " + ", ".join(f"{k} {v}" for k, v in r["byType"].items()))
    for item in r.get("removed") or []:
        say(f"  removed stale {item.get('type')} {short(item.get('id'))} ({item.get('status')}, {item.get('decisions')} decision(s))")


def _print_import(r: dict, noun: str):
    facts = ", ".join(f"{k}={v}" for k, v in r.items() if k not in ("period", "rejected", "ok") and v not in (None, ""))
    say(f"Imported {noun} for {r.get('period')}: {facts}")
    rejected = r.get("rejected") or []
    if rejected:
        say(f"{len(rejected)} row(s) rejected:")
        for item in rejected[:15]:
            say("  " + (item if isinstance(item, str) else json.dumps(item, ensure_ascii=False)))
    say("Next: run `match` once both the register and the 2B are imported.")


def cmd_import_register(a):
    payload = {"kind": "purchase_register", "period": a.period, "content": Path(a.path).read_text(encoding="utf-8-sig"),
               "recipientGstin": a.gstin, "businessName": a.business}
    r = _request("POST", "/api/switch/gst/intake", {k: v for k, v in payload.items() if v})
    return dump(r) if a.json else _print_import(r, "purchase register")


def cmd_import_2b(a):
    try:
        content = json.loads(Path(a.path).read_text(encoding="utf-8-sig"))
    except ValueError as err:
        raise CliError(f"{a.path} is not valid JSON: {err}") from None
    payload = {"kind": "gstr2b", "period": a.period, "content": content}
    r = _request("POST", "/api/switch/gst/intake", {k: v for k, v in payload.items() if v})
    return dump(r) if a.json else _print_import(r, "GSTR-2B")


def cmd_request_signoff(a):
    r = _summary_action(a.period, "request_signoff")
    if a.json:
        return dump(r)
    say(f"Sign-off for {r['period']}: {r['status']}" + (" (already requested)" if r.get("idempotent") else ". Waiting for the CA to approve in the room."))


def cmd_ca_approve(a):
    r = _summary_action(a.period, "ca_approve", a.approved_by)
    if a.json:
        return dump(r)
    say(f"Period {r['period']}: {r['status']}, signed off by {r.get('signedOffBy')} at {when(r.get('signedOffAt'))}" + (" (already signed off)" if r.get("idempotent") else ""))


def cmd_reopen(a):
    r = _summary_action(a.period, "reopen", a.approved_by, a.reason)
    if a.json:
        return dump(r)
    say(f"Period {r['period']} reopened: now {r['status']}. Decisions are editable again; request sign-off when ready.")


def _table4_rows(summary: dict) -> list[list]:
    return [[k, v["igst"], v["cgst"], v["sgst"], v["cess"], v["total"]] for k, v in summary["table4"].items() if isinstance(v, dict) and "igst" in v]


def cmd_table4(a):
    period = resolve_period(a.period)
    s = gst_summary(period)
    if a.json:
        return dump({"period": period, "status": s["status"], "table4": s["table4"]})
    final = s["status"] == "SIGNED_OFF"
    label = f"FINAL, signed off by {s['signoff'].get('signedOffBy')}" if final else f"DRAFT (status {s['status']}); not for filing until the CA signs off"
    say(f"GSTR-3B Table 4 {period}: {label}")
    say(f"Basis: {s['table4']['basis'].split(';')[0]}")
    say(table(["ROW", "IGST", "CGST", "SGST", "CESS", "TOTAL"], _table4_rows(s), right={1, 2, 3, 4, 5}, max_width=60))
    na = s["table4"]["notAvailedThisPeriod"]
    say(f"\nNot availed this period (outside Table 4): deferred {na['deferred']['total']}, reversed but not in 2B {na['reversedNotIn2b']['total']}")
    if not final:
        for blocker in s["filing"]["blockers"]:
            say(f"  blocker: {blocker}")


def cmd_export(a):
    period = resolve_period(a.period)
    fmt = a.format
    out = Path(a.out or f"gstr3b-table4-{period}.{fmt}")
    if fmt == "csv":
        text = _request("GET", "/api/switch/gst/summary", query={"period": period, "format": "csv"}, raw=True)
        rows = list(csv.reader(io.StringIO(text)))
    else:
        data = _request("GET", "/api/switch/gst/summary", query={"period": period, "format": "json"})["export"]
        text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
        rows = [["section", "igst", "cgst", "sgst", "cess"]] + [[k, v["igst"], v["cgst"], v["sgst"], v["cess"]] for k, v in data["table4"].items()]
    out.write_text(text, encoding="utf-8")
    if a.json:
        return dump({"path": str(out), "format": fmt, "rows": rows})
    say(f"Wrote {out} ({len(text)} bytes). Table 4 for {period} (Magpie does not file; file GSTR-3B on the portal):")
    rows = [r + [""] * (len(rows[0]) - len(r)) for r in rows]  # the sign-off footer row is shorter
    say(table(rows[0], rows[1:], right={2, 3, 4, 5} if fmt == "csv" else {1, 2, 3, 4}, max_width=70))


def _event_detail(detail) -> str:
    if not isinstance(detail, dict) or not detail:
        return ""
    parts = []
    for key, value in detail.items():
        if isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        if value not in (None, ""):
            parts.append(f"{key}={value}")
    return clip(" ".join(parts), 110)


def cmd_events(a):
    period = resolve_period(a.period)
    events = _request("GET", "/api/switch/gst/events", query={"period": period, "limit": a.limit}).get("events", [])
    if a.json:
        return dump({"period": period, "events": events})
    say(f"{len(events)} event(s) for {period}, newest first")
    for ev in events:
        approver = f" approved-by={ev['approvedBy']}" if ev.get("approvedBy") else ""
        say(f"{when(ev['createdAt'])}  {ev['kind']:<28} {ev['actor']}{approver}  {_event_detail(ev.get('detail'))}".rstrip())


# ───────────────────────────── argparse ────────────────────────────────

EPILOG = """\
typical flow:
  periods                         what periods exist (latest with data is the default everywhere)
  status                          funnel, exceptions by type, non-filers, blockers
  exceptions --type NOT_IN_2B     one line per exception (8-char id first)
  explain <id>                    books vs GSTR-2B, evidence, history, allowed decisions
  decide <id> defer --approved-by "Asha" --note "chasing vendor"
  vendors / draft / approve-followup / send-followup / resolve-followup
  request-signoff -> ca-approve --approved-by "<CA>" -> export

rules:
  * Periods: 2026-10, oct-2026, "october 2026", 10/2026. Omit --period to use the latest period with data.
  * Money decisions (decide, decide-many, override, approve-followup, ca-approve, reopen) need
    --approved-by NAME, the HUMAN who approved in the room. Never invent a name; ask.
    Exit code 2 plus "ERROR 409" means a gate or rule refused: ask the accountant/CA, do not retry.
  * Add --json to any command for raw JSON. Exit codes: 0 ok, 1 network error, 2 refused/usage.
  * Config: MAGPIE_API_URL, MAGPIE_SWITCH_TOKEN, SWITCH_AGENT_NAME from the environment or magpie.env.
"""


def build_parser() -> argparse.ArgumentParser:
    raw = argparse.RawDescriptionHelpFormatter
    parser = argparse.ArgumentParser(prog="magpie.py", description="Magpie GST Close Room client for Switch agents.", epilog=EPILOG, formatter_class=raw)
    parser.add_argument("--json", action="store_true", help="print raw JSON instead of text")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="print raw JSON instead of text")
    pparent = argparse.ArgumentParser(add_help=False, parents=[common])
    pparent.add_argument("--period", type=period_arg, help="YYYY-MM, oct-2026, 'october 2026' or 10/2026 (default: latest period with data)")
    sub = parser.add_subparsers(dest="command", metavar="COMMAND", required=True)

    def add(name, help_, parents=(pparent,), description=None):
        return sub.add_parser(name, help=help_, description=description or help_, parents=list(parents), formatter_class=raw)

    def approver(p):
        p.add_argument("--approved-by", metavar="NAME", required=True, help="the human who approved this in the room (sent as X-Switch-Approved-By)")

    add("periods", "list periods with status, counts and open exceptions", parents=(common,))
    add("status", "summary: funnel, exceptions by type, non-filers, blocked credits, follow-ups, filing blockers")
    p = add("exceptions", "list exceptions, one line each",
            description="One line per exception: short id, type, status, vendor, invoice no(s), ITC, first evidence line, allowed decisions.\n"
                        "Types: NOT_IN_2B, NOT_IN_BOOKS, AMOUNT_MISMATCH, TAX_TYPE_MISMATCH, PERIOD_MISMATCH, BLOCKED_CREDIT.")
    p.add_argument("--type", help="exception type, e.g. NOT_IN_2B")
    p.add_argument("--status", help="OPEN, CLAIMED, DEFERRED or REVERSED")
    p.add_argument("--vendor", help="vendor name substring or exact GSTIN")
    p.add_argument("--id", help="exception id: UUID, 8-char prefix or stable id")
    p = add("explain", "full detail of one exception")
    p.add_argument("id", help="exception UUID, 8-char prefix (from `exceptions`) or stable id")
    p = add("decide", "record claim|defer|reverse for one exception (needs --approved-by)",
            description="Record a human-approved ITC decision. Idempotent. Refused (409) when Section 16(2)(aa) applies (not in 2B: cannot claim),\n"
                        "when a 17(5) block has no override (cannot claim), or when the period is signed off.")
    p.add_argument("id", help="exception UUID, 8-char prefix or stable id")
    p.add_argument("decision", type=str.lower, choices=["claim", "defer", "reverse"])
    approver(p)
    p.add_argument("--note", help="why (stored in the audit trail)")
    p.add_argument("--scope", help="optional scope label, max 120 chars")
    p = add("decide-many", "decide a batch of exceptions (by --ids or by filter)",
            description="Resolve exceptions by --ids a,b,c (UUIDs, 8-char prefixes or stable ids) or by filters (--status defaults to OPEN),\n"
                        "then record the same decision for all. Prints one line per item including refusals.\n"
                        "Exit code 2 if any item was refused. Use --dry-run first.")
    p.add_argument("--decision", type=str.lower, choices=["claim", "defer", "reverse"], required=True)
    approver(p)
    p.add_argument("--ids", help="comma-separated exception ids")
    p.add_argument("--type", help="exception type filter, e.g. NOT_IN_2B")
    p.add_argument("--status", help="status filter (default OPEN when filtering)")
    p.add_argument("--vendor", help="vendor name substring or GSTIN filter")
    p.add_argument("--note")
    p.add_argument("--scope")
    p.add_argument("--dry-run", action="store_true", help="show what would be sent, send nothing")
    add("taxonomy", "expense classes and Section 17(5) blocked credits with clause and basis")
    p = add("override", "lift or restore a Section 17(5) block on an invoice (needs --approved-by and --reason)",
            description="--unblock lets the credit be claimed (a human judged 17(5) does not apply); --block restores the flag. The matcher re-runs at once.")
    p.add_argument("invoice", help="invoice UUID, 8-char prefix or invoice number (see `taxonomy`)")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--unblock", dest="block", action="store_false", help="lift the 17(5) block")
    g.add_argument("--block", dest="block", action="store_true", help="restore the 17(5) block")
    p.add_argument("--reason", required=True, help="why (e.g. car used for driving training)")
    approver(p)
    add("vendors", "vendor follow-up queue: non-filers first, with ITC at risk and follow-up status")
    p = add("draft", "create/replace a vendor follow-up draft (server writes one from data if no text)")
    p.add_argument("vendor", help="vendor id/prefix, GSTIN or unambiguous name substring")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--text", help="your own draft text")
    g.add_argument("--text-file", metavar="PATH", help="read draft text from a file")
    p = add("approve-followup", "mark the stored draft approved (needs --approved-by)",
            description="Approves the draft currently stored for the vendor (its text is sent back so the server can verify nobody edited it).\n"
                        "Run `draft` first and show the text to the human.")
    p.add_argument("vendor", help="vendor id/prefix, GSTIN or unambiguous name substring")
    approver(p)
    p = add("send-followup", "send an APPROVED follow-up (emails the vendor if a contact is on file)")
    p.add_argument("vendor", help="vendor id/prefix, GSTIN or unambiguous name substring")
    p = add("resolve-followup", "mark a SENT follow-up resolved")
    p.add_argument("vendor", help="vendor id/prefix, GSTIN or unambiguous name substring")
    p.add_argument("--resolution", help="what the vendor did, e.g. 'filed GSTR-1 on 5 Nov'")
    add("match", "run the deterministic matcher (repeatable; keeps existing decisions)")
    p = add("import-register", "import the purchase register CSV for a period", parents=(common,))
    p.add_argument("path", help="CSV file")
    p.add_argument("--period", type=period_arg, required=True)
    p.add_argument("--gstin", help="your business GSTIN (optional if the 2B carries it)")
    p.add_argument("--business", help="business name")
    p = add("import-2b", "import the GSTR-2B portal JSON (period is read from the file if omitted)")
    p.add_argument("path", help="JSON file")
    add("request-signoff", "ask for CA sign-off (only when no exception is undecided)")
    p = add("ca-approve", "record the CA's sign-off (needs --approved-by = the CA's name)")
    approver(p)
    p = add("reopen", "reopen a PENDING_CA/SIGNED_OFF period (needs --approved-by and --reason)")
    approver(p)
    p.add_argument("--reason", required=True)
    p = add("export", "write the GSTR-3B Table 4 export (only after CA sign-off) and print it")
    p.add_argument("--format", choices=["csv", "json"], default="csv")
    p.add_argument("--out", metavar="PATH", help="output file (default gstr3b-table4-<period>.<format> in the current directory)")
    add("table4", "print the draft GSTR-3B Table 4 (4A(5), 4B(1), 4B(2), 4C), labelled DRAFT until signed off")
    p = add("events", "audit trail: time, kind, actor, approver, detail")
    p.add_argument("--limit", type=int, default=30, help="max events, 1-200 (default 30)")
    return parser


COMMANDS = {
    "periods": cmd_periods, "status": cmd_status, "exceptions": cmd_exceptions, "explain": cmd_explain, "decide": cmd_decide,
    "decide-many": cmd_decide_many, "taxonomy": cmd_taxonomy, "override": cmd_override, "vendors": cmd_vendors, "draft": cmd_draft,
    "approve-followup": cmd_approve_followup, "send-followup": cmd_send_followup, "resolve-followup": cmd_resolve_followup,
    "match": cmd_match, "import-register": cmd_import_register, "import-2b": cmd_import_2b, "request-signoff": cmd_request_signoff,
    "ca-approve": cmd_ca_approve, "reopen": cmd_reopen, "export": cmd_export, "table4": cmd_table4, "events": cmd_events,
}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        COMMANDS[args.command](args)
        return 0
    except MagpieError as err:
        print("\n".join(error_lines(err)), file=sys.stderr)
        return 2 if err.status else 1
    except (CliError, OSError, ValueError) as err:
        print(f"ERROR: {err}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 0


def readable_snapshot(snapshot: dict) -> str:
    """Compact text for a finance() snapshot (kept from the first version of this client)."""
    domain = snapshot.get("domain", "overview")
    if snapshot.get("status") == "source_not_configured":
        return f"[{domain.upper()}] Not configured: {snapshot.get('message', 'source missing')}"
    if domain == "gst":
        g = snapshot.get("gst", snapshot)
        return (f"[GST CLOSE ROOM] {g.get('period')} status {g.get('status')}: {g['source']['purchaseInvoices']} invoices, "
                f"{g['source']['gstr2bLines']} 2B lines, {g['exceptions']['total']} exceptions ({g['exceptions']['open']} open), "
                f"ITC at risk {g.get('itcAtRisk')}")
    return f"[{domain.upper()}] {snapshot.get('status')}"


if __name__ == "__main__":
    sys.exit(main())
