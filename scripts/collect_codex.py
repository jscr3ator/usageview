from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


COMPLETED_MARKER = '{"type":"response.completed"'
TURN_USAGE_RE = re.compile(r"(total_usage_tokens|estimated_token_count)=([^\s,}]+)")
MODEL_RE = re.compile(r"\bmodel=([A-Za-z0-9_.:-]+)")


@dataclass
class UsageEvent:
    response_id: str
    ts: int
    model: str
    input_tokens: int
    output_tokens: int
    cached_tokens: int
    reasoning_tokens: int
    total_tokens: int


def main() -> int:
    home = Path.home()
    log_path = Path(os.getenv("CODEX_LOG_PATH") or home / ".codex" / "logs_2.sqlite")
    sessions_path = Path(os.getenv("CODEX_SESSIONS_PATH") or home / ".codex" / "sessions")
    status_path = Path(os.getenv("CODEX_STATUS_PATH") or home / ".codex" / "codex-status.json")
    max_status_age = int(os.getenv("CODEX_STATUS_MAX_AGE_SECONDS") or "900")
    tz = safe_zone(os.getenv("DISPLAY_TZ") or "UTC")
    now = int(time.time())

    events, usage_error = read_usage_events(log_path)
    session_totals, session_error = read_session_usage_totals(sessions_path, tz)
    usage = summarize_usage(events, tz, session_totals)
    limits, limit_error = read_limits(status_path, sessions_path, max_status_age, now)

    payload = {
        "ok": True,
        "source": "Codex local logs and session telemetry",
        "usage": usage,
        "limits": limits,
        "errors": [error for error in (usage_error, session_error, limit_error) if error],
    }
    print(json.dumps(payload, separators=(",", ":")))
    return 0


def read_usage_events(log_path: Path) -> tuple[list[UsageEvent], str | None]:
    if not log_path.exists():
        return [], "Codex log database was not found"

    try:
        with sqlite3.connect(f"file:{log_path}?mode=ro", uri=True) as conn:
            events = completed_events(conn)
            if not events:
                events = turn_usage_events(conn)
            return events, None
    except Exception as error:  # noqa: BLE001 - surfaced as collector status
        return [], f"Could not read Codex usage logs: {error}"


def completed_events(conn: sqlite3.Connection) -> list[UsageEvent]:
    rows = conn.execute(
        """
        select id, ts, feedback_log_body
        from logs
        where target = 'codex_api::endpoint::responses_websocket'
          and feedback_log_body like ?
        order by id
        """,
        ("%response.completed%",),
    )
    decoder = json.JSONDecoder()
    by_response: dict[str, UsageEvent] = {}

    for log_id, ts, body in rows:
        if not body:
            continue
        marker = body.find(COMPLETED_MARKER)
        if marker < 0:
            continue
        try:
            event_payload, _ = decoder.raw_decode(body[marker:])
        except json.JSONDecodeError:
            continue

        response = event_payload.get("response") or {}
        usage = response.get("usage") or {}
        input_details = usage.get("input_tokens_details") or {}
        output_details = usage.get("output_tokens_details") or {}
        input_tokens = to_int(usage.get("input_tokens"))
        output_tokens = to_int(usage.get("output_tokens"))
        total_tokens = to_int(usage.get("total_tokens")) or input_tokens + output_tokens
        response_id = str(response.get("id") or log_id)
        by_response[response_id] = UsageEvent(
            response_id=response_id,
            ts=int(ts),
            model=str(response.get("model") or "unknown"),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_tokens=to_int(input_details.get("cached_tokens")),
            reasoning_tokens=to_int(output_details.get("reasoning_tokens")),
            total_tokens=total_tokens,
        )
    return list(by_response.values())


def turn_usage_events(conn: sqlite3.Connection) -> list[UsageEvent]:
    rows = conn.execute(
        """
        select id, ts, feedback_log_body
        from logs
        where target = 'codex_core::session::turn'
          and feedback_log_body like '%post sampling token usage%'
        order by id
        """
    )
    events: list[UsageEvent] = []
    for log_id, ts, body in rows:
        fields = dict(TURN_USAGE_RE.findall(body or ""))
        total_tokens = to_int(fields.get("total_usage_tokens"))
        if total_tokens <= 0:
            continue
        estimated = parse_optional_int(fields.get("estimated_token_count"))
        model_match = MODEL_RE.search(body or "")
        events.append(
            UsageEvent(
                response_id=f"turn-{log_id}",
                ts=int(ts),
                model=model_match.group(1) if model_match else "unknown",
                input_tokens=estimated,
                output_tokens=max(0, total_tokens - estimated),
                cached_tokens=0,
                reasoning_tokens=0,
                total_tokens=total_tokens,
            )
        )
    return events


def read_session_usage_totals(sessions_path: Path, tz: ZoneInfo) -> tuple[dict | None, str | None]:
    if not sessions_path.exists():
        return None, "Codex sessions directory was not found"

    today = datetime.now(tz).date()
    total_tokens = 0
    total_sessions = 0
    latest_at = 0

    try:
        for path in sessions_path.rglob("*.jsonl"):
            latest_total = 0
            latest_ts = 0
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    if '"token_count"' not in line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    payload = event.get("payload") or {}
                    if payload.get("type") != "token_count":
                        continue
                    info = payload.get("info") or {}
                    total_usage = info.get("total_token_usage") or {}
                    tokens = to_int(total_usage.get("total_tokens"))
                    ts = parse_timestamp(event.get("timestamp"))
                    if tokens > 0 and ts >= latest_ts:
                        latest_total = tokens
                        latest_ts = ts

            if latest_total > 0:
                total_tokens += latest_total
                total_sessions += 1
                latest_at = max(latest_at, latest_ts)
    except Exception as error:  # noqa: BLE001
        return None, f"Could not read Codex session usage totals: {error}"

    if total_sessions == 0:
        return None, "No Codex session token totals were found"

    return {
        "totalTokens": total_tokens,
        "totalSessions": total_sessions,
        "latestAt": datetime.fromtimestamp(latest_at, tz).isoformat() if latest_at else None,
        "source": "Codex session cumulative token_count telemetry",
    }, None


def summarize_usage(events: list[UsageEvent], tz: ZoneInfo, session_totals: dict | None = None) -> dict:
    today = datetime.now(tz).date()
    start_day = today - timedelta(days=6)
    day_totals = {start_day + timedelta(days=index): 0 for index in range(7)}
    model_totals: dict[str, int] = {}
    summary = {
        "totalTokens": 0,
        "totalCalls": 0,
        "totalSessions": 0,
        "todayTokens": 0,
        "todayCalls": 0,
        "todayInput": 0,
        "todayOutput": 0,
        "todayCached": 0,
        "todayReasoning": 0,
        "weekTokens": 0,
        "weekCalls": 0,
        "dailyTokens": [],
        "modelTokens": [],
        "latestAt": None,
        "allTimeSource": "response events",
    }
    if not events:
        if session_totals:
            summary["totalTokens"] = session_totals.get("totalTokens", 0)
            summary["totalSessions"] = session_totals.get("totalSessions", 0)
            summary["latestAt"] = session_totals.get("latestAt")
            summary["allTimeSource"] = session_totals.get("source", "session totals")
        return summary

    latest = max(events, key=lambda event: event.ts)
    summary["latestAt"] = datetime.fromtimestamp(latest.ts, tz).isoformat()

    for event in events:
        event_day = datetime.fromtimestamp(event.ts, tz).date()
        summary["totalTokens"] += event.total_tokens
        summary["totalCalls"] += 1
        model_totals[event.model] = model_totals.get(event.model, 0) + event.total_tokens

        if event_day == today:
            summary["todayTokens"] += event.total_tokens
            summary["todayCalls"] += 1
            summary["todayInput"] += event.input_tokens
            summary["todayOutput"] += event.output_tokens
            summary["todayCached"] += event.cached_tokens
            summary["todayReasoning"] += event.reasoning_tokens

        if start_day <= event_day <= today:
            summary["weekTokens"] += event.total_tokens
            summary["weekCalls"] += 1
            day_totals[event_day] = day_totals.get(event_day, 0) + event.total_tokens

    summary["dailyTokens"] = [
        {"label": day.strftime("%a"), "tokens": tokens}
        for day, tokens in sorted(day_totals.items())
    ]
    summary["modelTokens"] = [
        {"model": model, "tokens": tokens}
        for model, tokens in sorted(model_totals.items(), key=lambda item: item[1], reverse=True)[:5]
    ]

    if session_totals and session_totals.get("totalTokens", 0) > summary["totalTokens"]:
        summary["totalTokens"] = session_totals.get("totalTokens", 0)
        summary["totalSessions"] = session_totals.get("totalSessions", 0)
        summary["latestAt"] = session_totals.get("latestAt") or summary["latestAt"]
        summary["allTimeSource"] = session_totals.get("source", "session totals")

    return summary


def read_limits(status_path: Path, sessions_path: Path, max_status_age: int, now: int) -> tuple[dict | None, str | None]:
    status_limits = read_status_limits(status_path, max_status_age, now)
    if status_limits:
        return refresh_limits(status_limits, now), None

    if not sessions_path.exists():
        return None, "Codex sessions directory was not found"

    latest: tuple[int, dict] | None = None
    try:
        files = sorted(sessions_path.rglob("*.jsonl"), key=lambda path: path.stat().st_mtime, reverse=True)[:80]
        for path in files:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    payload = event.get("payload") or {}
                    if payload.get("type") != "token_count":
                        continue
                    rate_limits = payload.get("rate_limits")
                    if not isinstance(rate_limits, dict):
                        continue
                    ts = parse_timestamp(event.get("timestamp"))
                    if latest is None or ts >= latest[0]:
                        latest = (ts, rate_limits)
    except Exception as error:  # noqa: BLE001
        return None, f"Could not read Codex limit telemetry: {error}"

    if latest is None:
        return None, "No Codex limit telemetry was found"

    ts, raw = latest
    limits = {
        "source": "Codex session token_count telemetry",
        "updatedAt": datetime.fromtimestamp(ts, ZoneInfo("UTC")).isoformat(),
        "ageSeconds": max(0, now - ts),
        "stale": now - ts > 900,
        "primary": parse_window(raw.get("primary")),
        "secondary": parse_window(raw.get("secondary")),
    }
    return refresh_limits(limits, now), None


def read_status_limits(path: Path, max_age: int, now: int) -> dict | None:
    if max_age <= 0 or not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    updated_at = to_int(payload.get("updated_at"))
    if updated_at <= 0 or now - updated_at > max_age:
        return None
    return {
        "source": "Codex /status snapshot",
        "updatedAt": datetime.fromtimestamp(updated_at, ZoneInfo("UTC")).isoformat(),
        "ageSeconds": max(0, now - updated_at),
        "stale": False,
        "primary": parse_window(payload.get("primary")),
        "secondary": parse_window(payload.get("secondary")),
    }


def parse_window(value: object) -> dict | None:
    if not isinstance(value, dict):
        return None
    used = to_float(value.get("used_percent"))
    remaining = value.get("remaining_percent")
    if remaining is None and used is not None:
        remaining = max(0.0, min(100.0, 100.0 - used))
    return {
        "usedPercent": used,
        "remainingPercent": to_float(remaining),
        "windowMinutes": to_int(value.get("window_minutes")),
        "resetsAt": to_int(value.get("resets_at")) or None,
        "inferredReset": bool(value.get("inferred_reset")),
    }


def refresh_limits(limits: dict, now: int) -> dict:
    limits["primary"] = refresh_window(limits.get("primary"), now)
    limits["secondary"] = refresh_window(limits.get("secondary"), now)
    return limits


def refresh_window(window: dict | None, now: int) -> dict | None:
    if not window or not window.get("resetsAt") or not window.get("windowMinutes"):
        return window
    reset = int(window["resetsAt"])
    if now < reset:
        return window
    period = max(60, int(window["windowMinutes"]) * 60)
    while reset <= now:
        reset += period
    return {
        **window,
        "usedPercent": 0.0,
        "remainingPercent": 100.0,
        "resetsAt": reset,
        "inferredReset": True,
    }


def parse_timestamp(value: object) -> int:
    if not value:
        return 0
    text = str(value).replace("Z", "+00:00")
    try:
        return int(datetime.fromisoformat(text).timestamp())
    except ValueError:
        return 0


def safe_zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def to_int(value: object) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0


def to_float(value: object) -> float | None:
    try:
        return round(float(value), 2)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def parse_optional_int(value: str | None) -> int:
    if not value:
        return 0
    match = re.search(r"\d+", value)
    return int(match.group(0)) if match else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
