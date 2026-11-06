# moodle-mcp

A zero-dependency Node.js [Model Context Protocol](https://modelcontextprotocol.io) server that connects AI assistants to a Moodle LMS (e.g. `https://emas3.ui.ac.id`) through Moodle's official Web Services REST API, using the same `moodle_mobile_app` token the official mobile app uses.

## Setup

Get a token with your campus credentials:

```bash
curl "https://emas3.ui.ac.id/login/token.php?username=USERNAME&password=PASSWORD&service=moodle_mobile_app"
```

If your institution uses SSO (no direct Moodle password), open the Moodle mobile app flow once and reuse the token it stores, or ask your site admin for a web service token.

## Run

```bash
MOODLE_URL=https://emas3.ui.ac.id \
MOODLE_TOKEN=<your token> \
node mcp-server/moodlemcp.mjs
```

Or let the server fetch the token itself:

```bash
MOODLE_URL=https://emas3.ui.ac.id \
MOODLE_USERNAME=... MOODLE_PASSWORD=... \
node mcp-server/moodlemcp.mjs
```

## Register with an MCP client

Claude Desktop (`claude_desktop_config.json`), Cursor, or any MCP-capable client:

```json
{
  "mcpServers": {
    "moodle": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/moodlemcp.mjs"],
      "env": {
        "MOODLE_URL": "https://emas3.ui.ac.id",
        "MOODLE_TOKEN": "your token"
      }
    }
  }
}
```

## Tools

Reading your courses and work:

| Tool | Moodle function | Purpose |
| ---- | ---- | ------- |
| `get_site_info` | `core_webservice_get_site_info` | Site name, version, user id |
| `list_courses` | `core_enrol_get_users_courses` | Your enrolled courses |
| `get_course_contents` | `core_course_get_contents` | Sections and activities of a course |
| `get_assignments` | `mod_assign_get_assignments` | Assignments with due dates |
| `get_deadlines` | aggregated | Assignments + quizzes + calendar events, sorted by date |
| `get_upcoming_events` | `core_calendar_get_calendar_events` | Deadlines and events between dates |
| `get_grades` | `core_grades_get_grades` | Your grades for a course |
| `get_quizzes` | `mod_quiz_get_quizzes_by_courses` | Quizzes with open/close dates |
| `get_submission_status` | `mod_assign_get_submission_status` | Submission state, grade and feedback |
| `list_course_files` | `core_course_get_contents` | Downloadable files in a course |
| `download_file` | `webservice/pluginfile.php` | Fetch a file (text or base64) |
| `raw_call` | any | Escape hatch for any other web service function |

Submitting work (write operations):

| Tool | Moodle function | Purpose |
| ---- | ---- | ------- |
| `submit_assignment_text` | `mod_assign_save_submission` | Save an online-text submission |
| `submit_assignment_file` | `webservice/upload.php` + `mod_assign_save_submission` | Upload a file and save it as your submission |
| `submit_for_grading` | `mod_assign_submit_for_grading` | Hand in a saved submission |

File uploads follow the official mobile-app flow: multipart POST to `webservice/upload.php` to get a draft item id, then `mod_assign_save_submission` referencing it via `plugindata[files_filemanager]`.

## Environment variables

- `MOODLE_URL` (required): base URL of the Moodle site, no trailing slash needed
- `MOODLE_TOKEN`: web service token
- `MOODLE_USERNAME` / `MOODLE_PASSWORD`: alternative to a token; the server calls `login/token.php` once
- `MOODLE_SERVICE`: service name for login, default `moodle_mobile_app`
- `MOODLE_TIMEOUT_MS`: request timeout, default `20000`

## Tests

```bash
npm test
```

The tests run a loopback mock of the Moodle REST endpoints and exercise the full MCP stdio protocol in-process; no network access is required.
