import app as brain_app
from services import api_contract


def test_api_contract_returns_required_keys():
    client = brain_app.app.test_client()

    resp = client.get("/api/contract")
    assert resp.status_code == 200

    payload = resp.get_json()
    for key in api_contract.REQUIRED_TOP_LEVEL_KEYS:
        assert key in payload

    endpoint_names = {ep["name"] for ep in payload["endpoints"]}
    assert {
        "flights_daily",
        "staff_list",
        "runs_daily",
        "runs_auto_assign",
        "wiring_status",
        "api_contract",
    }.issubset(endpoint_names)


def test_api_contract_validation_failure(monkeypatch):
    client = brain_app.app.test_client()
    original_build = api_contract.build_contract

    def bad_contract():
        contract = original_build()
        contract.pop("service_name", None)
        return contract

    monkeypatch.setattr(api_contract, "build_contract", bad_contract)

    resp = client.get("/api/contract")
    assert resp.status_code == 500
    payload = resp.get_json()
    assert payload["error"]["code"] == "invalid_contract"
