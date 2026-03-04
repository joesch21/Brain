from services.brain_control import BrainControlService


def test_dispatch_job_returns_envelope_keys_without_upstream():
    service = BrainControlService(base_url="")

    run = service.dispatch_job(mode="build", payload={"prompt": "hello"}, caller="brain:test")

    assert run["run_id"]
    assert set(run.keys()) == {
        "run_id",
        "open_url",
        "preview_url",
        "report_url",
        "latest_url",
        "status",
    }


def test_follow_unknown_run_returns_structured_not_found():
    service = BrainControlService(base_url="")

    result = service.follow_run("missing-run")

    assert result["ok"] is False
    assert result["error"]["code"] == "not_found"
