"use strict";
// Integración HTTP real contra un Evolution simulado: rutas que antes solo se
// comprobaban con búsquedas de texto en el código.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(16)]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setupEnv({ dataDir, evoUrl, extra = {} }) {
  Object.assign(process.env, {
    DATA_DIR: dataDir,
    ENCRYPTION_KEY: KEY,
    PANEL_USER: "admin",
    PANEL_PASSWORD: "testpass123",
    TRUST_PROXY: "false",
    EVOLUTION_URL: evoUrl,
    EVOLUTION_API_KEY: "mockkey",
    EVOLUTION_INSTANCE: "promociones",
    SEND_DELAY_MS: "20",
    SEND_DELAY_JITTER_MS: "0",
    SEND_BATCH_SIZE: "0",
    SEND_BATCH_PAUSE_MS: "0",
    ...extra
  });
}

function mockEvolution() {
  const state = { instanceExists: true, networkDown: false, sent: [], statuses: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (state.networkDown && req.url.startsWith("/message/")) { req.socket.destroy(); return; }
      res.setHeader("Content-Type", "application/json");
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch {}
      if (req.url.startsWith("/instance/connectionState/")) return res.end('{"instance":{"state":"open"}}');
      if (req.url.startsWith("/instance/fetchInstances")) {
        return res.end('[{"instanceName":"promociones","owner":"5493511234567","profileName":"Tienda"}]');
      }
      if (req.url.startsWith("/instance/connect/")) {
        if (!state.instanceExists) { res.statusCode = 404; return res.end('{"message":"Instance not found"}'); }
        return res.end(req.url.includes("number=")
          ? '{"code":"12345678"}'
          : '{"base64":"aGVsbG8="}');
      }
      if (req.url.startsWith("/instance/create")) {
        state.instanceExists = true;
        return res.end('{"base64":"aGVsbG8="}');
      }
      if (req.url.startsWith("/message/sendText/")) {
        state.sent.push(payload.text);
        return res.end('{"ok":true}');
      }
      if (req.url.startsWith("/message/sendStatus/")) {
        state.statuses.push(payload);
        return res.end('{"ok":true}');
      }
      res.end("{}");
    });
  });
  return { server, state };
}

async function startApp() {
  const app = require("../server");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { app, server, base };
}

async function login(base) {
  const r = await fetch(base + "/login", {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "user=admin&password=testpass123"
  });
  assert.equal(r.status, 302);
  return r.headers.get("set-cookie").split(";")[0];
}

function client(base, cookie) {
  return async (url, options = {}) => {
    const r = await fetch(base + url, {
      ...options,
      headers: { ...(options.headers || {}), Cookie: cookie }
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json };
  };
}

function formData(fields, files = []) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  files.forEach((f) => fd.append(f.name, new Blob([f.buffer], { type: f.mime }), f.file));
  return fd;
}

test("rutas HTTP: health, auth, CSRF, CSV, estados, connect, idempotencia y streaming", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-api-"));
  const { server: evo, state } = mockEvolution();
  await new Promise((r) => evo.listen(0, "127.0.0.1", r));
  setupEnv({ dataDir, evoUrl: `http://127.0.0.1:${evo.address().port}`, extra: { MAX_TOTAL_UPLOAD_MB: "1", SEND_DELAY_MS: "150" } });
  const { app, server, base } = await startApp();
  const cookie = await login(base);
  const api = client(base, cookie);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => evo.close(r));
    app.store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await t.test("health informa versión y estado de la base", async () => {
    const r = await fetch(base + "/health");
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, "ok");
    assert.equal(body.dbOk, true);
    assert.match(body.version, /^\d+\.\d+\.\d+$/);
  });

  await t.test("sin sesión no se accede a la API", async () => {
    const r = await fetch(base + "/api/contacts");
    assert.equal(r.status, 401);
  });

  await t.test("credenciales incorrectas muestran el error en la pantalla de ingreso", async () => {
    const r = await fetch(base + "/login", {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "user=admin&password=incorrecta"
    });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/login?error=1");
    const page = await (await fetch(base + r.headers.get("location"))).text();
    assert.match(page, /Usuario o contraseña incorrectos/);
    assert.doesNotMatch(page, /✦/, "la pantalla usa la marca local, no un glifo suelto");
    assert.match(page, /favicon\.svg/);
    assert.match(page, /viewport-fit=cover/);
  });

  await t.test("el guard CSRF cubre también el formulario de ingreso", async () => {
    const r = await fetch(base + "/login", {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://malicioso.test" },
      body: "user=admin&password=incorrecta"
    });
    assert.equal(r.status, 403);
    assert.match(r.headers.get("content-type"), /text\/html/);
    assert.match(await r.text(), /No se pudo validar el origen/);
  });

  await t.test("sin trust proxy, X-Forwarded-Proto no activa Secure ni HSTS", async () => {
    const r = await fetch(base + "/login", {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-Proto": "https" },
      body: "user=admin&password=testpass123"
    });
    assert.equal(r.status, 302);
    const setCookie = r.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/);
    assert.doesNotMatch(setCookie, /;\s*Secure/);
    assert.equal(r.headers.get("strict-transport-security"), null);
  });

  await t.test("logout destruye la sesión", async () => {
    const login = await fetch(base + "/login", {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "user=admin&password=testpass123"
    });
    const freshCookie = login.headers.get("set-cookie").split(";")[0];
    const out = await fetch(base + "/logout", { method: "POST", redirect: "manual", headers: { Cookie: freshCookie } });
    assert.equal(out.status, 302);
    assert.equal(out.headers.get("location"), "/login");
    assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
    const after = await fetch(base + "/api/contacts", { headers: { Cookie: freshCookie } });
    assert.equal(after.status, 401);
  });

  await t.test("un Origin ajeno se rechaza con 403", async () => {
    const r = await fetch(base + "/api/contacts", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: "http://malicioso.test" },
      body: JSON.stringify({ name: "X", phone: "3511111111", optIn: true })
    });
    assert.equal(r.status, 403);
  });

  await t.test("el limitador de login corta los intentos repetidos", async () => {
    let last;
    for (let i = 0; i < 11; i++) {
      last = await fetch(base + "/login", {
        method: "POST", redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "user=admin&password=incorrecta"
      });
    }
    assert.equal(last.status, 429);
    assert.match(last.headers.get("content-type"), /text\/html/, "sigue siendo la pantalla de ingreso");
    assert.match(await last.text(), /Demasiados intentos de acceso/);
  });

  let contact;
  await t.test("CSV importa contactos y detecta duplicados", async () => {
    const csv = "nombre,telefono,dni,optin\nAna,3516123456,30123456,si\nAna otra,3516123456,30123456,si\n";
    const r = await api("/api/import", { method: "POST", body: formData({}, [{ name: "file", buffer: Buffer.from(csv), mime: "text/csv", file: "a.csv" }]) });
    assert.equal(r.status, 200);
    assert.equal(r.body.added, 1);
    assert.equal(r.body.duplicates, 1);
    const list = await api("/api/contacts");
    contact = list.body[0];
    assert.equal(contact.name, "Ana");
    assert.equal(contact.optIn, true);
  });

  await t.test("estado de texto y de imagen llegan a Evolution y al historial", async () => {
    const text = await api("/api/status", { method: "POST", body: formData({ type: "text", text: "Novedad" }) });
    assert.equal(text.status, 200);
    assert.equal(text.body.ok, true);
    const image = await api("/api/status", {
      method: "POST",
      body: formData({ type: "image", text: "Pie" }, [{ name: "file", buffer: PNG, mime: "image/png", file: "a.png" }])
    });
    assert.equal(image.status, 200);
    assert.equal(state.statuses.length, 2);
    assert.equal(state.statuses[0].content, "Novedad");
    assert.match(state.statuses[1].content, /^data:image\/png;base64,/);
    const history = await api("/api/history?limit=10");
    assert.equal(history.body.length, 2, "cada estado se registra una sola vez");
  });

  await t.test("connect no crea la instancia sin confirmación", async () => {
    state.instanceExists = false;
    const first = await api("/api/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{}' });
    assert.equal(first.status, 200);
    assert.equal(first.body.needsCreate, true);
    const second = await api("/api/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"create":true}' });
    assert.equal(second.status, 200);
    assert.ok(second.body.qr, "devuelve una data URI del QR");
    assert.ok(!second.body.needsCreate);
  });

  await t.test("idempotencia reutiliza el job ante un reintento", async () => {
    const key = "clave-estable";
    const body = () => formData({ type: "text", text: "Hola", ids: JSON.stringify([contact.id]) });
    const first = await api("/api/send", { method: "POST", body: body(), headers: { "Idempotency-Key": key } });
    const second = await api("/api/send", { method: "POST", body: body(), headers: { "Idempotency-Key": key } });
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(second.body.jobId, first.body.jobId);
    assert.equal(second.body.reused, true);
    for (let i = 0; i < 50; i++) {
      const j = await api("/api/jobs/" + first.body.jobId);
      if (j.body.status === "done") break;
      await sleep(20);
    }
    assert.equal(state.sent.filter((x) => x === "Hola").length, 1, "el reintento no duplica el mensaje");
  });

  await t.test("el total de archivos se corta durante el streaming", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(700 * 1024)]);
    const r = await api("/api/send", {
      method: "POST",
      body: formData(
        { type: "image", text: "Promo", ids: JSON.stringify([contact.id]) },
        [
          { name: "files", buffer: big, mime: "image/png", file: "a.png" },
          { name: "files", buffer: big, mime: "image/png", file: "b.png" }
        ]
      )
    });
    assert.equal(r.status, 413);
    assert.match(r.body.error, /total de archivos/i);
  });

  await t.test("la cola tiene un tope y devuelve 429", async () => {
    const before = state.sent.length;
    const ids = [contact.id];
    for (let i = 0; i < 2; i++) {
      const r = await api("/api/contacts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Cola " + i, phone: "351700000" + i, optIn: true })
      });
      ids.push(r.body.id);
    }
    const jobs = [];
    for (let i = 0; i < 4; i++) {
      const r = await api("/api/send", {
        method: "POST",
        headers: { "Idempotency-Key": "cola-" + i },
        body: formData({ type: "text", text: "Cola " + i, ids: JSON.stringify(ids) })
      });
      jobs.push(r);
    }
    assert.equal(jobs[3].status, 429, "el cuarto envío encuentra la cola llena");
    assert.match(jobs[3].body.error, /envíos en curso o en cola/i);
    assert.equal(state.sent.length - before, 1, "solo el primero arrancó");
  });
});

test("varios fallos de red seguidos cortan la campaña y dejan historial real", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-net-"));
  const { server: evo, state } = mockEvolution();
  await new Promise((r) => evo.listen(0, "127.0.0.1", r));
  setupEnv({ dataDir, evoUrl: `http://127.0.0.1:${evo.address().port}` });
  delete require.cache[require.resolve("../server")];
  const { app, server, base } = await startApp();
  const cookie = await login(base);
  const api = client(base, cookie);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => evo.close(r));
    app.store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const contacts = [];
  for (let i = 0; i < 6; i++) {
    const r = await api("/api/contacts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Red " + i, phone: "351600000" + i, optIn: true })
    });
    contacts.push(r.body);
  }
  state.networkDown = true;
  const started = await api("/api/send", {
    method: "POST",
    body: formData({ type: "text", text: "Falla", ids: JSON.stringify(contacts.map((c) => c.id)) })
  });
  assert.equal(started.status, 202);
  let job;
  for (let i = 0; i < 100; i++) {
    const r = await api("/api/jobs/" + started.body.jobId);
    if (r.body.status !== "running" && r.body.status !== "queued") { job = r.body; break; }
    await sleep(20);
  }
  assert.equal(job.status, "error");
  assert.equal(job.processed, 3, "se detiene tras 3 fallos de red consecutivos");
  assert.equal(job.failed, 3);
  assert.match(job.error, /Evolution API tras 3 intentos/i);
  const history = await api("/api/history?limit=50");
  assert.equal(history.body.length, 3, "solo se registran los contactos efectivamente intentados");
});
