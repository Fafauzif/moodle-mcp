"""Moodle LMS endpoints: one HTTP operation per MCP tool the connector will expose.

Read operations cover courses, assignments, deadlines, grades, quizzes, submission status and
files; write operations submit assignment work. Every operation calls the Moodle Web Services
REST API through :mod:`api.moodle`. Responses are wrapped in concrete models so the OpenAPI
spec — which a Studio HTTP connector imports — stays fully typed.
"""

from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from api import moodle

router = APIRouter(tags=["moodle"])


class MoodleResponse(BaseModel):
    """A Moodle object payload, passed through with unknown fields kept."""

    model_config = ConfigDict(extra="allow")


class MoodleListResponse(BaseModel):
    """A Moodle array payload wrapped under ``items`` to keep the spec typed."""

    items: list[MoodleResponse] = Field(default_factory=list)


class CourseFilesResponse(BaseModel):
    courseid: int
    count: int
    files: list[MoodleResponse] = Field(default_factory=list)


class DeadlineWindow(BaseModel):
    from_: int = Field(alias="from", ge=0)
    to: int = Field(ge=0)

    model_config = ConfigDict(populate_by_name=True)


class DeadlinesResponse(BaseModel):
    window: DeadlineWindow
    deadlines: list[MoodleResponse] = Field(default_factory=list)


class FileResponse(BaseModel):
    filename: str
    size: int = Field(ge=0)
    mimetype: str
    encoding: str
    content: str | None = None
    base64: str | None = None


class SubmissionTextBody(BaseModel):
    text: str = Field(description="Submission text (HTML allowed)")
    submit_for_grading: bool = Field(default=False, description="Also hand in for grading")


class SubmissionFileBody(BaseModel):
    filename: str = Field(description="Name Moodle should store, e.g. report.pdf")
    file_base64: str = Field(description="Base64 content of the file")
    submit_for_grading: bool = Field(default=False, description="Also hand in for grading")


class RawCallBody(BaseModel):
    wsfunction: str = Field(description="Moodle ws function name, e.g. mod_forum_get_forums")
    params: dict[str, Any] = Field(default_factory=dict, description="Function parameters")


CourseId = Annotated[int, Field(description="Moodle course id", ge=1)]
AssignId = Annotated[int, Field(description="Assignment (assign module) id", ge=1)]
IsoDate = Annotated[str | None, Field(description="ISO date bound, e.g. 2026-12-31", default=None)]


def _unix_seconds(value: str | None, fallback: datetime) -> int:
    if value is None or not value.strip():
        return int(fallback.timestamp())
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as error:
        raise moodle.MoodleError(f"Invalid ISO date: {value}") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return int(parsed.timestamp())


async def _deadlines(from_iso: str | None, to_iso: str | None) -> DeadlinesResponse:
    start = _unix_seconds(from_iso, datetime.now(UTC))
    end = _unix_seconds(to_iso, datetime.now(UTC) + timedelta(days=60))
    course_ids = await moodle.get_course_ids()

    assignments_payload = await moodle.call("mod_assign_get_assignments")
    assignments = [
        {
            "type": "assignment",
            "id": assignment["id"],
            "courseid": course["id"],
            "name": assignment["name"],
            "duedate": assignment["duedate"],
            "cutoffdate": assignment["cutoffdate"],
        }
        for course in assignments_payload.get("courses", [])
        for assignment in course.get("assignments", [])
    ]

    quizzes: list[dict[str, Any]] = []
    if course_ids:
        quizzes_payload = await moodle.call("mod_quiz_get_quizzes_by_courses", {"courseids": course_ids})
        quizzes = [
            {
                "type": "quiz",
                "id": quiz["id"],
                "courseid": quiz["course"],
                "name": quiz["name"],
                "timeopen": quiz["timeopen"],
                "timeclose": quiz["timeclose"],
                "duedate": quiz["timeclose"],
            }
            for quiz in quizzes_payload.get("quizzes", [])
        ]

    events_payload = await moodle.call(
        "core_calendar_get_calendar_events",
        {
            "events": {"courseids": course_ids or [0]},
            "options": {"timestart": start, "timeend": end, "ignorehidden": False},
        },
    )
    events = [
        {
            "type": "event",
            "id": event["id"],
            "courseid": event.get("courseid"),
            "name": event["name"],
            "timestart": event["timestart"],
            "duedate": event["timestart"],
        }
        for event in events_payload.get("events", [])
    ]

    deadlines = sorted(
        (item for item in [*assignments, *quizzes, *events] if item["duedate"] and start <= item["duedate"] <= end),
        key=lambda item: item["duedate"],
    )
    return DeadlinesResponse(
        window=DeadlineWindow(from_=start, to=end),
        deadlines=[MoodleResponse.model_validate(item) for item in deadlines],
    )


@router.get("/site-info")
async def site_info() -> MoodleResponse:
    """Moodle site info: sitename, version, user id, and the functions this token may call."""
    return MoodleResponse.model_validate(await moodle.call("core_webservice_get_site_info"))


@router.get("/courses")
async def courses() -> MoodleListResponse:
    """The courses the current user is enrolled in."""
    payload = await moodle.call("core_enrol_get_users_courses", {"userid": await moodle.get_user_id()})
    return MoodleListResponse(items=[MoodleResponse.model_validate(course) for course in payload])


@router.get("/courses/{courseid}/contents")
async def course_contents(courseid: CourseId) -> MoodleListResponse:
    """Sections and activities of one course."""
    payload = await moodle.call("core_course_get_contents", {"courseid": courseid})
    return MoodleListResponse(items=[MoodleResponse.model_validate(section) for section in payload])


@router.get("/courses/{courseid}/files")
async def course_files(courseid: CourseId) -> CourseFilesResponse:
    """Downloadable files (lectures, materials) in one course."""
    contents = await moodle.call("core_course_get_contents", {"courseid": courseid})
    files = [
        MoodleResponse.model_validate(
            {
                "filename": file["filename"],
                "filesize": file.get("filesize"),
                "mimetype": file.get("mimetype"),
                "section": section["name"],
                "module": module["name"],
                "fileurl": file["fileurl"],
            }
        )
        for section in contents
        for module in section.get("modules", [])
        for file in module.get("files", [])
        if file.get("fileurl")
    ]
    return CourseFilesResponse(courseid=courseid, count=len(files), files=files)


@router.get("/courses/{courseid}/grades")
async def course_grades(courseid: CourseId) -> MoodleResponse:
    """The user's grades for one course."""
    payload = await moodle.call(
        "core_grades_get_grades",
        {"courseid": courseid, "userid": await moodle.get_user_id()},
    )
    return MoodleResponse.model_validate(payload)


@router.get("/courses/{courseid}/quizzes")
async def course_quizzes(courseid: CourseId) -> MoodleResponse:
    """Quizzes in one course, with open and close dates."""
    payload = await moodle.call("mod_quiz_get_quizzes_by_courses", {"courseids": [courseid]})
    return MoodleResponse.model_validate(payload)


@router.get("/assignments")
async def assignments(courseid: int | None = None) -> MoodleResponse:
    """Assignments across the user's courses, with due dates."""
    params: dict[str, Any] = {}
    if courseid is not None:
        params["courseids"] = [courseid]
    payload = await moodle.call("mod_assign_get_assignments", params)
    return MoodleResponse.model_validate(payload)


@router.get("/assignments/{assignid}/submission-status")
async def submission_status(assignid: AssignId) -> MoodleResponse:
    """Submission state, grade and feedback for one assignment."""
    payload = await moodle.call("mod_assign_get_submission_status", {"assignid": assignid})
    return MoodleResponse.model_validate(payload)


@router.get("/deadlines")
async def deadlines(from_date: IsoDate = None, to_date: IsoDate = None) -> DeadlinesResponse:
    """Upcoming deadlines: assignment due dates, quizzes and calendar events, sorted by date."""
    return await _deadlines(from_date, to_date)


@router.get("/events")
async def events(from_date: IsoDate = None, to_date: IsoDate = None) -> MoodleResponse:
    """Calendar events between two dates."""
    start = _unix_seconds(from_date, datetime.now(UTC))
    end = _unix_seconds(to_date, datetime.now(UTC) + timedelta(days=60))
    course_ids = await moodle.get_course_ids()
    payload = await moodle.call(
        "core_calendar_get_calendar_events",
        {
            "events": {"courseids": course_ids or [0]},
            "options": {"timestart": start, "timeend": end, "ignorehidden": False},
        },
    )
    return MoodleResponse.model_validate(payload)


@router.get("/file")
async def file(
    fileurl: Annotated[str, Field(description="Moodle file URL from course contents or submission status")],
    as_base64: bool = False,
) -> FileResponse:
    """Download one Moodle file: text files as text, anything else as base64."""
    return FileResponse.model_validate(await moodle.download_file(fileurl, as_base64=as_base64))


@router.post("/assignments/{assignid}/submit-text")
async def submit_text(assignid: AssignId, body: SubmissionTextBody) -> MoodleResponse:
    """Save an online-text submission for an assignment."""
    result = await moodle.call(
        "mod_assign_save_submission",
        {
            "assignmentid": assignid,
            "plugindata": {
                "onlinetext_editor[text]": body.text,
                "onlinetext_editor[format]": 1,
                "onlinetext_editor[itemid]": 0,
            },
        },
    )
    if body.submit_for_grading:
        await moodle.call("mod_assign_submit_for_grading", {"assignid": assignid, "nomatch": False})
    return MoodleResponse.model_validate({"result": result} if isinstance(result, list) else result)


@router.post("/assignments/{assignid}/submit-file")
async def submit_file(assignid: AssignId, body: SubmissionFileBody) -> MoodleResponse:
    """Upload a file and save it as the submission for an assignment."""
    content = moodle.decode_base64(body.file_base64)
    draft_id = await moodle.upload_draft_file(body.filename, content)
    result = await moodle.call(
        "mod_assign_save_submission",
        {"assignmentid": assignid, "plugindata": {"files_filemanager": draft_id}},
    )
    if body.submit_for_grading:
        await moodle.call("mod_assign_submit_for_grading", {"assignid": assignid, "nomatch": False})
    return MoodleResponse.model_validate({"result": result} if isinstance(result, list) else result)


@router.post("/assignments/{assignid}/submit-for-grading")
async def submit_for_grading(assignid: AssignId) -> MoodleResponse:
    """Hand in a saved assignment submission for grading."""
    payload = await moodle.call("mod_assign_submit_for_grading", {"assignid": assignid, "nomatch": False})
    return MoodleResponse.model_validate({"result": payload} if isinstance(payload, list) else payload)


@router.post("/raw")
async def raw_call(body: RawCallBody) -> MoodleResponse:
    """Call any other Moodle web-service function directly."""
    payload = await moodle.call(body.wsfunction, body.params)
    return MoodleResponse.model_validate({"result": payload} if isinstance(payload, list) else payload)
