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


def reconciliation() -> dict:
    """Return the latest reconciliation queue and cash-at-risk summary."""

    return finance("reconciliation")


def finance(domain: str = "overview") -> dict:
    """Read one finance capability through Magpie's Switch boundary."""

    allowed = {"overview", "reconciliation", "taxonomy", "gst", "cashflow", "reporting"}
    if domain not in allowed:
        raise ValueError(f"domain must be one of {sorted(allowed)}")
    return _request("GET", f"/api/switch/finance?domain={domain}")


def readable_snapshot(snapshot: dict) -> str:
    """Render a compact, predictable summary for a Switch room message."""

    domain = snapshot.get("domain", "overview")
    status = snapshot.get("status", "ready")
    if status == "source_not_configured":
        return f"[{domain.upper()}] Not configured: {snapshot.get('message', 'source missing')}"
    if domain == "reconciliation":
        summary = snapshot.get("reconciliation", {}).get("summary", {})
        return (
            "[RECONCILIATION]\n"
            f"Open exceptions: {summary.get('openExceptions', 0)}\n"
            f"Accepted: {summary.get('acceptedExceptions', 0)} | "
            f"Rejected: {summary.get('rejectedExceptions', 0)}\n"
            f"Open at risk: {summary.get('openAtRiskPaise', 0)} paise"
        )
    if domain == "cashflow":
        cash = snapshot.get("cash") or {}
        return (
            "[CASH FLOW]\n"
            f"Reconciled: {cash.get('totalReconciledPaise', 0)} paise\n"
            f"In flight: {cash.get('totalInFlightPaise', 0)} paise\n"
            f"At risk: {cash.get('totalAtRiskPaise', 0)} paise"
        )
    return f"[{domain.upper()}] {status}"


def resolve_exception(
    exception_id: str,
    decision: str,
    scope: str,
    note: str | None = None,
) -> dict:
    """Record a human-approved exception decision in Magpie."""

    if decision not in {"accepted", "rejected"}:
        raise ValueError("decision must be accepted or rejected")
    payload = {"exceptionId": exception_id, "decision": decision, "scope": scope}
    if note:
        payload["note"] = note
    return _request("POST", "/api/switch/reconciliation", payload)
