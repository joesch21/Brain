from __future__ import annotations

import os
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional

import requests

VALID_MODES = {"build", "fix", "know"}


@dataclass
class RunRecord:
    run_id: str
    mode: str
    payload: Dict[str, Any]
    caller: str
    status: str
    open_url: str
    preview_url: Optional[str]
    report_url: str
    latest_url: str
    report: Optional[Dict[str, Any]] = None
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_run_envelope(self) -> Dict[str, Any]:
        return {
            "run_id": self.run_id,
            "open_url": self.open_url,
            "preview_url": self.preview_url,
            "report_url": self.report_url,
            "latest_url": self.latest_url,
            "status": self.status,
        }


class BrainControlService:
    def __init__(
        self,
        *,
        base_url: Optional[str] = None,
        dispatch_path: Optional[str] = None,
        upstream_base_getter: Optional[Callable[[], str]] = None,
        request_timeout: float = 8.0,
    ) -> None:
        self._base_url = (base_url or os.getenv("CC_BASE_URL", "")).strip().rstrip("/")
        self._dispatch_path = dispatch_path or os.getenv("CC_DISPATCH_PATH", "/api/run")
        self._upstream_base_getter = upstream_base_getter
        self._request_timeout = request_timeout
        self._runs: Dict[str, RunRecord] = {}
        self._lock = threading.Lock()

    def _resolve_base_url(self) -> str:
        if self._upstream_base_getter:
            candidate = (self._upstream_base_getter() or "").strip().rstrip("/")
            if candidate:
                return candidate
        return self._base_url

    def _url(self, base_url: str, path: str) -> str:
        safe_path = path if path.startswith("/") else f"/{path}"
        return f"{base_url}{safe_path}"

    def _placeholder_record(
        self,
        *,
        run_id: str,
        mode: str,
        payload: Dict[str, Any],
        caller: str,
        reason: str,
        code: str,
    ) -> RunRecord:
        return RunRecord(
            run_id=run_id,
            mode=mode,
            payload=payload,
            caller=caller,
            status="failed",
            open_url=f"/runs/{run_id}",
            preview_url=None,
            report_url=f"/api/follow/{run_id}",
            latest_url="/api/runs/latest",
            report={"error": {"code": code, "message": reason}},
        )

    def _store(self, record: RunRecord) -> None:
        with self._lock:
            record.updated_at = datetime.now(timezone.utc).isoformat()
            self._runs[record.run_id] = record

    def _coerce_upstream_envelope(self, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        run = data.get("run") if isinstance(data.get("run"), dict) else data
        required = {"run_id", "open_url", "report_url", "latest_url", "status"}
        if not isinstance(run, dict) or not required.issubset(set(run.keys())):
            return None
        return {
            "run_id": str(run["run_id"]),
            "open_url": str(run["open_url"]),
            "preview_url": run.get("preview_url"),
            "report_url": str(run["report_url"]),
            "latest_url": str(run["latest_url"]),
            "status": str(run["status"]),
        }

    def dispatch_job(
        self,
        mode: str,
        payload: Optional[Dict[str, Any]],
        caller: Optional[str] = None,
    ) -> Dict[str, Any]:
        normalized_mode = (mode or "").strip().lower()
        normalized_payload = payload if isinstance(payload, dict) else {}
        normalized_caller = (caller or "brain").strip() or "brain"

        if normalized_mode not in VALID_MODES:
            raise ValueError(f"Invalid mode '{mode}'. Expected one of: {sorted(VALID_MODES)}")

        base_url = self._resolve_base_url()
        run_id = uuid.uuid4().hex

        if not base_url:
            record = self._placeholder_record(
                run_id=run_id,
                mode=normalized_mode,
                payload=normalized_payload,
                caller=normalized_caller,
                reason="CodeCrafter upstream is not configured",
                code="upstream_not_configured",
            )
            self._store(record)
            return record.to_run_envelope()

        envelope = {
            "mode": normalized_mode,
            "payload": normalized_payload,
            "caller": normalized_caller,
        }

        try:
            response = requests.post(
                self._url(base_url, self._dispatch_path),
                json=envelope,
                timeout=self._request_timeout,
            )
            response.raise_for_status()
            upstream_data = response.json()
            run = self._coerce_upstream_envelope(upstream_data)
            if run is None:
                raise ValueError("Upstream response did not include a valid run envelope")

            record = RunRecord(
                run_id=run["run_id"],
                mode=normalized_mode,
                payload=normalized_payload,
                caller=normalized_caller,
                status=run["status"],
                open_url=run["open_url"],
                preview_url=run.get("preview_url"),
                report_url=run["report_url"],
                latest_url=run["latest_url"],
            )
            self._store(record)
            return record.to_run_envelope()
        except (requests.RequestException, ValueError) as exc:
            record = self._placeholder_record(
                run_id=run_id,
                mode=normalized_mode,
                payload=normalized_payload,
                caller=normalized_caller,
                reason=str(exc),
                code="upstream_dispatch_failed",
            )
            self._store(record)
            return record.to_run_envelope()

    def follow_run(self, run_id: str) -> Dict[str, Any]:
        with self._lock:
            record = self._runs.get(run_id)

        if record is None:
            return {
                "ok": False,
                "run_id": run_id,
                "status": "not_found",
                "report": None,
                "error": {"code": "not_found", "message": f"Run '{run_id}' was not found"},
            }

        return {
            "ok": True,
            "run_id": record.run_id,
            "status": record.status,
            "report": record.report,
            "error": None,
        }
