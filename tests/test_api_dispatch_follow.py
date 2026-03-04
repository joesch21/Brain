import app as brain_app


def test_dispatch_requires_mode():
    client = brain_app.app.test_client()

    response = client.post("/api/dispatch", json={"payload": {"prompt": "hi"}})

    assert response.status_code == 400
    body = response.get_json()
    assert body["ok"] is False
    assert body["error"]["code"] == "validation_error"


def test_dispatch_and_follow_returns_contract():
    client = brain_app.app.test_client()

    response = client.post(
        "/api/dispatch",
        json={"mode": "know", "payload": {"prompt": "status"}, "caller": "brain:test"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["ok"] is True
    assert "run" in body

    run = body["run"]
    for key in ("run_id", "open_url", "preview_url", "report_url", "latest_url", "status"):
        assert key in run

    follow = client.get(f"/api/follow/{run['run_id']}")
    assert follow.status_code == 200
    follow_body = follow.get_json()
    assert follow_body["ok"] is True
    assert follow_body["run_id"] == run["run_id"]
    assert "report" in follow_body
