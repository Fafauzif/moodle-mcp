"""The static access key lets a non-gateway deployment authenticate its callers.

The gateway-token path is covered by the Moodle route tests; these cover the ``APP_ACCESS_KEY``
path an Azure Container App relies on, including that it is off while the key is unset.
"""

from typing import Any

import pytest
from api.routers.api.v1 import ACCESS_KEY_HEADER
from api.routers.api.v1 import moodle as routes
from env.api import env as api_env
from fastapi.testclient import TestClient

from conftest import build_app

PROBE = "/api/v1/moodle/courses"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    async def fake_call(wsfunction: str, params: dict[str, Any] | None = None) -> Any:
        return {"sitename": "EMAS3", "userid": 42} if wsfunction == "core_webservice_get_site_info" else []

    monkeypatch.setattr(routes.moodle, "call", fake_call)
    return TestClient(build_app())


def _set_key(monkeypatch: pytest.MonkeyPatch, key: str) -> None:
    monkeypatch.setattr(api_env, "app_access_key", key)


def test_a_matching_access_key_is_accepted(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _set_key(monkeypatch, "sekrit")
    assert client.get(PROBE, headers={ACCESS_KEY_HEADER: "sekrit"}).status_code == 200


def test_a_wrong_or_missing_key_is_refused(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _set_key(monkeypatch, "sekrit")
    assert client.get(PROBE).status_code == 401
    assert client.get(PROBE, headers={ACCESS_KEY_HEADER: "wrong"}).status_code == 401


def test_an_unset_key_disables_the_path(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _set_key(monkeypatch, "")
    assert client.get(PROBE, headers={ACCESS_KEY_HEADER: "sekrit"}).status_code == 401


def test_the_gateway_token_still_works_alongside(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _set_key(monkeypatch, "sekrit")
    assert client.get(PROBE, headers={"x-apps-token": "tok-caller"}).status_code == 200
