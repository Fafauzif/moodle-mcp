"""The authenticated API group: every route beneath requires a gateway caller token.

Requests that reach the app through the Mistral Apps gateway carry the caller's short-lived token
in the ``x-apps-token`` header. Requiring it keeps the Moodle endpoints private to calls made
through the platform — a request from anywhere else is refused.
"""

from fastapi import HTTPException, Request, params
from mistralai_capabilities.apps.tokens import token_from


def require_caller(request: Request) -> None:
    """Refuse any request that did not come through the platform gateway."""
    if not token_from(request.headers):
        raise HTTPException(status_code=401, detail="A gateway caller token is required")


dependencies: tuple[params.Depends, ...] = (params.Depends(require_caller),)
