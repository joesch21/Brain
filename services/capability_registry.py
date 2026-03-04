import json
from pathlib import Path
from typing import Any, Dict, List, Optional


REQUIRED_FIELDS = [
    "name",
    "version",
    "description",
    "owner",
    "inputs_schema",
    "outputs_schema",
    "effects",
    "idempotency",
    "timeouts",
    "policy",
]


class CapabilityRegistry:
    def __init__(self):
        self._capabilities: Dict[str, Dict[str, Any]] = {}
        self._errors: List[Dict[str, Any]] = []
        self._mtimes: Dict[Path, float] = {}
        self._loaded_from: Optional[Path] = None

    @property
    def errors(self) -> List[Dict[str, Any]]:
        return list(self._errors)

    def load_from_dir(self, path: str, force_reload: bool = False) -> Dict[str, Any]:
        root = Path(path)
        json_files = sorted(root.rglob("*.json"))

        if not force_reload and self._loaded_from == root and self._is_cache_valid(json_files):
            return {"ok": True, "count": len(self._capabilities), "errors": self.errors}

        self._capabilities = {}
        self._errors = []

        for file_path in json_files:
            payload = self._load_json_file(file_path)
            if payload is None:
                continue

            self._validate_and_register(payload, file_path)

        self._loaded_from = root
        self._mtimes = {f: f.stat().st_mtime for f in json_files}
        return {"ok": True, "count": len(self._capabilities), "errors": self.errors}

    def list(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": item["name"],
                "version": item["version"],
                "owner": item["owner"],
                "description": item["description"],
            }
            for item in sorted(self._capabilities.values(), key=lambda cap: cap["name"])
        ]

    def get(self, name: str) -> Optional[Dict[str, Any]]:
        capability = self._capabilities.get(name)
        if capability is None:
            return None
        return dict(capability)

    def _is_cache_valid(self, json_files: List[Path]) -> bool:
        if len(json_files) != len(self._mtimes):
            return False

        for file_path in json_files:
            previous = self._mtimes.get(file_path)
            if previous is None:
                return False
            if file_path.stat().st_mtime != previous:
                return False

        return True

    def _load_json_file(self, file_path: Path) -> Optional[Dict[str, Any]]:
        try:
            with file_path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except json.JSONDecodeError as exc:
            self._errors.append(
                {
                    "code": "invalid_json",
                    "message": "Could not parse JSON file",
                    "file": str(file_path),
                    "detail": {"error": str(exc)},
                }
            )
            return None

        if not isinstance(raw, dict):
            self._errors.append(
                {
                    "code": "invalid_capability",
                    "message": "Capability file must contain a JSON object",
                    "file": str(file_path),
                }
            )
            return None

        return raw

    def _validate_and_register(self, capability: Dict[str, Any], file_path: Path) -> None:
        missing = [field for field in REQUIRED_FIELDS if field not in capability]
        if missing:
            self._errors.append(
                {
                    "code": "missing_required_fields",
                    "message": "Capability is missing required fields",
                    "file": str(file_path),
                    "detail": {"missing": missing},
                }
            )
            return

        name = capability.get("name")
        if not isinstance(name, str) or not name:
            self._errors.append(
                {
                    "code": "invalid_name",
                    "message": "Field 'name' must be a non-empty string",
                    "file": str(file_path),
                }
            )
            return

        if name in self._capabilities:
            self._errors.append(
                {
                    "code": "duplicate_name",
                    "message": f"Duplicate capability name: {name}",
                    "file": str(file_path),
                }
            )
            return

        version = capability.get("version")
        if not isinstance(version, str) or not version:
            self._errors.append(
                {
                    "code": "invalid_version",
                    "message": "Field 'version' must be a non-empty string",
                    "file": str(file_path),
                }
            )
            return

        self._capabilities[name] = dict(capability)
