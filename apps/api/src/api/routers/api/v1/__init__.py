"""The authenticated API group: every route beneath requires a caller credential.

Requests that reach the app through the Mistral Apps gateway carry the caller's short-lived token
in the ``x-apps-token`` header. Deployments served without the gateway, such as an Azure Container
App, accept a static ``x-app-access-key`` header checked against the ``APP_ACCESS_KEY`` secret
instead. Requiring one of the two keeps the Moodle endpoints private to callers holding a
credential — a request from anywhere else is refused.
"""

from secrets import compare_digest

from fastapi import HTTPException, Request, params
from mistralai_capabilities.apps.tokens import token_from

from env.api import env as api_env

ACCESS_KEY_HEADER = "x-app-access-key"


def require_caller(request: Request) -> None:
    """Refuse any request that presents neither a gateway token nor the access key."""
    if token_from(request.headers):
        return
    expected = api_env.app_access_key
    presented = request.headers.get(ACCESS_KEY_HEADER, "")
    if expected and compare_digest(presented.encode(), expected.encode()):
        return
    raise HTTPException(status_code=401, detail="A gateway caller token or the app access key is required")


dependencies: tuple[params.Depends, ...] = (params.Depends(require_caller),)
