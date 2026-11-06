import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import {
  buildRestUrl,
  loginToken,
  configFromEnv,
  startServer,
} from "../mcp-server/moodlemcp.mjs";

function startMockMoodle(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  return new Promise((resolve) => {
    server.on("listening", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function makeSession(handler, envExtra = {}) {
  const { server, port } = await startMockMoodle(handler);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let buffered = "";
  const lines = [];
  stdout.on("data", (chunk) => {
    buffered += chunk.toString();
    let index;
    while ((index = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (line) {
        lines.push(line);
        stdout.emit("line", line);
      }
    }
  });
  const config = configFromEnv({
    MOODLE_URL: `http://127.0.0.1:${port}`,
    MOODLE_TOKEN: "tok",
    ...envExtra,
  });
  startServer(config, stdin, stdout);
  let nextId = 0;
  return {
    server,
    port,
    send(message) {
      stdin.write(JSON.stringify(message) + "\n");
    },
    async call(method, params) {
      const id = ++nextId;
      this.send({ jsonrpc: "2.0", id, method, params });
      const [line] = await once(stdout, "line");
      return JSON.parse(line);
    },
    async tool(name, args) {
      return this.call("tools/call", { name, arguments: args });
    },
    async cleanup() {
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      stdin.end();
      stdout.destroy();
    },
  };
}

test("buildRestUrl assembles the Moodle REST endpoint", () => {
  const url = buildRestUrl("https://emas3.ui.ac.id", "tok123", "core_enrol_get_users_courses", {
    userid: 7,
  });
  assert.equal(
    url.toString(),
    "https://emas3.ui.ac.id/webservice/rest/server.php?wstoken=tok123&wsfunction=core_enrol_get_users_courses&moodlewsrestformat=json&userid=7",
  );
});

test("configFromEnv validates and normalises settings", () => {
  const config = configFromEnv({ MOODLE_URL: "https://emas3.ui.ac.id///", MOODLE_TOKEN: "t" });
  assert.equal(config.siteUrl, "https://emas3.ui.ac.id");
  assert.equal(config.token, "t");
  assert.throws(() => configFromEnv({}), /MOODLE_URL/);
  assert.throws(() => configFromEnv({ MOODLE_URL: "emas3.ui.ac.id" }), /http/);
});

test("loginToken returns token on success and throws on failure", async () => {
  const { server, port } = await startMockMoodle((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/login/token.php")) {
      const url = new URL(req.url, "http://x");
      if (url.searchParams.get("password") === "bad") {
        res.end(JSON.stringify({ error: "invalidlogin" }));
      } else {
        res.end(JSON.stringify({ token: "abc" }));
      }
    } else {
      res.end(JSON.stringify({}));
    }
  });
  try {
    const token = await loginToken(`http://127.0.0.1:${port}`, "u", "p", "moodle_mobile_app");
    assert.equal(token, "abc");
    await assert.rejects(
      loginToken(`http://127.0.0.1:${port}`, "u", "bad", "nope"),
      /Moodle login failed/,
    );
  } finally {
    server.close();
  }
});

test("server handles initialize, tools/list and tools/call over stdio", async () => {
  const session = await makeSession((req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url, "http://x");
    const fn = url.searchParams.get("wsfunction");
    if (fn === "core_webservice_get_site_info") {
      res.end(JSON.stringify({ sitename: "EMAS 3", userid: 42 }));
    } else if (fn === "core_enrol_get_users_courses") {
      assert.equal(url.searchParams.get("userid"), "42");
      res.end(JSON.stringify([{ id: 1, fullname: "Kalkulus" }]));
    } else {
      res.end(JSON.stringify({ exception: "invalid_response", message: "nope" }));
    }
  });
  try {
    const init = await session.call("initialize", {});
    assert.equal(init.result.serverInfo.name, "lihatdulu-moodle-mcp");
    assert.equal(init.result.protocolVersion, "2024-11-05");
    session.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const list = await session.call("tools/list", {});
    const names = list.result.tools.map((tool) => tool.name);
    for (const expected of [
      "list_courses",
      "get_assignments",
      "get_deadlines",
      "submit_assignment_file",
      "download_file",
      "raw_call",
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }

    const courses = await session.tool("list_courses", {});
    assert.equal(courses.result.isError, false);
    assert.equal(JSON.parse(courses.result.content[0].text)[0].fullname, "Kalkulus");

    const failure = await session.tool("get_quizzes", { courseid: 1 });
    assert.equal(failure.result.isError, true);
    assert.match(failure.result.content[0].text, /invalid_response/);
  } finally {
    await session.cleanup();
  }
});

test("upload, save_submission and submit_for_grading flow works end to end", async () => {
  const uploads = [];
  const session = await makeSession(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url, "http://x");
    const fn = url.searchParams.get("wsfunction");
    if (req.url.startsWith("/webservice/upload.php")) {
      const body = await new Promise((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
      });
      uploads.push(body);
      res.end(JSON.stringify([{ itemid: 555, filename: "report.pdf" }]));
    } else if (fn === "mod_assign_save_submission") {
      assert.equal(url.searchParams.get("assignmentid"), "9");
      assert.equal(url.searchParams.get("plugindata[files_filemanager]"), "555");
      res.end(JSON.stringify([]));
    } else if (fn === "mod_assign_submit_for_grading") {
      assert.equal(url.searchParams.get("assignid"), "9");
      res.end(JSON.stringify({ status: true, warnings: [] }));
    } else {
      res.end(JSON.stringify({}));
    }
  });
  try {
    session.send({ jsonrpc: "2.0", method: "initialize", params: {} });
    session.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const result = await session.tool("submit_assignment_file", {
      assignid: 9,
      filename: "report.pdf",
      file_base64: Buffer.from("hello pdf").toString("base64"),
      submit_for_grading: true,
    });
    assert.equal(result.result.isError, false);
    assert.match(uploads[0], /report\.pdf/);
  } finally {
    await session.cleanup();
  }
});

test("get_deadlines aggregates assignments, quizzes and events sorted by date", async () => {
  const session = await makeSession(
    (req, res) => {
      res.setHeader("content-type", "application/json");
      const url = new URL(req.url, "http://x");
      const fn = url.searchParams.get("wsfunction");
      if (fn === "core_webservice_get_site_info") {
        res.end(JSON.stringify({ sitename: "EMAS 3", userid: 42 }));
      } else if (fn === "core_enrol_get_users_courses") {
        res.end(JSON.stringify([{ id: 1, fullname: "Kalkulus" }]));
      } else if (fn === "mod_assign_get_assignments") {
        res.end(
          JSON.stringify({
            courses: [
              {
                id: 1,
                fullname: "Kalkulus",
                assignments: [{ id: 5, name: "HW1", duedate: 1800000300, cutoffdate: 0 }],
              },
            ],
          }),
        );
      } else if (fn === "mod_quiz_get_quizzes_by_courses") {
        res.end(
          JSON.stringify({
            quizzes: [{ id: 7, name: "Quiz 1", course: 1, timeopen: 0, timeclose: 1800000100 }],
          }),
        );
      } else if (fn === "core_calendar_get_calendar_events") {
        res.end(
          JSON.stringify({
            events: [{ id: 3, name: "Konsultasi", timestart: 1800000200, courseid: 1 }],
          }),
        );
      } else {
        res.end(JSON.stringify({}));
      }
    },
    { MOODLE_TIMEOUT_MS: "5000" },
  );
  try {
    session.send({ jsonrpc: "2.0", method: "initialize", params: {} });
    session.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const result = await session.tool("get_deadlines", {
      from: "2027-01-01",
      to: "2027-12-31",
    });
    assert.equal(result.result.isError, false);
    const payload = JSON.parse(result.result.content[0].text);
    const names = payload.deadlines.map((d) => d.name);
    assert.deepEqual(names, ["Quiz 1", "Konsultasi", "HW1"]);
  } finally {
    await session.cleanup();
  }
});

test("list_course_files and download_file return usable file data", async () => {
  const session = await makeSession((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/webservice/pluginfile.php")) {
      assert.equal(url.searchParams.get("token"), "tok");
      res.setHeader("content-type", "text/plain");
      res.end("lecture notes body");
      return;
    }
    res.setHeader("content-type", "application/json");
    const fn = url.searchParams.get("wsfunction");
    if (fn === "core_course_get_contents") {
      res.end(
        JSON.stringify([
          {
            name: "Week 1",
            modules: [
              {
                name: "Intro",
                files: [
                  {
                    filename: "notes.txt",
                    filesize: 18,
                    mimetype: "text/plain",
                    fileurl: `http://127.0.0.1:${session.port}/webservice/pluginfile.php/1/mod_page/content/0/notes.txt`,
                  },
                ],
              },
            ],
          },
        ]),
      );
    } else {
      res.end(JSON.stringify({}));
    }
  });
  try {
    session.send({ jsonrpc: "2.0", method: "initialize", params: {} });
    session.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = await session.tool("list_course_files", { courseid: 1 });
    const listPayload = JSON.parse(listed.result.content[0].text);
    assert.equal(listPayload.count, 1);
    assert.equal(listPayload.files[0].filename, "notes.txt");

    const downloaded = await session.tool("download_file", {
      fileurl: listPayload.files[0].fileurl,
    });
    const filePayload = JSON.parse(downloaded.result.content[0].text);
    assert.equal(filePayload.encoding, "utf8");
    assert.equal(filePayload.content, "lecture notes body");
  } finally {
    await session.cleanup();
  }
});

test("unknown methods get a JSON-RPC error response", async () => {
  const session = await makeSession((req, res) => res.end(JSON.stringify({})));
  try {
    const response = await session.call("bogus/method", {});
    assert.equal(response.error.code, -32601);
  } finally {
    await session.cleanup();
  }
});
