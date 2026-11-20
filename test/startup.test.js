"use strict";
// Fail-fast de configuración y apagado limpio. Se usan procesos hijos porque
// estas comprobaciones ocultan (con razón) el módulo server.js al arrancar.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("../lib/db");

const root = path.join(__dirname, "..");
const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_KEY = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseEnv(dataDir, extra = {}) {
  // Aislamos dotenv: si el proyecto tiene .env con PANEL_PASSWORD, el hijo lo
  // cargaría y un test de "falta la contraseña" daría un falso positivo.
  const dotenvPath = path.join(dataDir, ".env.test");
  if (!fs.existsSync(dotenvPath)) fs.writeFileSync(dotenvPath, "");
  const env = {
    ...process.env, DATA_DIR: dataDir, DOTENV_CONFIG_PATH: dotenvPath,
    ENCRYPTION_KEY: KEY, PANEL_PASSWORD: "testpass123"
  };
  for (const name of ["PORT", "NODE_ENV", "SESSION_HOURS", "LOGIN_TTL_MS", "NODE_OPTIONS"]) delete env[name];
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete env[name]; // permite simular "variable no definida"
    else env[name] = value;
  }
  return env;
}

// Se ejecuta server.js como entrypoint: warnConfig() solo corre cuando
// require.main === module, así que un `require('./server')` no la ejerce.
function startFailure(dataDir, extra = {}) {
  return spawnSync(process.execPath, ["server.js"], {
    cwd: root, env: baseEnv(dataDir, extra), encoding: "utf8", timeout: 10000
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

test("configuración inválida: el panel no arranca y dice por qué", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-start-"));
  try {
    let r = startFailure(dir, { NODE_ENV: "production", PANEL_PASSWORD: undefined });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /PANEL_PASSWORD/);

    r = startFailure(dir, { NODE_ENV: "production", PANEL_PASSWORD: "change-me-now" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /PANEL_PASSWORD/);

    r = startFailure(dir, { SESSION_HOURS: "abc" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /SESSION_HOURS/);

    r = startFailure(dir, { MAX_TOTAL_UPLOAD_MB: "0" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /MAX_TOTAL_UPLOAD_MB/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cambiar la clave de cifrado impide arrancar en vez de servir datos ilegibles", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-key-"));
  try {
    const first = createStore({ dir, encryptionKey: KEY });
    first.addContact({ name: "Ana", phone: "3516123456", optIn: true });
    first.close();
    let r = startFailure(dir, { ENCRYPTION_KEY: OTHER_KEY });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /descifrar los datos existentes/);

    const second = fs.mkdtempSync(path.join(os.tmpdir(), "pp-keyfile-"));
    try {
      const generated = createStore({ dir: second, encryptionKey: undefined });
      generated.close();
      r = startFailure(second, { ENCRYPTION_KEY: OTHER_KEY });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /no coincide con la clave guardada/);
    } finally {
      fs.rmSync(second, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGTERM marca el envío como detenido y cierra sin mandar más mensajes", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-sigterm-"));
  const sent = [];
  const evo = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url.startsWith("/message/sendText/")) {
        let text = "";
        try { text = JSON.parse(body).text; } catch {}
        sent.push(text);
      }
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => evo.listen(0, "127.0.0.1", r));
  const port = await freePort();
  // En Windows child.kill("SIGTERM") termina el proceso a la fuerza y no
  // ejecuta los handlers. Disparamos el mismo evento dentro del hijo para
  // ejercitar installShutdown() de verdad.
  const stopFlag = path.join(dir, "stop.now");
  const trigger = path.join(dir, "trigger.js");
  fs.writeFileSync(trigger, [
    'const fs = require("node:fs");',
    'const flag = process.env.SIGTERM_FLAG;',
    'const timer = setInterval(() => {',
    '  if (!flag || !fs.existsSync(flag)) return;',
    '  clearInterval(timer);',
    '  process.emit("SIGTERM");',
    '}, 20);',
    'timer.unref();',
    ""
  ].join("\n"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: baseEnv(dir, {
      PORT: String(port),
      EVOLUTION_URL: `http://127.0.0.1:${evo.address().port}`,
      EVOLUTION_API_KEY: "mockkey",
      EVOLUTION_INSTANCE: "promociones",
      SEND_DELAY_MS: "300", SEND_DELAY_JITTER_MS: "0",
      SEND_BATCH_SIZE: "0", SEND_BATCH_PAUSE_MS: "0",
      SIGTERM_FLAG: stopFlag,
      NODE_OPTIONS: `--require=${trigger}`
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await new Promise((r) => evo.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + "/health"); if (r.ok) { ready = true; break; } } catch {}
    await sleep(50);
  }
  assert.ok(ready, "el servidor hijo arrancó");

  const login = await fetch(base + "/login", {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "user=admin&password=testpass123"
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const api = async (url, options = {}) => {
    const r = await fetch(base + url, { ...options, headers: { ...(options.headers || {}), Cookie: cookie } });
    return r.json();
  };
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const c = await api("/api/contacts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Job " + i, phone: "351800000" + i, optIn: true })
    });
    ids.push(c.id);
  }
  const fd = new FormData();
  fd.append("type", "text"); fd.append("text", "Campaña larga"); fd.append("ids", JSON.stringify(ids));
  const started = await api("/api/send", { method: "POST", body: fd, headers: { "Idempotency-Key": "sigterm" } });
  assert.equal(started.status, undefined, "la respuesta es JSON, no un status HTTP");
  assert.ok(started.jobId);
  for (let i = 0; i < 60 && sent.length < 2; i++) await sleep(50);
  assert.ok(sent.length >= 1 && sent.length < 6, "el envío estaba en curso");

  fs.writeFileSync(stopFlag, "1");
  const exited = await Promise.race([
    new Promise((r) => child.once("exit", (code) => r(code))),
    sleep(7000).then(() => "timeout")
  ]);
  assert.equal(exited, 0, "SIGTERM termina limpio");
  const atExit = sent.length;
  await sleep(700);
  assert.equal(sent.length, atExit, "no se envían mensajes después del apagado");
});
