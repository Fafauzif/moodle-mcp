"""Who may call the API host from a browser or a direct HTTPS client.

Shipped by `fastapi`, not `core`: these settings describe the HTTP host, and nothing outside
`apps/api` reads them. `app_access_key` is the static key for deployments served without the
Mistral gateway, such as an Azure Container App; empty means the gateway token is the only way in.
"""

from env._base import BaseEnv


class Env(BaseEnv):
    cors_origin: str = "http://localhost:3001"
    app_access_key: str = ""


env = Env()
