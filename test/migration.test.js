const { test, before, after } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// Preparar un directorio con datos en el formato anterior (JSON) ANTES de
// cargar el servidor, para comprobar la migración automática a SQLite.
const dataDir = path.join(os.tmpdir(), `promopanel-migration-${process.pid}-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, "contacts.json"), JSON.stringify([
  { id: "11111111-1111-4111-8111-111111111111", name: "Viejo Uno", phone: "5493511234567", dni: "30123456", optIn: true, createdAt: "2025-01-01T00:00:00.000Z" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Viejo Dos", phone: "3511234567", dni: "", optIn: false, createdAt: "2025-01-02T00:00:00.000Z" },
  { id: "33333333-3333-4333-8333-333333333333", name: "Inválido", phone: "123", dni: "", optIn: false, createdAt: "2025-01-03T00:00:00.000Z" }
], null, 2));
fs.writeFileSync(path.join(dataDir, "history.json"), JSON.stringify([
  { id: "h1", at: "2025-01-01T00:00:00.000Z", kind: "chat", type: "text", name: "Viejo Uno", phone: "5493511234567", ok: true }
], null, 2));

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

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  app.store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("migra los contactos válidos del JSON a SQLite", async () => {
  const login = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "user=admin&password=secret",
    redirect: "manual"
  });
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const r = await fetch(`${base}/api/contacts`, { headers: { cookie } });
  assert.equal(r.status, 200);
  const contacts = await r.json();
  assert.equal(contacts.length, 2, "el contacto con teléfono inválido no debe migrarse");

  const uno = contacts.find((c) => c.name === "Viejo Uno");
  assert.ok(uno, "debería migrarse Viejo Uno");
  assert.equal(uno.phone, "5493511234567");
  assert.equal(uno.dni, "30123456");
  assert.equal(uno.createdAt, "2025-01-01T00:00:00.000Z");

  const dos = contacts.find((c) => c.name === "Viejo Dos");
  assert.ok(dos, "debería migrarse Viejo Dos");
  assert.equal(dos.phone, "543511234567", "el teléfono debe quedar normalizado");
});

test("migra el historial y conserva los JSON como respaldo", async () => {
  const r = await fetch(`${base}/api/history`, { headers: { cookie } });
  assert.equal(r.status, 200);
  const history = await r.json();
  assert.equal(history.length, 1);
  assert.equal(history[0].name, "Viejo Uno");

  assert.ok(fs.existsSync(path.join(dataDir, "contacts.json")), "el JSON original no debe borrarse");
  assert.ok(fs.existsSync(path.join(dataDir, "history.json")), "el JSON original no debe borrarse");
  assert.ok(fs.existsSync(path.join(dataDir, "promopanel.db")), "debe existir la base SQLite");
});

test("no reimporta el JSON si ya se migró (aunque se borren los contactos)", async () => {
  const list = await (await fetch(`${base}/api/contacts`, { headers: { cookie } })).json();
  for (const c of list) {
    await fetch(`${base}/api/contacts/${c.id}`, { method: "DELETE", headers: { cookie } });
  }
  const again = app.store.importLegacy(dataDir);
  assert.equal(again.contacts, 0);
  const after = await (await fetch(`${base}/api/contacts`, { headers: { cookie } })).json();
  assert.equal(after.length, 0);
});
