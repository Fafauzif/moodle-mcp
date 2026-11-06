"""Moodle LMS connection settings for the web-services REST API.

``moodle_token`` is a workspace secret: locally it comes from the environment or the repo-root
``.env``, and deployed it comes from the Mistral workspace secret of the same name, so the token
never lives in the repository.
"""

from typing import Annotated

from env import BaseEnv, WorkspaceSecret


class Env(BaseEnv):
    moodle_url: str = "https://emas3.ui.ac.id"
    moodle_token: Annotated[str, WorkspaceSecret] = ""


env = Env()
