"""Small Switch agent client for Magpie's protected finance API."""

import json
import os
import urllib.error
import urllib.request


class MagpieError(RuntimeError):
    """Raised when Magpie rejects a Switch tool call."""


def _request(method: str, path: str, payload: dict | None = None) -> dict:
    base_url = os.environ["MAGPIE_API_URL"].rstrip("/")
    token = os.environ["MAGPIE_SWITCH_TOKEN"]
    body = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "X-Switch-Agent": os.environ.get("SWITCH_AGENT_NAME", "switch-agent"),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise MagpieError(f"Magpie returned HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise MagpieError(f"Magpie is unavailable: {error.reason}") from error


def finance(domain: str = "overview", period: str | None = None) -> dict:
    """Read one finance capability through Magpie's Switch boundary."""

    allowed = {"overview", "gst"}
    if domain not in allowed:
        raise ValueError(f"domain must be one of {sorted(allowed)}")
    query = f"/api/switch/finance?domain={domain}"
    if period:
        query += f"&period={period}"
    return _request("GET", query)


def gst_exceptions(period: str) -> dict:
    """Return the typed GST exception queue for one filing period."""

    return _request("GET", f"/api/switch/gst/exceptions?period={period}")


def gst_decision(exception_id: str, decision: str, scope: str, note: str | None = None) -> dict:
    """Record an accountant-approved claim, defer, or reverse decision."""

    if decision not in {"claim", "defer", "reverse"}:
        raise ValueError("decision must be claim, defer, or reverse")
    payload = {"exceptionId": exception_id, "decision": decision, "scope": scope}
    if note:
        payload["note"] = note
    return _request("POST", "/api/switch/gst/decision", payload)


def vendor_followup(vendor_id: str, period: str, draft: str, action: str = "draft") -> dict:
    """Create or move an approval-gated vendor follow-up through its lifecycle."""

    if action not in {"draft", "approve", "send", "resolve"}:
        raise ValueError("action must be draft, approve, send, or resolve")
    return _request(
        "POST",
        "/api/switch/gst/followup",
        {"vendorId": vendor_id, "period": period, "draft": draft, "action": action},
    )


def approve_gst_summary(period: str) -> dict:
    """Record the final CA approval gate for a GST period."""

    return _request("POST", "/api/switch/gst/summary", {"period": period, "action": "ca_approve"})


def gst_summary(period: str) -> dict:
    """Return the filing summary; export remains gated by CA approval."""

    return _request("GET", f"/api/switch/gst/summary?period={period}")


def readable_snapshot(snapshot: dict) -> str:
    """Render a compact, predictable summary for a Switch room message."""

    domain = snapshot.get("domain", "overview")
    status = snapshot.get("status", "ready")
    if status == "source_not_configured":
        return f"[{domain.upper()}] Not configured: {snapshot.get('message', 'source missing')}"
    if domain == "gst":
        gst = snapshot.get("gst", snapshot)
        source = gst.get("source", {})
        exceptions = gst.get("exceptions", {})
        itc = gst.get("itc", {})
        return (
            "[GST CLOSE ROOM]\n"
            f"Period: {gst.get('period', 'unknown')}\n"
            f"Books: {source.get('purchaseInvoices', 0)} invoices | "
            f"GSTR-2B: {source.get('gstr2bLines', 0)} lines\n"
            f"Exceptions: {exceptions.get('total', 0)} "
            f"(open {exceptions.get('open', 0)})\n"
            f"ITC decisions: claim {itc.get('claimPaise', 0)} paise | "
            f"defer {itc.get('deferPaise', 0)} paise | reverse {itc.get('reversePaise', 0)} paise"
        )
    return f"[{domain.upper()}] {status}"
