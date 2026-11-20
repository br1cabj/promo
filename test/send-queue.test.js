"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-queue-"));
const events = [];
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => body += c);
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/message/")) {
      const payload = JSON.parse(body || "{}");
      events.push({ t: Date.now(), number: payload.number, text: payload.text });
      // Un poco de latencia para que la segunda campaña llegue mientras la
      // primera todavía está enviando.
      setTimeout(() => {
        if (payload.text === "FAIL") {
          res.statusCode = 500;
          res.end('{"message":"boom"}');
        } else {
          res.end('{"ok":true}');
        }
      }, 120);
      return;
    }
    res.end('{"ok":true}');
  });
});

test("solo una campaña envía a la vez, se informa el puesto y un fallo no bloquea la cola", async (t) => {
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));

  process.env.DATA_DIR = dataDir;
  process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.PANEL_USER = "admin";
  process.env.PANEL_PASSWORD = "testpass123";
  process.env.EVOLUTION_URL = `http://127.0.0.1:${mock.address().port}`;
  process.env.EVOLUTION_API_KEY = "mockkey";
  process.env.EVOLUTION_INSTANCE = "promociones";
  process.env.SEND_DELAY_MS = "60";
  process.env.SEND_DELAY_JITTER_MS = "0";
  process.env.SEND_BATCH_SIZE = "0";
  process.env.SEND_BATCH_PAUSE_MS = "0";

  const app = require("../server");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";

  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mock.close(r));
    app.store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function api(url, opts = {}) {
    const r = await fetch(base + url, {
      ...opts,
      headers: { ...(opts.headers || {}), Cookie: cookie }
    });
    if (r.headers.get("set-cookie")) cookie = r.headers.get("set-cookie").split(";")[0];
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    assert.ok(r.ok, `${r.status} ${url}: ${text.slice(0, 300)}`);
    return json;
  }

  const login = await fetch(base + "/login", {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "user=admin&password=testpass123"
  });
  cookie = login.headers.get("set-cookie").split(";")[0];

  const contacts = [];
  for (let i = 0; i < 6; i++) {
    contacts.push(await api("/api/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Cola " + i, phone: "351123456" + i, optIn: true })
    }));
  }

  function send(text, ids, key) {
    const fd = new FormData();
    fd.append("type", "text");
    fd.append("text", text);
    fd.append("ids", JSON.stringify(ids));
    return api("/api/send", { method: "POST", body: fd, headers: { "Idempotency-Key": key } });
  }
  async function waitFor(jobId) {
    for (let i = 0; i < 100; i++) {
      const j = await api("/api/jobs/" + jobId);
      if (j.status !== "running" && j.status !== "queued") return j;
      await sleep(20);
    }
    throw new Error("el job " + jobId + " no terminó");
  }

  // La respuesta 202 llega antes de que el job termine: el segundo pedido
  // entra mientras el pump todavía está ocupado.
  const a = await send("A", contacts.slice(0, 2).map((c) => c.id), "key-a");
  const b = await send("B", contacts.slice(2, 4).map((c) => c.id), "key-b");
  assert.equal(a.queued, false, "la primera campaña debe arrancar");
  assert.equal(a.queuePosition, 0);
  assert.equal(b.queued, true, "la segunda debe quedar en cola");
  assert.equal(b.queuePosition, 1);
  assert.equal(typeof b.queueWaitMs, "number");

  const [ja, jb] = await Promise.all([waitFor(a.jobId), waitFor(b.jobId)]);
  assert.equal(ja.status, "done");
  assert.equal(ja.sent, 2);
  assert.equal(jb.status, "done");
  assert.equal(jb.sent, 2);

  const groupA = contacts.slice(0, 2).map((c) => c.phone);
  const groupB = contacts.slice(2, 4).map((c) => c.phone);
  assert.equal(events.length, 4);
  assert.ok(events.slice(0, 2).every((e) => groupA.includes(e.number)), "A debe enviar completo antes que B");
  assert.ok(events.slice(2).every((e) => groupB.includes(e.number)), "B envía después de A");
  assert.equal(events.filter((e) => e.text === "A").length, 2);
  assert.equal(events.filter((e) => e.text === "B").length, 2);

  // Un job que falla no debe dejar la cola trabada.
  events.length = 0;
  const c = await send("FAIL", contacts.slice(0, 2).map((x) => x.id), "key-c");
  const d = await send("OK", contacts.slice(4, 6).map((x) => x.id), "key-d");
  assert.equal(c.queued, false);
  assert.equal(d.queued, true);
  const [jc, jd] = await Promise.all([waitFor(c.jobId), waitFor(d.jobId)]);
  assert.equal(jc.failed, 2);
  assert.equal(jd.sent, 2, "la campaña siguiente debe enviarse aunque la anterior fallara");
  assert.equal(events.length, 4);
  assert.ok(events.slice(0, 2).every((e) => e.text === "FAIL"), "el job fallido intentó primero");
  assert.ok(events.slice(2).every((e) => e.text === "OK"), "el job siguiente envió después");

  const firstPage = await api("/api/history?limit=1");
  assert.equal(firstPage.length, 1, "el historial respeta el límite pedido");
  const fullHistory = await api("/api/history?limit=500");
  assert.equal(fullHistory.length, 8, "se registró un resultado por destinatario");
});
