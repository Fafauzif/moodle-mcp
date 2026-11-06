"""Thin async client for the Moodle Web Services REST API.

One function covers nearly every call: ``call`` posts a ``wsfunction`` with the token and returns
the decoded JSON, raising ``MoodleError`` when Moodle answers with an ``exception``. Parameter
values follow Moodle's PHP bracket notation: nested dicts and lists are flattened into
``options[timestart]`` and ``courseids[0]``-style keys, and booleans become ``1``/``0``.
"""

from base64 import b64decode, b64encode
from typing import Any
from urllib.parse import quote

import httpx
from env.moodle import env as moodle_env

TEXTUAL_MIME_PREFIXES = ("text/", "application/json", "application/xml", "application/javascript")
REQUEST_TIMEOUT_SECONDS = 20.0


class MoodleError(RuntimeError):
    """A Moodle call that answered with an exception, or could not be completed."""


def _flatten(params: dict[str, Any], prefix: str = "") -> list[tuple[str, str]]:
    flat: list[tuple[str, str]] = []
    for key, value in params.items():
        name = f"{prefix}[{key}]" if prefix else str(key)
        if value is None:
            continue
        if isinstance(value, bool):
            flat.append((name, "1" if value else "0"))
        elif isinstance(value, dict):
            flat.extend(_flatten(value, name))
        elif isinstance(value, (list, tuple)):
            for index, item in enumerate(value):
                item_name = f"{name}[{index}]"
                if isinstance(item, dict):
                    flat.extend(_flatten(item, item_name))
                elif isinstance(item, bool):
                    flat.append((item_name, "1" if item else "0"))
                else:
                    flat.append((item_name, str(item)))
        else:
            flat.append((name, str(value)))
    return flat


def _server_url() -> str:
    return moodle_env.moodle_url.rstrip("/")


def _token() -> str:
    token = moodle_env.moodle_token
    if not token:
        raise MoodleError("MOODLE_TOKEN is not configured: set it in the environment or as a workspace secret")
    return token


async def call(wsfunction: str, params: dict[str, Any] | None = None) -> Any:
    """Call one Moodle web-service function and return its decoded response."""
    query = {
        "wstoken": _token(),
        "wsfunction": wsfunction,
        "moodlewsrestformat": "json",
    }
    form = _flatten(params or {})
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        response = await client.post(
            f"{_server_url()}/webservice/rest/server.php",
            params=query,
            data=form,
        )
    payload = _decode(response)
    if isinstance(payload, dict) and payload.get("exception"):
        raise MoodleError(f"Moodle error ({payload.get('exception')}): {payload.get('message', 'unknown')}")
    return payload


def _decode(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError as error:
        raise MoodleError(f"Moodle returned a non-JSON response (HTTP {response.status_code})") from error


async def get_user_id() -> int:
    info = await call("core_webservice_get_site_info")
    if not isinstance(info, dict) or not info.get("userid"):
        raise MoodleError("Could not determine the user id from core_webservice_get_site_info")
    return int(info["userid"])


async def get_course_ids() -> list[int]:
    courses = await call("core_enrol_get_users_courses", {"userid": await get_user_id()})
    if not isinstance(courses, list):
        return []
    return [int(course["id"]) for course in courses if course.get("id")]


async def upload_draft_file(filename: str, content: bytes) -> int:
    """Upload bytes to the user's draft area and return the draft item id."""
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        response = await client.post(
            f"{_server_url()}/webservice/upload.php",
            params={"token": _token(), "itemid": 0},
            data={"filearea": "draft", "filepath": "/", "filename": filename},
            files={"file": (filename, content)},
        )
    payload = _decode(response)
    if isinstance(payload, list) and payload and payload[0].get("itemid"):
        return int(payload[0]["itemid"])
    raise MoodleError(f"Moodle file upload failed: {str(payload)[:500]}")


async def download_file(fileurl: str, *, as_base64: bool = False) -> dict[str, Any]:
    """Fetch one Moodle file URL with the token, returning text content or base64."""
    separator = "&" if "?" in fileurl else "?"
    url = f"{fileurl}{separator}token={quote(_token())}&forcedownload=1"
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS, follow_redirects=True) as client:
        response = await client.get(url)
    if response.status_code >= 400:
        raise MoodleError(f"Moodle file download failed: HTTP {response.status_code}")
    content = response.content
    mimetype = (response.headers.get("content-type") or "").split(";")[0]
    result: dict[str, Any] = {
        "filename": fileurl.rsplit("/", 1)[-1] or "file",
        "size": len(content),
        "mimetype": mimetype,
    }
    textual = mimetype.startswith(TEXTUAL_MIME_PREFIXES)
    if not as_base64 and textual and len(content) <= 262144:
        result["encoding"] = "utf8"
        result["content"] = content.decode("utf8", errors="replace")
    else:
        result["encoding"] = "base64"
        result["base64"] = b64encode(content).decode("ascii")
    return result


def decode_base64(content_b64: str) -> bytes:
    """Decode base64 file content from a request body."""
    try:
        return b64decode(content_b64, validate=True)
    except Exception as error:
        raise MoodleError("file_base64 is not valid base64") from error
