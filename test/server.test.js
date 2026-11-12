const { test, before, after } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// Configurar el entorno ANTES de cargar el servidor.
const dataDir = path.join(os.tmpdir(), `promopanel-test-${process.pid}-${Date.now()}`);
process.env.DATA_DIR = dataDir;
process.env.PANEL_USER = "admin";
process.env.PANEL_PASSWORD = "secret";
process.env.EVOLUTION_URL = "";
process.env.EVOLUTION_API_KEY = "";
process.env.EVOLUTION_INSTANCE = "";
process.env.TRUST_PROXY = "false";

const app = require("../server");

let server;
let base;
let cookie;
let contactId;

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  app.store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("GET /health responde sin autenticación", async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, "ok");
  assert.equal(body.configured, false);
});

test("la API rechaza peticiones sin sesión", async () => {
  const r = await fetch(`${base}/api/summary`);
  assert.equal(r.status, 401);
});

test("una cookie malformada no rompe el servidor (401, no 500)", async () => {
  const r = await fetch(`${base}/api/summary`, { headers: { cookie: "pp_session=%zz" } });
  assert.equal(r.status, 401);
});

test("JSON inválido devuelve error JSON, no HTML", async () => {
  const r = await fetch(`${base}/api/contacts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{no-es-json"
  });
  assert.equal(r.status, 400);
  assert.match(r.headers.get("content-type") || "", /application\/json/);
  const body = await r.json();
  assert.ok(body.error);
});

test("rechaza credenciales incorrectas", async () => {
  const r = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "user=admin&password=mal",
    redirect: "manual"
  });
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location") || "", /error=1/);
});

test("permite iniciar sesión y consultar el resumen", async () => {
  const r = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "user=admin&password=secret",
    redirect: "manual"
  });
  assert.equal(r.status, 302);
  const setCookie = r.headers.get("set-cookie") || "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  cookie = setCookie.split(";")[0];

  const summary = await fetch(`${base}/api/summary`, { headers: { cookie } });
  assert.equal(summary.status, 200);
  const body = await summary.json();
  assert.equal(body.total, 0);
  assert.equal(summary.headers.get("cache-control"), "no-store");
});

test("valida teléfonos y evita duplicados", async () => {
  const ok = await fetch(`${base}/api/contacts`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Ana", phone: "5493511234567", optIn: true })
  });
  assert.equal(ok.status, 200);
  contactId = (await ok.json()).id;

  const bad = await fetch(`${base}/api/contacts`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "X", phone: "123" })
  });
  assert.equal(bad.status, 400);

  const dup = await fetch(`${base}/api/contacts`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Otra", phone: "5493511234567" })
  });
  assert.equal(dup.status, 409);
});

test("normaliza formatos equivalentes del mismo teléfono", async () => {
  const r = await fetch(`${base}/api/contacts`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Ana otra vez", phone: "+54 9 351 123-4567", optIn: true })
  });
  assert.equal(r.status, 409);
});

test("valida el DNI y evita duplicados", async () => {
  const bad = await fetch(`${base}/api/contacts`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Dni malo", phone: "5493510000010", dni: "12" })
  });
  assert.equal(bad.status, 400);

  const ok = await fetch(`${base}/api/contacts`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Con DNI", phone: "5493510000011", dni: "30.123.456", optIn: true })
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).dni, "30123456");

  const dup = await fetch(`${base}/api/contacts`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Otro", phone: "5493510000012", dni: "30123456" })
  });
  assert.equal(dup.status, 409);
});

test("los datos sensibles quedan cifrados en disco", () => {
  const files = ["promopanel.db", "promopanel.db-wal", "promopanel.db-shm"];
  const blob = files
    .map((f) => {
      const p = path.join(dataDir, f);
      return fs.existsSync(p) ? fs.readFileSync(p).toString("latin1") : "";
    })
    .join("");
  assert.ok(blob.length > 0, "debería existir la base SQLite");
  assert.ok(!blob.includes("5493511234567"), "el teléfono no debería estar en texto plano");
  assert.ok(!blob.includes("30123456"), "el DNI no debería estar en texto plano");
});

test("actualiza el permiso de un contacto", async () => {
  const r = await fetch(`${base}/api/contacts/${contactId}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ optIn: false })
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).optIn, false);
});

test("edita nombre, teléfono y DNI de un contacto", async () => {
  const r = await fetch(`${base}/api/contacts/${contactId}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Ana Editada", phone: "+54 9 351 999-9999", dni: "20.111.222" })
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.name, "Ana Editada");
  assert.equal(body.phone, "5493519999999", "el teléfono debe quedar normalizado");
  assert.equal(body.dni, "20111222", "el DNI debe quedar solo con dígitos");
});

test("no permite editar a un teléfono ya usado por otro cliente", async () => {
  const r = await fetch(`${base}/api/contacts/${contactId}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ phone: "5493510000011" })
  });
  assert.equal(r.status, 409);
});

test("rechaza editar a un teléfono inválido", async () => {
  const r = await fetch(`${base}/api/contacts/${contactId}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ phone: "123" })
  });
  assert.equal(r.status, 400);
});

test("no permite editar a un DNI ya registrado", async () => {
  const r = await fetch(`${base}/api/contacts/${contactId}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ dni: "30123456" })
  });
  assert.equal(r.status, 409);
});

test("permite borrar el DNI de un contacto", async () => {
  const r = await fetch(`${base}/api/contacts/${contactId}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ dni: "" })
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).dni, "");
});

test("editar un cliente inexistente devuelve 404", async () => {
  const r = await fetch(`${base}/api/contacts/no-existe`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "X" })
  });
  assert.equal(r.status, 404);
});

test("importa contactos desde CSV", async () => {
  const csv = "nombre,telefono,optin\nBeto,5493510000001,si\nCaro,5493510000002,no\nMalo,123,si";
  const fd = new FormData();
  fd.append("file", new Blob([csv], { type: "text/csv" }), "clientes.csv");
  const r = await fetch(`${base}/api/import`, { method: "POST", headers: { cookie }, body: fd });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.added, 2);
  assert.equal(body.invalid, 1);
});

test("rechaza envíos si Evolution API no está configurada", async () => {
  const r = await fetch(`${base}/api/send`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: "text", text: "hola", ids: "[]" })
  });
  assert.equal(r.status, 400);
});

test("guarda y recupera un borrador en el servidor", async () => {
  const put = await fetch(`${base}/api/drafts/send`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "Promo de prueba *imperdible*", type: "text", recipientIds: [contactId] })
  });
  assert.equal(put.status, 200);
  const saved = await put.json();
  assert.equal(saved.text, "Promo de prueba *imperdible*");
  assert.deepEqual(saved.recipientIds, [contactId]);

  const list = await fetch(`${base}/api/drafts`, { headers: { cookie } });
  assert.equal(list.status, 200);
  const drafts = await list.json();
  const send = drafts.find((d) => d.section === "send");
  assert.ok(send, "debería existir el borrador de envío");
  assert.equal(send.text, "Promo de prueba *imperdible*");
  assert.deepEqual(send.recipientIds, [contactId]);
});

test("el texto del borrador queda cifrado en disco", () => {
  const files = ["promopanel.db", "promopanel.db-wal", "promopanel.db-shm"];
  const blob = files
    .map((f) => {
      const p = path.join(dataDir, f);
      return fs.existsSync(p) ? fs.readFileSync(p).toString("latin1") : "";
    })
    .join("");
  assert.ok(!blob.includes("Promo de prueba"), "el texto del borrador no debería estar en texto plano");
});

test("un borrador vacío se elimina y no se guarda", async () => {
  const put = await fetch(`${base}/api/drafts/status`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "algo", type: "text" })
  });
  assert.equal(put.status, 200);

  const clear = await fetch(`${base}/api/drafts/status`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "   ", recipientIds: [] })
  });
  assert.equal(clear.status, 200);
  assert.equal((await clear.json()).cleared, true);

  const list = await (await fetch(`${base}/api/drafts`, { headers: { cookie } })).json();
  assert.ok(!list.some((d) => d.section === "status"), "el borrador vacío no debe persistir");
});

test("rechaza una sección de borrador inválida", async () => {
  const r = await fetch(`${base}/api/drafts/otra`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "x" })
  });
  assert.equal(r.status, 400);
});

test("el logout por POST invalida la sesión", async () => {
  const out = await fetch(`${base}/logout`, { method: "POST", headers: { cookie }, redirect: "manual" });
  assert.equal(out.status, 302);
  const r = await fetch(`${base}/api/summary`, { headers: { cookie } });
  assert.equal(r.status, 401);
});
