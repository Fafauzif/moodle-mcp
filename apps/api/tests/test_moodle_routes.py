"""Tests for the Moodle routes: auth, read aggregation and the submission write flow."""

from typing import Any

import pytest
from api import moodle
from api.routers.api.v1 import moodle as routes
from fastapi.testclient import TestClient

from conftest import build_app

GATEWAY_TOKEN = {"x-apps-token": "tok-caller"}


@pytest.fixture
def client() -> TestClient:
    return TestClient(build_app())


def _install(monkeypatch: pytest.MonkeyPatch, responses: dict[str, Any]) -> list[dict[str, Any]]:
    """Replace moodle.call with a recorder answering from ``responses`` by wsfunction."""
    calls: list[dict[str, Any]] = []

    async def fake_call(wsfunction: str, params: dict[str, Any] | None = None) -> Any:
        calls.append({"wsfunction": wsfunction, "params": params or {}})
        handler = responses.get(wsfunction)
        if handler is None:
            return {}
        return handler(params or {}) if callable(handler) else handler

    monkeypatch.setattr(routes.moodle, "call", fake_call)
    return calls


def test_moodle_routes_require_a_gateway_token(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _install(monkeypatch, {
        "core_webservice_get_site_info": {"sitename": "EMAS3", "userid": 42},
        "core_enrol_get_users_courses": [],
    })
    assert client.get("/api/v1/moodle/courses").status_code == 401
    assert client.get("/api/v1/moodle/courses", headers=GATEWAY_TOKEN).status_code == 200


def test_courses_uses_the_current_user(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _install(monkeypatch, {
        "core_webservice_get_site_info": {"sitename": "EMAS3", "userid": 42},
        "core_enrol_get_users_courses": [{"id": 1, "fullname": "Kalkulus"}],
    })
    res = client.get("/api/v1/moodle/courses", headers=GATEWAY_TOKEN)
    assert res.status_code == 200
    assert res.json()["items"] == [{"id": 1, "fullname": "Kalkulus"}]
    user_calls = [c for c in calls if c["wsfunction"] == "core_enrol_get_users_courses"]
    assert user_calls[0]["params"]["userid"] == 42


def test_deadlines_aggregates_and_sorts(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _install(monkeypatch, {
        "core_webservice_get_site_info": {"sitename": "EMAS3", "userid": 42},
        "core_enrol_get_users_courses": [{"id": 1}],
        "mod_assign_get_assignments": {
            "courses": [{"id": 1, "assignments": [{"id": 5, "name": "HW1", "duedate": 300, "cutoffdate": 0}]}]
        },
        "mod_quiz_get_quizzes_by_courses": {
            "quizzes": [{"id": 7, "name": "Quiz 1", "course": 1, "timeopen": 0, "timeclose": 100}]
        },
        "core_calendar_get_calendar_events": {
            "events": [{"id": 3, "name": "Konsultasi", "timestart": 200, "courseid": 1}]
        },
    })
    res = client.get(
        "/api/v1/moodle/deadlines",
        params={"from_date": "1970-01-01", "to_date": "2100-01-01"},
        headers=GATEWAY_TOKEN,
    )
    assert res.status_code == 200
    names = [item["name"] for item in res.json()["deadlines"]]
    assert names == ["Quiz 1", "Konsultasi", "HW1"]


def test_course_files_collects_downloadable_files(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _install(monkeypatch, {
        "core_course_get_contents": [
            {"name": "Week 1", "modules": [{"name": "Intro", "files": [
                {"filename": "notes.txt", "filesize": 4, "mimetype": "text/plain", "fileurl": "https://moodle.test/f.txt"}
            ]}]},
        ],
    })
    res = client.get("/api/v1/moodle/courses/1/files", headers=GATEWAY_TOKEN)
    assert res.status_code == 200
    body = res.json()
    assert body["count"] == 1
    assert body["files"][0]["filename"] == "notes.txt"


def test_submit_file_uploads_draft_then_saves(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _install(monkeypatch, {
        "mod_assign_save_submission": [],
        "mod_assign_submit_for_grading": {"status": True},
    })
    uploads: list[dict[str, Any]] = []

    async def fake_upload(filename: str, content: bytes) -> int:
        uploads.append({"filename": filename, "content": content})
        return 555

    monkeypatch.setattr(routes.moodle, "upload_draft_file", fake_upload)
    res = client.post(
        "/api/v1/moodle/assignments/9/submit-file",
        json={
            "filename": "report.pdf",
            "file_base64": "aGVsbG8gcGRm",
            "submit_for_grading": True,
        },
        headers=GATEWAY_TOKEN,
    )
    assert res.status_code == 200
    assert uploads[0]["filename"] == "report.pdf"
    assert uploads[0]["content"] == b"hello pdf"
    save = [c for c in calls if c["wsfunction"] == "mod_assign_save_submission"][0]
    assert save["params"]["assignmentid"] == 9
    assert save["params"]["plugindata"] == {"files_filemanager": 555}
    assert any(c["wsfunction"] == "mod_assign_submit_for_grading" for c in calls)


def test_raw_call_passes_function_and_params(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _install(monkeypatch, {"mod_forum_get_forums": [{"id": 1}]})
    res = client.post(
        "/api/v1/moodle/raw",
        json={"wsfunction": "mod_forum_get_forums", "params": {"courseids": [1]}},
        headers=GATEWAY_TOKEN,
    )
    assert res.status_code == 200
    assert res.json()["result"] == [{"id": 1}]
    assert calls[0]["params"] == {"courseids": [1]}
