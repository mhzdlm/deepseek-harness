"""Loop Engineering audit-header validation as a callable kernel skill.

The audit protocol requires the first three non-empty lines of an auditor
report to carry exactly one verdict per line, in order::

    Status: complete|incomplete|blocked
    Integrity: clean|suspect|violation
    Contract audit: aligned|unknown|needs_revision|invalid

Only this header is machine-acted on; the prose body stays evidence for the
manager. ``run`` parses the header, lists every concrete problem when it does
not match (so the model can rewrite and retry), and states the trust-gate
verdict — complete + clean + aligned is the only combination that becomes
verified progress.
"""

import re

_STATUS_LINE = re.compile(r"^status:\s*(complete|incomplete|blocked)$", re.IGNORECASE)
_INTEGRITY_LINE = re.compile(r"^integrity:\s*(clean|suspect|violation)$", re.IGNORECASE)
_CONTRACT_LINE = re.compile(r"^contract audit:\s*(aligned|unknown|needs_revision|invalid)$", re.IGNORECASE)

_LINES = (
    ("Status", _STATUS_LINE),
    ("Integrity", _INTEGRITY_LINE),
    ("Contract audit", _CONTRACT_LINE),
)


def parse_header(report):
    """Parse the three-line audit header.

    Returns ``{"status": ..., "integrity": ..., "contract": ...}`` or ``None``
    when the first three non-empty lines are not exactly the ordered triple.
    Mirrors the host-side deterministic parser: CRLF/LF both work, lines are
    trimmed, a malformed header is never guessed.
    """
    lines = [line.strip() for line in str(report or "").splitlines() if line.strip()]
    if len(lines) < 3:
        return None
    status = _STATUS_LINE.match(lines[0])
    integrity = _INTEGRITY_LINE.match(lines[1])
    contract = _CONTRACT_LINE.match(lines[2])
    if not status or not integrity or not contract:
        return None
    return {
        "status": status.group(1).lower(),
        "integrity": integrity.group(1).lower(),
        "contract": contract.group(1).lower(),
    }


def is_clean_complete(header):
    """Whether the header clears the trust gate for verified progress."""
    return bool(header) and header["status"] == "complete" \
        and header["integrity"] == "clean" and header["contract"] == "aligned"


def _problems(report):
    """Concrete per-line reasons the report header fails the protocol."""
    lines = [line.strip() for line in str(report or "").splitlines() if line.strip()]
    problems = []
    if len(lines) < 3:
        problems.append(
            f"report has {len(lines)} non-empty line(s); the protocol needs at least 3"
        )
        return problems
    for index, (label, pattern) in enumerate(_LINES):
        line = lines[index]
        if not pattern.match(line):
            alternatives = {
                "Status": "Status: complete | incomplete | blocked",
                "Integrity": "Integrity: clean | suspect | violation",
                "Contract audit": "Contract audit: aligned | unknown | needs_revision | invalid",
            }[label]
            problems.append(
                f"line {index + 1} must be exactly `{alternatives}` (case-insensitive); got `{line}`"
            )
    return problems


async def run(report=""):
    """Validate an auditor report's three-line header.

    Returns ``{"ok": <trust gate>, "header": <dict|None>, "problems": [...]}``.
    ``ok`` is True only for a complete/clean/aligned header — the only verdict
    triple the loop records as trusted progress.
    """
    header = parse_header(report)
    problems = [] if header else _problems(report)
    return {"ok": is_clean_complete(header), "header": header, "problems": problems}
