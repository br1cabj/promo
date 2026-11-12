require("dotenv").config();
const express = require("express");
const compression = require("compression");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parse } = require("csv-parse/sync");
const { createStore, StoreError } = require("./lib/db");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
fs.mkdirSync(DATA, { recursive: true });

// ---------------------------------------------------------------------------
// Almacén de datos sobre SQLite. Si la base está vacía, importa automáticamente
// los datos del formato anterior (data/*.json), que se conservan como respaldo.
// ---------------------------------------------------------------------------
const store = createStore({
  dir: DATA,
  encryptionKey: process.env.ENCRYPTION_KEY,
  defaultCountry: process.env.DEFAULT_COUNTRY || "AR"
});
const migration = store.importLegacy(DATA);
if (migration.contacts || migration.history || migration.skipped) {
  console.log(
    `[PromoPanel] Migré ${migration.contacts} contactos y ${migration.history} registros de historial a SQLite` +
    `${migration.skipped ? ` (omitidos: ${migration.skipped})` : ""}.`
  );
}
if (!store.cipherEnabled) {
  console.warn("[PromoPanel] Sin clave de cifrado: teléfono y DNI se guardan SIN cifrar. Definí ENCRYPTION_KEY.");
} else if (!store.verifyDecryption()) {
  console.error("[PromoPanel] ATENCIÓN: no puedo descifrar los datos con la clave actual. ¿Cambió ENCRYPTION_KEY? Los datos cifrados no se podrán leer.");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cut = (value, max) => String(value ?? "").trim().slice(0, max);
const MAX_NAME = 120, MAX_TEXT = 8000;

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
const config = {
  url: (process.env.EVOLUTION_URL || "").replace(/\/+$/, ""),
  key: process.env.EVOLUTION_API_KEY || "",
  instance: process.env.EVOLUTION_INSTANCE || ""
};
const configured = () => Boolean(config.url && config.key && config.instance);

const PANEL_USER = process.env.PANEL_USER || "admin";
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "change-me-now";
const SESSION_HOURS = Math.max(1, Number(process.env.SESSION_HOURS || 12));
const SEND_DELAY_MS = Math.max(0, Number(process.env.SEND_DELAY_MS ?? 1500));
// Pausa aleatoria: el retraso real es SEND_DELAY_MS + [0, SEND_DELAY_JITTER_MS].
const SEND_DELAY_JITTER_MS = Math.max(0, Number(process.env.SEND_DELAY_JITTER_MS ?? 2500));
// Cada SEND_BATCH_SIZE mensajes se hace un descanso más largo.
const SEND_BATCH_SIZE = Math.max(0, Number(process.env.SEND_BATCH_SIZE || 20));
const SEND_BATCH_PAUSE_MS = Math.max(0, Number(process.env.SEND_BATCH_PAUSE_MS || 60000));
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);
const MAX_SEND_FILES = Math.max(1, Number(process.env.MAX_SEND_FILES || 10));
const MAX_TOTAL_UPLOAD_MB = Number(process.env.MAX_TOTAL_UPLOAD_MB || 60);

// ---------------------------------------------------------------------------
// Sesiones (token aleatorio validado contra un Map en memoria; logout real)
// ---------------------------------------------------------------------------
const SESSION_COOKIE = "pp_session";
const sessions = new Map(); // token -> expiración (ms)

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_HOURS * 3600 * 1000);
  return token;
}
function destroySession(token) { if (token) sessions.delete(token); }
function sessionToken(req) {
  const raw = parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
  return raw || null;
}
function isAuthed(req) {
  const token = sessionToken(req);
  const expires = token && sessions.get(token);
  return Boolean(expires && expires > Date.now());
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    const value = part.slice(i + 1).trim();
    try { out[key] = decodeURIComponent(value); }
    catch { out[key] = value; } // cookie malformada: no rompemos la request
  }
  return out;
}
function isSecureRequest(req) {
  return req.secure || req.get("x-forwarded-proto") === "https";
}
function setSessionCookie(res, req, token) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    `Max-Age=${SESSION_HOURS * 3600}`
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}
function clearSessionCookie(res, req) {
  const parts = [`${SESSION_COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Strict", "Max-Age=0"];
  if (isSecureRequest(req)) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}
setInterval(() => {
  const now = Date.now();
  for (const [token, expires] of sessions) if (expires <= now) sessions.delete(token);
}, 3600 * 1000).unref();

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// Limitador de tasa en memoria
// ---------------------------------------------------------------------------
function rateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, stamps] of hits) {
      const fresh = stamps.filter((t) => now - t < windowMs);
      if (fresh.length) hits.set(key, fresh); else hits.delete(key);
    }
  }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const fresh = (hits.get(key) || []).filter((t) => now - t < windowMs);
    fresh.push(now);
    hits.set(key, fresh);
    if (fresh.length > max) return res.status(429).json({ error: message || "Demasiadas solicitudes. Probá de nuevo en un momento." });
    next();
  };
}

// ---------------------------------------------------------------------------
// Middlewares base
// ---------------------------------------------------------------------------
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true");

// Cabeceras de seguridad (defensa en profundidad).
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; " +
    "form-action 'self'; frame-ancestors 'none'"
  );
  if (isSecureRequest(req)) res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
});
app.use(compression());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));
app.use("/api", (req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

// Protección CSRF (defensa en profundidad): las operaciones mutables deben venir
// del mismo sitio. Detrás de un proxy inverso (Coolify/Traefik) el encabezado
// Origin (host público) puede no coincidir con el Host que ve el contenedor, así
// que comparamos solo el hostname (sin puerto) contra todos los hosts conocidos:
// el de la petición, los que reporta el proxy (X-Forwarded-*) y un PUBLIC_URL
// opcional. Si no hay Origin o es "null" (origen opaco), confiamos en la cookie
// de sesión SameSite=Strict. Nunca se rechaza por diferencias de puerto.
function hostnameOf(value) {
  if (!value) return "";
  const raw = String(value).split(",")[0].trim();
  try { return new URL(raw.includes("://") ? raw : "http://" + raw).hostname.toLowerCase(); } catch { return ""; }
}
function allowedHostnames(req) {
  const hosts = [
    req.hostname,
    req.get("host"),
    req.get("x-forwarded-host"),
    req.get("x-forwarded-server"),
    process.env.PUBLIC_URL
  ];
  return [...new Set(hosts.map(hostnameOf).filter(Boolean))];
}
function csrfGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (!origin || origin === "null") return next();
  let originHost = "";
  try { originHost = new URL(origin).hostname.toLowerCase(); } catch { originHost = ""; }
  if (!originHost || allowedHostnames(req).includes(originHost)) return next();
  console.warn("[PromoPanel] CSRF rechazado:", JSON.stringify({
    origin,
    host: req.get("host"),
    xForwardedHost: req.get("x-forwarded-host"),
    xForwardedServer: req.get("x-forwarded-server"),
    xForwardedProto: req.get("x-forwarded-proto"),
    publicUrl: process.env.PUBLIC_URL || null
  }));
  return res.status(403).json({ error: "Origen no permitido." });
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Sesión no válida. Iniciá sesión nuevamente." });
  return res.redirect("/login");
}

const loginLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 10, message: "Demasiados intentos de acceso. Esperá unos minutos." });
const apiLimiter = rateLimiter({ windowMs: 60 * 1000, max: 600 });

// ---------------------------------------------------------------------------
// Autenticación
// ---------------------------------------------------------------------------
function loginPage(error) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ingresar · PromoPanel Lite</title>
<style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#10251d;font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;color:#17231f}
  form{background:#fff;border-radius:16px;padding:34px 32px;width:min(360px,90vw);box-shadow:0 20px 60px rgba(0,0,0,.35)}
  h1{margin:0 0 4px;font-size:20px;letter-spacing:-.4px}p.sub{margin:0 0 22px;color:#718078;font-size:13px}
  label{display:block;font-size:12px;font-weight:650;color:#4b5a52;margin-bottom:13px}
  input{display:block;width:100%;margin-top:6px;border:1px solid #dfe7e2;border-radius:8px;padding:11px;font:inherit;font-size:14px;outline:none}
  input:focus{border-color:#67ae89;box-shadow:0 0 0 3px #167c5514}
  button{width:100%;margin-top:6px;border:0;border-radius:8px;padding:12px;background:#167c55;color:#fff;font:inherit;font-weight:750;cursor:pointer}
  button:hover{background:#0d6543}.error{background:#fdecec;color:#a13a3a;border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:16px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;margin-bottom:20px}.mark{display:grid;place-items:center;background:#1d8a5e;width:34px;height:34px;border-radius:10px;color:#fff;font-size:20px}
</style></head>
<body>
  <form method="post" action="/login" autocomplete="on">
    <div class="brand"><span class="mark">✦</span><span>PromoPanel <small>LITE</small></span></div>
    <h1>Panel privado</h1><p class="sub">Ingresá con tus credenciales.</p>
    ${error ? '<div class="error">Usuario o contraseña incorrectos.</div>' : ""}
    <label>Usuario<input name="user" autocomplete="username" required></label>
    <label>Contraseña<input type="password" name="password" autocomplete="current-password" required></label>
    <button type="submit">Ingresar</button>
  </form>
</body></html>`;
}

app.get("/health", (req, res) => res.json({ status: "ok", configured: configured() }));

app.get("/login", (req, res) => {
  if (isAuthed(req)) return res.redirect("/");
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(loginPage(req.query.error));
});

app.post("/login", loginLimiter, (req, res) => {
  const user = String((req.body && req.body.user) || "");
  const password = String((req.body && req.body.password) || "");
  if (safeEqual(user, PANEL_USER) && safeEqual(password, PANEL_PASSWORD)) {
    setSessionCookie(res, req, createSession());
    return res.redirect("/");
  }
  return res.redirect("/login?error=1");
});

// ---------------------------------------------------------------------------
// A partir de acá todo requiere sesión
// ---------------------------------------------------------------------------
app.use(requireAuth);
app.use(csrfGuard);
app.use(apiLimiter);

// Logout por POST (evita el logout-CSRF de un simple <img src="/logout">).
app.post("/logout", (req, res) => {
  destroySession(sessionToken(req));
  clearSessionCookie(res, req);
  res.redirect("/login");
});

app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: MAX_SEND_FILES }
});

// Suma de tamaños de los archivos subidos, para acotar el total en memoria.
const totalUploadBytes = (files) => (files || []).reduce((sum, f) => sum + (f.size || f.buffer?.length || 0), 0);

let evoAgent = null;
function evoClient() {
  if (!configured()) throw new Error("Falta configurar Evolution API en el archivo .env");
  // Se reutiliza una sola instancia de axios (mejor uso de sockets).
  if (!evoAgent) {
    evoAgent = axios.create({
      baseURL: config.url,
      timeout: 45000,
      headers: { apikey: config.key, "Content-Type": "application/json" }
    });
  }
  return evoAgent;
}
function csvContact(row) {
  const optInRaw = String(row.optin || row.autorizado || row.consentimiento || "").toLowerCase().trim();
  return {
    name: row.name || row.nombre,
    phone: row.phone || row.telefono || row.celular || row.whatsapp,
    dni: row.dni,
    optIn: ["si", "sí", "yes", "true", "1", "acepta", "autorizado"].includes(optInRaw)
  };
}
function addHistory(entry) {
  store.addHistory(entry);
}

// ---------------------------------------------------------------------------
// Trabajos de envío en segundo plano (evita requests HTTP de larga duración)
// ---------------------------------------------------------------------------
const jobs = new Map();
function createJob(total) {
  const id = crypto.randomUUID();
  const job = { id, status: "running", total, processed: 0, sent: 0, failed: 0, results: [], createdAt: new Date().toISOString() };
  jobs.set(id, job);
  return job;
}
setInterval(() => {
  const cutoff = Date.now() - 3600 * 1000;
  for (const [id, job] of jobs) if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
}, 600 * 1000).unref();

// Pausa antes del siguiente mensaje. Devuelve 0 en el último envío. Combina
// una espera aleatoria (jitter, para no mandar con un patrón constante) con un
// descanso más largo cada SEND_BATCH_SIZE mensajes.
function nextSendDelay(index, total) {
  if (index >= total - 1) return 0;
  if (SEND_BATCH_SIZE && SEND_BATCH_PAUSE_MS && (index + 1) % SEND_BATCH_SIZE === 0) return SEND_BATCH_PAUSE_MS;
  if (!SEND_DELAY_MS && !SEND_DELAY_JITTER_MS) return 0;
  return SEND_DELAY_MS + Math.floor(Math.random() * (SEND_DELAY_JITTER_MS + 1));
}

async function runSendJob(job, { type, text, contacts, media }) {
  try {
    const api = evoClient();
    // Una unidad por cada mensaje a enviar: con texto es una por cliente; con
    // imágenes/videos es una por archivo (el texto va como pie de la primera).
    const units = [];
    for (const c of contacts) {
      if (type === "text") units.push({ c, media: null, caption: text });
      else media.forEach((m, i) => units.push({ c, media: m, caption: i === 0 ? text : "" }));
    }
    for (let i = 0; i < units.length; i++) {
      const { c, media: m, caption } = units[i];
      try {
        let endpoint, payload;
        if (type === "text") {
          endpoint = `/message/sendText/${encodeURIComponent(config.instance)}`;
          payload = { number: c.phone, text };
        } else {
          endpoint = `/message/sendMedia/${encodeURIComponent(config.instance)}`;
          payload = { number: c.phone, mediatype: type, mimetype: m.mime, caption, media: m.base64, fileName: m.fileName };
        }
        await api.post(endpoint, payload);
        job.sent++;
        job.results.push({ name: c.name, phone: c.phone, ok: true });
        addHistory({ kind: "chat", type, name: c.name, phone: c.phone, ok: true });
      } catch (err) {
        job.failed++;
        job.results.push({ name: c.name, phone: c.phone, ok: false, error: err.response?.data?.message || err.message });
        addHistory({ kind: "chat", type, name: c.name, phone: c.phone, ok: false, error: err.message });
      }
      job.processed = i + 1;
      const wait = nextSendDelay(i, units.length);
      if (wait) await sleep(wait);
    }
    job.status = "done";
  } catch (e) {
    job.status = "error";
    job.error = e.response?.data?.message || e.message;
  }
  job.finishedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.get("/api/summary", (req, res) => {
  const counts = store.counts();
  res.json({
    total: counts.total,
    optedIn: counts.optedIn,
    history: counts.history,
    connectedConfig: configured()
  });
});

app.get("/api/contacts", (req, res) => res.json(store.listContacts()));

app.post("/api/contacts", (req, res) => {
  try {
    const contact = store.addContact({
      name: req.body.name,
      phone: req.body.phone,
      dni: req.body.dni,
      optIn: req.body.optIn === true
    });
    res.json(contact);
  } catch (e) {
    if (e instanceof StoreError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

app.patch("/api/contacts/:id", (req, res) => {
  try {
    const item = store.updateContact(req.params.id, req.body);
    if (!item) return res.status(404).json({ error: "Cliente no encontrado." });
    res.json(item);
  } catch (e) {
    if (e instanceof StoreError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

app.delete("/api/contacts/:id", (req, res) => {
  store.deleteContact(req.params.id);
  res.json({ ok: true });
});

app.post("/api/import", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Seleccioná un archivo CSV." });
  let rows;
  try {
    rows = parse(req.file.buffer.toString("utf8").replace(/^\uFEFF/, ""), {
      columns: true, skip_empty_lines: true, bom: true, trim: true
    });
  } catch (e) {
    return res.status(400).json({ error: "No pude leer el CSV. Revisá que tenga encabezados y esté separado por comas." });
  }
  let added = 0, duplicates = 0, invalid = 0;
  for (const row of rows) {
    try {
      store.addContact({ ...csvContact(row), strictDni: false });
      added++;
    } catch (e) {
      if (e instanceof StoreError && e.code === "phone_duplicate") duplicates++;
      else invalid++;
    }
  }
  res.json({ added, duplicates, invalid, total: rows.length });
});

app.get("/api/connection", async (req, res) => {
  try {
    const r = await evoClient().get(`/instance/connectionState/${encodeURIComponent(config.instance)}`);
    res.json({ configured: true, data: r.data });
  } catch (e) {
    res.status(200).json({ configured: configured(), error: e.response?.data?.message || e.message });
  }
});

// Devuelve la conexión de la instancia. Si todavía no existe (primer arranque
// en un servidor nuevo), la crea y devuelve el QR para vincular WhatsApp.
async function connectOrCreate(api, instanceName) {
  const instance = encodeURIComponent(instanceName);
  try {
    return await api.get(`/instance/connect/${instance}`);
  } catch (e) {
    if (e.response?.status !== 404) throw e;
    return await api.post(`/instance/create`, { instanceName, integration: "WHATSAPP-BAILEYS", qrcode: true });
  }
}

app.post("/api/connect", async (req, res) => {
  try {
    const r = await connectOrCreate(evoClient(), config.instance);
    const data = r.data || {};
    const qr = data.base64 || data.qrcode?.base64 || data.qrcode || null;
    res.json({ ok: true, qr, data });
  } catch (e) { res.status(502).json({ error: e.response?.data?.message || e.message }); }
});

app.post("/api/send", upload.array("files", MAX_SEND_FILES), (req, res) => {
  try {
    if (!configured()) return res.status(400).json({ error: "Falta configurar Evolution API en el archivo .env" });
    const { type, text, ids } = req.body;
    let selectedIds;
    try { selectedIds = JSON.parse(ids || "[]"); } catch { selectedIds = []; }
    if (!Array.isArray(selectedIds)) selectedIds = [];
    const contacts = store.listContacts().filter(c => selectedIds.includes(c.id) && c.optIn);
    if (!contacts.length) return res.status(400).json({ error: "No hay clientes seleccionados con autorización para recibir promociones." });
    if (!["text", "image", "video"].includes(type)) return res.status(400).json({ error: "Tipo de mensaje no válido." });
    const cleanText = cut(text, MAX_TEXT);
    if (type === "text" && !cleanText) return res.status(400).json({ error: "Escribí un mensaje." });
    const files = req.files || [];
    if (type !== "text" && !files.length) return res.status(400).json({ error: "Adjuntá al menos una imagen o video." });
    if (totalUploadBytes(files) > MAX_TOTAL_UPLOAD_MB * 1024 * 1024) {
      return res.status(413).json({ error: `El total de archivos supera el límite de ${MAX_TOTAL_UPLOAD_MB} MB.` });
    }

    let media = [];
    if (type !== "text") {
      for (const f of files) {
        if (type === "image" && !f.mimetype.startsWith("image/")) return res.status(400).json({ error: "Todos los archivos deben ser imágenes." });
        if (type === "video" && f.mimetype !== "video/mp4") return res.status(400).json({ error: "Para video, usá archivos MP4." });
        // Se codifica una sola vez para todos los destinatarios.
        media.push({ mime: f.mimetype, base64: f.buffer.toString("base64"), fileName: cut(f.originalname, 200) });
      }
    }

    const total = type === "text" ? contacts.length : contacts.length * media.length;
    const job = createJob(total);
    res.status(202).json({ jobId: job.id, total: job.total });
    runSendJob(job, { type, text: cleanText, contacts, media }).catch(() => {});
  } catch (e) { res.status(400).json({ error: e.response?.data?.message || e.message }); }
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Trabajo no encontrado." });
  res.json({
    id: job.id, status: job.status, total: job.total, processed: job.processed,
    sent: job.sent, failed: job.failed, results: job.results, error: job.error
  });
});

app.post("/api/status", upload.single("file"), async (req, res) => {
  const type = req.body.type;
  try {
    if (!configured()) return res.status(400).json({ error: "Falta configurar Evolution API en el archivo .env" });
    const text = cut(req.body.text, MAX_TEXT);
    if (!["text", "image", "video"].includes(type)) return res.status(400).json({ error: "Tipo de estado no válido." });
    if (type === "text" && !text) return res.status(400).json({ error: "Escribí el texto del estado." });
    if (type !== "text" && !req.file) return res.status(400).json({ error: "Adjuntá una imagen o video." });
    const payload = { type, allContacts: true };
    if (type === "text") {
      payload.content = text;
      payload.backgroundColor = cut(req.body.backgroundColor || "#128C7E", 32) || "#128C7E";
      payload.font = Number(req.body.font || 1);
    } else {
      const mime = req.file.mimetype;
      if (type === "image" && !mime.startsWith("image/")) return res.status(400).json({ error: "El archivo no parece ser una imagen." });
      if (type === "video" && mime !== "video/mp4") return res.status(400).json({ error: "Para estado de video, usá MP4." });
      payload.content = `data:${mime};base64,${req.file.buffer.toString("base64")}`;
      payload.caption = text;
    }
    const r = await evoClient().post(`/message/sendStatus/${encodeURIComponent(config.instance)}`, payload);
    addHistory({ kind: "status", type, ok: true, response: r.data });
    res.json({ ok: true, data: r.data });
  } catch (e) {
    addHistory({ kind: "status", type, ok: false, error: e.message });
    res.status(502).json({ error: e.response?.data?.message || e.message });
  }
});

app.get("/api/history", (req, res) => res.json(store.listHistory(150)));

// Borradores de redacción (texto, tipo y destinatarios). Persisten en el
// servidor, así están disponibles desde cualquier equipo o el celular.
app.get("/api/drafts", (req, res) => res.json(store.listDrafts()));

app.put("/api/drafts/:section", (req, res) => {
  try {
    const draft = store.saveDraft(req.params.section, {
      text: req.body.text,
      type: req.body.type,
      recipientIds: req.body.recipientIds
    });
    res.json(draft);
  } catch (e) {
    if (e instanceof StoreError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

app.delete("/api/drafts/:section", (req, res) => {
  store.deleteDraft(req.params.section);
  res.json({ ok: true });
});

// Plantillas de texto ("mensajes ya escritos") reutilizables y preseleccionables.
app.get("/api/templates", (req, res) => res.json(store.listTemplates()));

app.post("/api/templates", (req, res) => {
  try {
    res.json(store.createTemplate({ name: req.body.name, text: req.body.text }));
  } catch (e) {
    if (e instanceof StoreError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

app.patch("/api/templates/:id", (req, res) => {
  try {
    const item = store.updateTemplate(req.params.id, { name: req.body.name, text: req.body.text });
    if (!item) return res.status(404).json({ error: "La plantilla no existe." });
    res.json(item);
  } catch (e) {
    if (e instanceof StoreError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

app.delete("/api/templates/:id", (req, res) => {
  store.deleteTemplate(req.params.id);
  res.json({ ok: true });
});

app.use("/api", (req, res) => res.status(404).json({ error: "Recurso no encontrado." }));

// ---------------------------------------------------------------------------
// Manejador de errores: siempre JSON, sin filtrar stack traces
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE"
      ? `El archivo supera el límite de ${MAX_UPLOAD_MB} MB.`
      : "No pude procesar el archivo adjunto.";
    return res.status(400).json({ error: message });
  }
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "El contenido enviado es demasiado grande." });
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Datos inválidos en la solicitud." });
  console.error("[PromoPanel] Error no controlado:", err);
  res.status(500).json({ error: "Ocurrió un error interno." });
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
function warnConfig() {
  if (!configured()) console.warn("[PromoPanel] Evolution API incompleta: revisá EVOLUTION_URL, EVOLUTION_API_KEY y EVOLUTION_INSTANCE en .env");
  if (!process.env.PANEL_PASSWORD) console.warn("[PromoPanel] Usando contraseña por defecto. Configurá PANEL_PASSWORD en .env antes de exponer el panel.");
}

if (require.main === module) {
  warnConfig();
  app.listen(PORT, () => console.log(`PromoPanel Lite escuchando en puerto ${PORT}`));
}

module.exports = app;
