#!/usr/bin/env node
import http from "node:http";
import readline from "node:readline";
import fs from "node:fs/promises";

const PROTOCOL_VERSION = "2024-11-05";

function configFromEnv(env = process.env) {
  const siteUrl = (env.MOODLE_URL || "").replace(/\/+$/, "");
  if (!siteUrl) {
    throw new Error("MOODLE_URL is required, e.g. https://emas3.ui.ac.id");
  }
  if (!/^https?:\/\//.test(siteUrl)) {
    throw new Error("MOODLE_URL must start with http:// or https://");
  }
  return {
    siteUrl,
    token: env.MOODLE_TOKEN || "",
    username: env.MOODLE_USERNAME || "",
    password: env.MOODLE_PASSWORD || "",
    service: env.MOODLE_SERVICE || "moodle_mobile_app",
    timeoutMs: Number(env.MOODLE_TIMEOUT_MS || 20000),
  };
}

async function fetchJson(url, { method = "GET", body, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    if (method === "GET") {
      response = await fetch(url, { signal: controller.signal });
    } else {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });
    }
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { parse_error: text.slice(0, 2000) };
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export function buildRestUrl(siteUrl, token, wsfunction, params = {}) {
  const url = new URL(`${siteUrl}/webservice/rest/server.php`);
  url.searchParams.set("wstoken", token);
  url.searchParams.set("wsfunction", wsfunction);
  url.searchParams.set("moodlewsrestformat", "json");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

export async function loginToken(siteUrl, username, password, service) {
  const url = new URL(`${siteUrl}/login/token.php`);
  url.searchParams.set("username", username);
  url.searchParams.set("password", password);
  url.searchParams.set("service", service);
  const payload = await fetchJson(url);
  if (payload.token) return payload.token;
  const reason = payload.error || JSON.stringify(payload);
  throw new Error(`Moodle login failed: ${reason}`);
}

async function ensureToken(config) {
  if (config.token) return config.token;
  if (config.username && config.password) {
    config.token = await loginToken(
      config.siteUrl,
      config.username,
      config.password,
      config.service,
    );
    return config.token;
  }
  throw new Error("Provide MOODLE_TOKEN, or MOODLE_USERNAME and MOODLE_PASSWORD to fetch one");
}

async function callMoodle(config, wsfunction, params = {}) {
  const token = await ensureToken(config);
  const url = buildRestUrl(config.siteUrl, token, wsfunction, params);
  const payload = await fetchJson(url, { timeoutMs: config.timeoutMs });
  if (payload && payload.exception) {
    throw new Error(`Moodle error (${payload.exception}): ${payload.message || "unknown"}`);
  }
  return payload;
}

async function getUserId(config) {
  const info = await callMoodle(config, "core_webservice_get_site_info");
  if (!info || !info.userid) {
    throw new Error("Could not determine user id from core_webservice_get_site_info");
  }
  return info.userid;
}

export async function uploadDraftFile(config, filename, contentBuffer) {
  const token = await ensureToken(config);
  const form = new FormData();
  form.append("filearea", "draft");
  form.append("itemid", "0");
  form.append("filepath", "/");
  form.append("filename", filename);
  form.append("file", new Blob([contentBuffer]), filename);
  const url = `${config.siteUrl}/webservice/upload.php?token=${encodeURIComponent(token)}&itemid=0`;
  const response = await fetch(url, { method: "POST", body: form });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { parse_error: text.slice(0, 2000) };
  }
  if (Array.isArray(payload) && payload[0] && payload[0].itemid) {
    return payload[0];
  }
  throw new Error(`Moodle file upload failed: ${JSON.stringify(payload).slice(0, 500)}`);
}

const TEXTUAL_MIME = /^(text\/|application\/json|application\/xml|application\/javascript)/;

export async function downloadFile(config, fileurl, { asBase64 = false } = {}) {
  const token = await ensureToken(config);
  const url = new URL(fileurl);
  url.searchParams.set("token", token);
  url.searchParams.set("forcedownload", "1");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Moodle file download failed: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const mimetype = (response.headers.get("content-type") || "").split(";")[0];
  const result = {
    filename: decodeURIComponent(url.pathname.split("/").pop() || "file"),
    size: buffer.length,
    mimetype,
  };
  const asText = !asBase64 && buffer.length <= 262144 && TEXTUAL_MIME.test(mimetype);
  if (asText) {
    result.content = buffer.toString("utf8");
    result.encoding = "utf8";
  } else {
    result.base64 = buffer.toString("base64");
    result.encoding = "base64";
  }
  return result;
}

async function saveSubmission(config, assignid, plugindata) {
  const params = { assignmentid: assignid };
  for (const [key, value] of Object.entries(plugindata)) {
    params[`plugindata[${key}]`] = value;
  }
  return callMoodle(config, "mod_assign_save_submission", params);
}

async function submitForGrading(config, assignid) {
  return callMoodle(config, "mod_assign_submit_for_grading", { assignid, nomatch: false });
}

async function getDeadlines(config, args) {
  const from = Math.floor(Date.parse(args.from || Date.now()) / 1000);
  const to = Math.floor(Date.parse(args.to || Date.now() + 60 * 864e5) / 1000);
  const courses = await callMoodle(config, "core_enrol_get_users_courses", {
    userid: await getUserId(config),
  });
  const courseids = (courses || []).map((course) => course.id);

  const assignmentsPayload = await callMoodle(config, "mod_assign_get_assignments", {});
  const assignments = [];
  for (const course of assignmentsPayload.courses || []) {
    for (const assignment of course.assignments || []) {
      assignments.push({
        type: "assignment",
        id: assignment.id,
        course: course.fullname,
        courseid: course.id,
        name: assignment.name,
        duedate: assignment.duedate,
        cutoffdate: assignment.cutoffdate,
      });
    }
  }

  let quizzes = [];
  if (courseids.length) {
    const quizzesPayload = await callMoodle(config, "mod_quiz_get_quizzes_by_courses", {
      courseids: courseids,
    });
    quizzes = (quizzesPayload.quizzes || []).map((quiz) => ({
      type: "quiz",
      id: quiz.id,
      course: quiz.course,
      courseid: quiz.coursemodule ? quiz.course : quiz.course,
      name: quiz.name,
      timeopen: quiz.timeopen,
      timeclose: quiz.timeclose,
      duedate: quiz.timeclose,
    }));
  }

  const eventsPayload = await callMoodle(config, "core_calendar_get_calendar_events", {
    events: {},
    options: { timestart: from, timeend: to, ignorehidden: false },
  });
  const events = (eventsPayload.events || []).map((event) => ({
    type: "event",
    id: event.id,
    name: event.name,
    timestart: event.timestart,
    courseid: event.courseid,
    duedate: event.timestart,
  }));

  const all = [...assignments, ...quizzes, ...events]
    .filter((item) => item.duedate && item.duedate >= from && item.duedate <= to)
    .sort((a, b) => a.duedate - b.duedate);
  return { window: { from, to }, deadlines: all };
}

const TOOLS = [
  {
    name: "get_site_info",
    description: "Fetch Moodle site info (sitename, version, user id, available functions).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_courses",
    description: "List the courses the current user is enrolled in.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_course_contents",
    description: "List sections and activities (modules) of a course.",
    inputSchema: {
      type: "object",
      properties: { courseid: { type: "integer", description: "Moodle course id" } },
      required: ["courseid"],
      additionalProperties: false,
    },
  },
  {
    name: "get_assignments",
    description: "List assignments across the user's courses, with due dates and submission status.",
    inputSchema: {
      type: "object",
      properties: { courseid: { type: "integer", description: "Optional course id filter" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_upcoming_events",
    description: "Get calendar events (deadlines, quizzes) between two ISO dates.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "ISO date, e.g. 2026-01-01" },
        to: { type: "string", description: "ISO date, e.g. 2026-12-31" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_grades",
    description: "Get the user's grades for a course (grade items and grades).",
    inputSchema: {
      type: "object",
      properties: { courseid: { type: "integer", description: "Moodle course id" } },
      required: ["courseid"],
      additionalProperties: false,
    },
  },
  {
    name: "get_quizzes",
    description: "List quizzes for a course with open/close dates.",
    inputSchema: {
      type: "object",
      properties: { courseid: { type: "integer", description: "Moodle course id" } },
      required: ["courseid"],
      additionalProperties: false,
    },
  },
  {
    name: "get_deadlines",
    description:
      "Aggregate upcoming deadlines: assignment due dates, quiz open/close dates and calendar events, sorted by date.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "ISO date lower bound, default now" },
        to: { type: "string", description: "ISO date upper bound, default +60 days" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_submission_status",
    description: "Get your current submission status, grade and feedback for an assignment.",
    inputSchema: {
      type: "object",
      properties: { assignid: { type: "integer", description: "Assignment (assign module) id" } },
      required: ["assignid"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_assignment_text",
    description: "Save an online-text submission for an assignment. Write operation.",
    inputSchema: {
      type: "object",
      properties: {
        assignid: { type: "integer", description: "Assignment (assign module) id" },
        text: { type: "string", description: "Submission text (HTML allowed)" },
        submit_for_grading: { type: "boolean", description: "Also submit for grading, default false" },
      },
      required: ["assignid", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_assignment_file",
    description:
      "Upload a file and save it as the submission for an assignment. Write operation. Provide either file_path or file_base64.",
    inputSchema: {
      type: "object",
      properties: {
        assignid: { type: "integer", description: "Assignment (assign module) id" },
        filename: { type: "string", description: "Name Moodle should store, e.g. report.pdf" },
        file_path: { type: "string", description: "Local path of the file to upload" },
        file_base64: { type: "string", description: "Base64 content of the file (alternative to file_path)" },
        submit_for_grading: { type: "boolean", description: "Also submit for grading, default false" },
      },
      required: ["assignid", "filename"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_for_grading",
    description: "Mark a saved assignment submission as submitted for grading. Write operation.",
    inputSchema: {
      type: "object",
      properties: { assignid: { type: "integer", description: "Assignment (assign module) id" } },
      required: ["assignid"],
      additionalProperties: false,
    },
  },
  {
    name: "list_course_files",
    description: "List downloadable files (lectures, materials) available in a course.",
    inputSchema: {
      type: "object",
      properties: { courseid: { type: "integer", description: "Moodle course id" } },
      required: ["courseid"],
      additionalProperties: false,
    },
  },
  {
    name: "download_file",
    description:
      "Download a file from a Moodle file URL (as returned by course contents or submission status). Text files come back as text, binaries as base64.",
    inputSchema: {
      type: "object",
      properties: {
        fileurl: { type: "string", description: "Moodle file URL (webservice/pluginfile.php...)" },
        as_base64: { type: "boolean", description: "Force base64 output, default false" },
      },
      required: ["fileurl"],
      additionalProperties: false,
    },
  },
  {
    name: "raw_call",
    description:
      "Call an arbitrary Moodle web service function. Use for anything not covered by the other tools.",
    inputSchema: {
      type: "object",
      properties: {
        wsfunction: { type: "string", description: "Moodle ws function name, e.g. mod_forum_get_forums" },
        params: { type: "object", description: "Query parameters for the function" },
      },
      required: ["wsfunction"],
      additionalProperties: false,
    },
  },
];

async function dispatch(config, name, args) {
  switch (name) {
    case "get_site_info":
      return callMoodle(config, "core_webservice_get_site_info");
    case "list_courses": {
      const userid = await getUserId(config);
      return callMoodle(config, "core_enrol_get_users_courses", { userid });
    }
    case "get_course_contents":
      return callMoodle(config, "core_course_get_contents", { courseid: args.courseid });
    case "get_assignments": {
      const params = {};
      if (args.courseid) params.courseids = [args.courseid];
      return callMoodle(config, "mod_assign_get_assignments", params);
    }
    case "get_upcoming_events": {
      const payload = await callMoodle(config, "core_calendar_get_calendar_events", {
        events: {},
        options: {
          timestart: Math.floor(Date.parse(args.from || Date.now()) / 1000),
          timeend: Math.floor(Date.parse(args.to || Date.now() + 60 * 864e5) / 1000),
          ignorehidden: false,
        },
        ...args,
      });
      return payload;
    }
    case "get_grades": {
      const userid = await getUserId(config);
      return callMoodle(config, "core_grades_get_grades", {
        courseid: args.courseid,
        userid,
      });
    }
    case "get_quizzes":
      return callMoodle(config, "mod_quiz_get_quizzes_by_courses", {
        courseids: [args.courseid],
      });
    case "get_deadlines":
      return getDeadlines(config, args);
    case "get_submission_status":
      return callMoodle(config, "mod_assign_get_submission_status", {
        assignid: args.assignid,
      });
    case "submit_assignment_text": {
      const result = await saveSubmission(config, args.assignid, {
        "onlinetext_editor[text]": args.text,
        "onlinetext_editor[format]": 1,
        "onlinetext_editor[itemid]": 0,
      });
      if (args.submit_for_grading) {
        await submitForGrading(config, args.assignid);
      }
      return result;
    }
    case "submit_assignment_file": {
      let buffer;
      if (args.file_path) {
        buffer = await fs.readFile(args.file_path);
      } else if (args.file_base64) {
        buffer = Buffer.from(args.file_base64, "base64");
      } else {
        throw new Error("Provide file_path or file_base64");
      }
      const draft = await uploadDraftFile(config, args.filename, buffer);
      const result = await saveSubmission(config, args.assignid, {
        files_filemanager: draft.itemid,
      });
      if (args.submit_for_grading) {
        await submitForGrading(config, args.assignid);
      }
      return result;
    }
    case "submit_for_grading":
      return submitForGrading(config, args.assignid);
    case "list_course_files": {
      const contents = await callMoodle(config, "core_course_get_contents", {
        courseid: args.courseid,
      });
      const files = [];
      for (const section of contents || []) {
        for (const module of section.modules || []) {
          for (const file of module.files || []) {
            if (file.fileurl) {
              files.push({
                filename: file.filename,
                filesize: file.filesize,
                mimetype: file.mimetype,
                section: section.name,
                module: module.name,
                fileurl: file.fileurl,
              });
            }
          }
        }
      }
      return { courseid: args.courseid, count: files.length, files };
    }
    case "download_file":
      return downloadFile(config, args.fileurl, { asBase64: !!args.as_base64 });
    case "raw_call":
      return callMoodle(config, args.wsfunction, args.params || {});
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function makeServer(config, log = () => {}, out = process.stdout) {
  let requestSeq = 0;
  const pending = new Map();

  function respond(id, result) {
    const message = { jsonrpc: "2.0", id, result };
    log("out", message);
    out.write(JSON.stringify(message) + "\n");
  }

  function respondError(id, code, errorMessage) {
    const message = { jsonrpc: "2.0", id, error: { code, message: errorMessage } };
    log("out", message);
    out.write(JSON.stringify(message) + "\n");
  }

  async function handle(message) {
    const { id, method, params } = message;
    switch (method) {
      case "initialize":
        return {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: "lihatdulu-moodle-mcp", version: "1.0.0" },
          capabilities: { tools: {} },
        };
      case "notifications/initialized":
        return null;
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call": {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        try {
          const data = await dispatch(config, name, args);
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            isError: false,
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: String(error && error.message ? error.message : error) }],
            isError: true,
          };
        }
      }
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  return {
    async handleLine(line) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!message || !message.method) return;
      const isNotification = message.id === undefined || message.id === null;
      try {
        const result = await handle(message);
        if (!isNotification && result !== null) respond(message.id, result);
        else if (!isNotification && result === null) respond(message.id, {});
      } catch (error) {
        if (!isNotification) {
          respondError(message.id, error.code || -32603, String(error.message || error));
        }
      }
    },
    _pending: pending,
    _seq: () => ++requestSeq,
  };
}

export function startServer(config, stdin = process.stdin, stdout = process.stdout, log = () => {}) {
  const rl = readline.createInterface({ input: stdin });
  const server = makeServer(config, log, stdout);
  rl.on("line", (line) => {
    if (line.trim()) server.handleLine(line);
  });
  return server;
}

export { TOOLS, dispatch, callMoodle, configFromEnv, fetchJson, makeServer };

if (import.meta.url === `file://${process.argv[1]}`) {
  let config;
  try {
    config = configFromEnv();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  startServer(config);
}
