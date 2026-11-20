require("dotenv").config({ quiet: true });
const express = require("express");
const compression = require("compression");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parse } = require("csv-parse/sync");
const { createStore, StoreError } = require("./lib/db");
const { evoError, normalizeLinkNumber, connectResponse } = require("./lib/connection");

const app = express();
const APP_VERSION = require("./package.json").version;
// Configuración numérica: un valor inválido debe impedir el arranque, no
// convertirse en NaN y romper sesiones o límites en silencio.
function envInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Variable ${name} inválida: se esperaba un entero entre ${min} y ${max}.`);
  }
  return value;
}
const PORT = envInt("PORT", 3000, 1, 65535);
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
fs.mkdirSync(DATA, { recursive: true });

// ---------------------------------------------------------------------------
// Almacén de datos sobre SQLite. Si la base está vacía, importa automáticamente
// los datos del formato anterior (data/*.json), que se conservan como respaldo.
// ---------------------------------------------------------------------------
const DEFAULT_COUNTRY = process.env.DEFAULT_COUNTRY || "AR";
// Los QR de WhatsApp y los códigos de vinculación vencen en pocos minutos.
const LINK_TTL_MS = envInt("LINK_TTL_MS", 5 * 60 * 1000, 1000, 6 * 60 * 60 * 1000);
const store = createStore({
  dir: DATA,
  encryptionKey: process.env.ENCRYPTION_KEY,
  defaultCountry: DEFAULT_COUNTRY
});
const migration = store.importLegacy(DATA);
if (migration.contacts || migration.history || migration.skipped) {
  console.log(
    `[PromoPanel] Migré ${migration.contacts} contactos y ${migration.history} registros de historial a SQLite` +
    `${migration.skipped ? ` (omitidos: ${migration.skipped})` : ""}.`
  );
}
// Con datos cifrados, una clave equivocada no es un aviso: es un panel roto
// (lecturas 500 y duplicados por cambio de índice ciego). Mejor no arrancar.
const ENCRYPTION_OK = !store.cipherEnabled || store.verifyDecryption();
if (!store.cipherEnabled) {
  console.warn("[PromoPanel] Sin clave de cifrado: teléfono y DNI se guardan SIN cifrar. Definí ENCRYPTION_KEY.");
} else if (!ENCRYPTION_OK) {
  store.close();
  throw new Error("No puedo descifrar los datos existentes con la clave actual. Restaurá la ENCRYPTION_KEY original (o data/.key).");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cut = (value, max) => String(value ?? "").trim().slice(0, max);
// Límites reales de WhatsApp/Evolution: 4096 para texto y 1024 para pies de
// imagen/video. Los borradores y plantillas usan el mismo tope en lib/db.js.
const MAX_TEXT = 4096, MAX_CAPTION = 1024;
// Los resultados se entregan al front en cada poll: acotamos el array para que
// una campaña grande no serialice decenas de miles de objetos por respuesta.
const MAX_JOB_RESULTS = 500;

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
const config = {
  url: (process.env.EVOLUTION_URL || "").replace(/\/+$/, ""),
  key: process.env.EVOLUTION_API_KEY || "",
  instance: process.env.EVOLUTION_INSTANCE || ""
};
const configured = () => Boolean(config.url && config.key && config.instance);

const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const PANEL_USER = process.env.PANEL_USER || "admin";
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "change-me-now";
const SESSION_HOURS = envInt("SESSION_HOURS", 12, 1, 720);
const SEND_DELAY_MS = envInt("SEND_DELAY_MS", 1500, 0, 10 * 60 * 1000);
// Pausa aleatoria: el retraso real es SEND_DELAY_MS + [0, SEND_DELAY_JITTER_MS].
const SEND_DELAY_JITTER_MS = envInt("SEND_DELAY_JITTER_MS", 2500, 0, 10 * 60 * 1000);
// Cada SEND_BATCH_SIZE mensajes se hace un descanso más largo.
const SEND_BATCH_SIZE = envInt("SEND_BATCH_SIZE", 20, 0, 10000);
const SEND_BATCH_PAUSE_MS = envInt("SEND_BATCH_PAUSE_MS", 60000, 0, 60 * 60 * 1000);
const MAX_UPLOAD_MB = envInt("MAX_UPLOAD_MB", 25, 1, 250);
const MAX_SEND_FILES = envInt("MAX_SEND_FILES", 10, 1, 50);
const MAX_TOTAL_UPLOAD_MB = envInt("MAX_TOTAL_UPLOAD_MB", 60, 1, 500);

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
  // Sin trust proxy, X-Forwarded-Proto lo escribe el cliente: no debe activar
  // Secure/HSTS ni dejar una cookie que el navegador ignora en HTTP.
  return TRUST_PROXY ? Boolean(req.secure || req.get("x-forwarded-proto") === "https") : Boolean(req.secure);
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
function rateLimiter({ windowMs, max, message, onLimit }) {
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
    if (fresh.length > max) {
      if (onLimit) return onLimit(req, res, message);
      return res.status(429).json({ error: message || "Demasiadas solicitudes. Probá de nuevo en un momento." });
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Middlewares base
// ---------------------------------------------------------------------------
app.disable("x-powered-by");
app.set("trust proxy", TRUST_PROXY);

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
  // El login y el logout son formularios, no API: les mostramos la pantalla de
  // ingreso con un aviso en vez de un JSON suelto.
  if (!req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(403).type("html").send(loginPage("csrf"));
  }
  return res.status(403).json({ error: "Origen no permitido." });
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Sesión no válida. Iniciá sesión nuevamente." });
  return res.redirect("/login");
}

const loginLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Demasiados intentos de acceso. Esperá unos minutos.",
  // Es un formulario: mejor devolver la pantalla de ingreso con el aviso.
  onLimit: (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    return res.status(429).type("html").send(loginPage("rate"));
  }
});
const apiLimiter = rateLimiter({ windowMs: 60 * 1000, max: 600 });

// ---------------------------------------------------------------------------
// Autenticación
// ---------------------------------------------------------------------------
const LOGIN_ERRORS = {
  "1": "Usuario o contraseña incorrectos.",
  rate: "Demasiados intentos de acceso. Esperá unos minutos y volvé a probar.",
  csrf: "No se pudo validar el origen de la solicitud. Recargá la página e intentá de nuevo."
};
function loginPage(error) {
  // Solo se usan claves conocidas: el querystring nunca se interpola en el HTML.
  const message = LOGIN_ERRORS[String(error || "")] || "";
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Ingresar · PromoPanel Lite</title>
<style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#10251d;font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;color:#17231f;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
  form{background:#fff;border-radius:16px;padding:34px 32px;width:min(360px,90vw);box-shadow:0 20px 60px rgba(0,0,0,.35)}
  h1{margin:0 0 4px;font-size:20px;letter-spacing:-.4px}p.sub{margin:0 0 22px;color:#718078;font-size:13px}
  label{display:block;font-size:12px;font-weight:650;color:#4b5a52;margin-bottom:13px}
  input{display:block;width:100%;margin-top:6px;border:1px solid #dfe7e2;border-radius:8px;padding:11px;font:inherit;font-size:14px;outline:none}
  input:focus{border-color:#67ae89;box-shadow:0 0 0 3px #167c5514}
  button{width:100%;margin-top:6px;border:0;border-radius:8px;padding:12px;background:#167c55;color:#fff;font:inherit;font-weight:750;cursor:pointer}
  button:hover{background:#0d6543}.error{background:#fdecec;color:#a13a3a;border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:16px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;margin-bottom:20px}.mark{display:grid;place-items:center;background:#1d8a5e;width:34px;height:34px;border-radius:10px}.mark img{width:22px;height:22px;display:block}
</style></head>
<body>
  <form method="post" action="/login" autocomplete="on">
    <div class="brand"><span class="mark"><img src="/favicon.svg" alt=""></span><span>PromoPanel <small>LITE</small></span></div>
    <h1>Panel privado</h1><p class="sub">Ingresá con tus credenciales.</p>
    ${message ? `<div class="error">${message}</div>` : ""}
    <label>Usuario<input name="user" autocomplete="username" required></label>
    <label>Contraseña<input type="password" name="password" autocomplete="current-password" required></label>
    <button type="submit">Ingresar</button>
  </form>
</body></html>`;
}

app.get("/health", (req, res) => {
  const dbOk = ENCRYPTION_OK && store.isHealthy();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? "ok" : "error",
    configured: configured(),
    version: APP_VERSION,
    dbOk
  });
});

// El guard cubre también el formulario de ingreso (login-CSRF) y el logout.
app.use(csrfGuard);

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
app.use(apiLimiter);

// Logout por POST (evita el logout-CSRF de un simple <img src="/logout">).
app.post("/logout", (req, res) => {
  destroySession(sessionToken(req));
  clearSessionCookie(res, req);
  res.redirect("/login");
});

app.use(express.static(path.join(__dirname, "public")));

// Almacenamiento en memoria con límite TOTAL mientras llegan los bytes: el
// memoryStorage de multer solo conoce el límite por archivo y podría bufferear
// cientos de MB antes de que podamos rechazar la suma de todos.
const uploadTotals = new WeakMap();
const limitedMemoryStorage = {
  _handleFile(req, file, cb) {
    const chunks = [];
    let size = 0, done = false, failed = false;
    const prior = uploadTotals.get(req) || 0;
    const finish = (err, data) => { if (done) return; done = true; cb(err, data); };
    file.stream.on("data", (chunk) => {
      if (failed || done) return;
      size += chunk.length;
      if (prior + size > MAX_TOTAL_UPLOAD_MB * 1024 * 1024) {
        failed = true;
        finish(new multer.MulterError("LIMIT_TOTAL_SIZE", file.fieldname));
        file.stream.resume(); // drenamos el resto sin guardarlo
        return;
      }
      chunks.push(chunk);
    });
    file.stream.on("end", () => {
      if (failed || done) return;
      uploadTotals.set(req, prior + size);
      finish(null, {
        buffer: Buffer.concat(chunks, size), size,
        encoding: file.encoding, mimetype: file.mimetype,
        originalname: file.originalname, fieldname: file.fieldname
      });
    });
    file.stream.on("error", (err) => finish(err));
  },
  _removeFile(req, file, cb) { cb(null); }
};
const upload = multer({
  storage: limitedMemoryStorage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: MAX_SEND_FILES }
});

// Red de seguridad: la comprobación real ya ocurrió durante el streaming.
const totalUploadBytes = (files) => (files || []).reduce((sum, f) => sum + (f.size || f.buffer?.length || 0), 0);

// El mimetype lo declara el navegador, así que también revisamos la firma del
// archivo. Evita subir un ".png" que en realidad es otro tipo de contenido.
function imageLooksValid(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true; // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  const head = buf.toString("ascii", 0, 6);
  if (head === "GIF87a" || head === "GIF89a") return true; // GIF
  return buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";
}
function mp4LooksValid(buf) {
  return Boolean(buf && buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp");
}

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
// Si se pierde la respuesta HTTP del POST /api/send, un reintento con la misma
// clave devuelve el job original en vez de crear una segunda campaña.
const idempotencyJobs = new Map();
// Cola global: todos los envíos comparten la misma instancia de WhatsApp, así
// que el ritmo por job no alcanza si dos campañas corren en paralelo. Solo el
// primero envía; los demás esperan su turno.
const sendQueue = [];
let sendPumpActive = false;
// Un despliegue o un reinicio no pueden dejar mensajes a medio enviar sin
// registro: el flag se activa al recibir SIGTERM y el job se marca como error.
let shuttingDown = false;
const MAX_QUEUE_SIZE = 3;
const MAX_NETWORK_FAILURES = 3;
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ECONNABORTED", "ERR_NETWORK", "EPROTO"]);
function isNetworkFailure(err) {
  if (!err) return false;
  return NETWORK_CODES.has(String(err.code || "")) ||
    (!err.response && /network|timeout/i.test(String(err.message || "")));
}

// Duración aproximada con los delays configurados. El front la usa para no
// abandonar el seguimiento antes de que termine una campaña grande.
function estimatedJobMs(total) {
  if (total <= 1) return 0;
  const perMessage = SEND_DELAY_MS + SEND_DELAY_JITTER_MS / 2;
  const pauses = SEND_BATCH_SIZE ? Math.floor((total - 1) / SEND_BATCH_SIZE) : 0;
  return Math.round((total - 1) * perMessage + pauses * SEND_BATCH_PAUSE_MS);
}

function createJob(total) {
  const id = crypto.randomUUID();
  const job = {
    id, status: "queued", total, processed: 0, sent: 0, failed: 0,
    results: [], truncated: false, createdAt: new Date().toISOString(),
    queuedAt: new Date().toISOString()
  };
  jobs.set(id, job);
  return job;
}

// Conservamos solo los últimos resultados: el frente solo necesita contadores
// de progreso, y devolver todo el array en cada poll era costoso.
function recordResult(job, entry) {
  job.results.push(entry);
  if (job.results.length > MAX_JOB_RESULTS) {
    job.results.shift();
    job.truncated = true;
  }
}
setInterval(() => {
  // Solo se descartan jobs ya terminados: borrar uno "running" haría que el
  // frente reciba 404 y un reintento generara una segunda campaña.
  const cutoff = Date.now() - 6 * 3600 * 1000;
  for (const [id, job] of jobs) {
    if (job.status !== "done" && job.status !== "error") continue;
    const finished = new Date(job.finishedAt || job.createdAt).getTime();
    if (finished < cutoff) jobs.delete(id);
  }
  for (const [key, jobId] of idempotencyJobs) if (!jobs.has(jobId)) idempotencyJobs.delete(key);
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
  // Un resultado por cliente: en campañas con varias imágenes se agrupan los
  // envíos del mismo destinatario para no repetir filas en el historial.
  const outcomes = new Map();
  const mark = (c, ok, error) => {
    const o = outcomes.get(c.id) || { ok: true, errors: [] };
    if (!ok) {
      o.ok = false;
      if (error) o.errors.push(String(error));
    }
    outcomes.set(c.id, o);
  };
  // Se escribe al terminar cada destinatario, no solo al final: si el proceso
  // se reinicia a mitad de campaña, lo ya enviado queda en el historial.
  const flushContact = (c) => {
    if (!c) return;
    const o = outcomes.get(c.id);
    if (!o) return; // no se intentó enviar: no registramos actividad falsa
    outcomes.delete(c.id);
    addHistory({
      kind: "chat", type, name: c.name, phone: c.phone, ok: o.ok,
      error: o.errors.length ? o.errors.join(" | ") : undefined
    });
  };
  let networkFailures = 0, aborted = false, current = null;
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
      if (current && current.id !== c.id) flushContact(current);
      current = c;
      if (shuttingDown) {
        aborted = true;
        job.status = "error";
        job.error = "El servidor se detuvo durante el envío.";
        break;
      }
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
        networkFailures = 0;
        job.sent++;
        recordResult(job, { name: c.name, phone: c.phone, ok: true });
        mark(c, true);
      } catch (err) {
        const error = evoError(err);
        networkFailures = isNetworkFailure(err) ? networkFailures + 1 : 0;
        job.failed++;
        recordResult(job, { name: c.name, phone: c.phone, ok: false, error });
        mark(c, false, error);
        if (networkFailures >= MAX_NETWORK_FAILURES) {
          aborted = true;
          job.status = "error";
          job.error = `No se pudo contactar con Evolution API tras ${MAX_NETWORK_FAILURES} intentos. Se detuvo el envío para evitar fallos en cadena.`;
        }
      }
      job.processed = i + 1;
      if (aborted) break;
      const wait = nextSendDelay(i, units.length);
      if (wait) await sleep(wait);
    }
    flushContact(current);
    if (!aborted) job.status = "done";
  } catch (e) {
    job.status = "error";
    job.error = evoError(e);
  } finally {
    for (const c of contacts) flushContact(c);
    job.finishedAt = new Date().toISOString();
  }
}

// Espera estimada hasta que arranque un job: lo que queda del envío actual más
// lo que llevan los que ya están en cola. Con `untilId` se calcula solo lo que
// va ANTES de ese job. El front lo usa para no abandonar el seguimiento.
function estimatedQueueWaitMs(untilId = null) {
  let wait = 0;
  for (const job of jobs.values()) {
    if (job.status !== "running" || !job.startedAt) continue;
    const elapsed = Date.now() - new Date(job.startedAt).getTime();
    wait += Math.max(0, estimatedJobMs(job.total) - elapsed);
  }
  for (const pending of sendQueue) {
    if (pending.job.id === untilId) break;
    wait += estimatedJobMs(pending.job.total);
  }
  return Math.round(wait);
}

function jobQueueInfo(job) {
  const index = sendQueue.findIndex((x) => x.job.id === job.id);
  return {
    queued: job.status === "queued",
    queuePosition: index >= 0 ? index + 1 : 0,
    queueWaitMs: job.status === "queued" ? estimatedQueueWaitMs(job.id) : 0
  };
}

function enqueueSend(job, params) {
  sendQueue.push({ job, params });
  if (!sendPumpActive) pumpSendQueue();
}

// Un solo envío activo por instancia. Cualquier error queda registrado en el
// job y el pump sigue con el siguiente para que una campaña mala no bloquee
// toda la cola.
function pumpSendQueue() {
  if (sendPumpActive) return;
  sendPumpActive = true;
  (async () => {
    while (sendQueue.length) {
      const { job, params } = sendQueue.shift();
      if (!jobs.has(job.id)) continue; // expiró mientras esperaba
      job.status = "running";
      job.startedAt = new Date().toISOString();
      try {
        await runSendJob(job, params);
      } catch (e) {
        job.status = "error";
        job.error = evoError(e);
        job.finishedAt = new Date().toISOString();
      }
    }
  })().finally(() => {
    sendPumpActive = false;
    if (sendQueue.length) pumpSendQueue();
  });
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
    connectedConfig: configured(),
    maxSendFiles: MAX_SEND_FILES,
    linkTtlMs: LINK_TTL_MS,
    sendDelayMs: SEND_DELAY_MS,
    sendDelayJitterMs: SEND_DELAY_JITTER_MS,
    sendBatchSize: SEND_BATCH_SIZE,
    sendBatchPauseMs: SEND_BATCH_PAUSE_MS
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

// Valida el texto antes de mandarlo: los límites de WhatsApp son 4096 para
// mensajes de texto y 1024 para pies de imagen/video.
function messageText(value, type) {
  const max = type === "text" ? MAX_TEXT : MAX_CAPTION;
  const raw = String(value ?? "").trim();
  if (raw.length > max) {
    return { error: `El texto supera el límite de ${max} caracteres para ${type === "text" ? "mensajes de texto" : "imágenes y videos"}.` };
  }
  return { text: raw.slice(0, max) };
}

app.get("/api/connection", async (req, res) => {
  if (!configured()) return res.json({ configured: false, connected: false, state: null });
  try {
    const api = evoClient();
    const instance = encodeURIComponent(config.instance);
    const stateRes = await api.get(`/instance/connectionState/${instance}`);
    const state = stateRes.data?.instance?.state || null;
    // Datos de la cuenta vinculada (opcionales): número y nombre de perfil.
    let owner = "", profileName = "";
    try {
      const infoRes = await api.get(`/instance/fetchInstances?instanceName=${instance}`);
      const list = (Array.isArray(infoRes.data) ? infoRes.data : [infoRes.data])
        .map((x) => (x && x.instance ? x.instance : x))
        .filter(Boolean);
      const info = list.find((x) => x.instanceName === config.instance || x.name === config.instance) || list[0] || {};
      owner = String(info.owner || info.ownerJid || info.wuid || info.number || "").replace(/\D/g, "");
      profileName = info.profileName || "";
    } catch { /* los datos de la cuenta no son críticos */ }
    res.json({ configured: true, state, connected: state === "open", instance: config.instance, owner, profileName });
  } catch (e) {
    res.status(200).json({ configured: true, connected: false, state: null, instance: config.instance, error: evoError(e) });
  }
});

// Desvincula (logout) la sesión de WhatsApp de la instancia, sin borrarla.
app.post("/api/disconnect", async (req, res) => {
  if (!configured()) return res.status(400).json({ error: "Falta configurar Evolution API en el archivo .env" });
  const api = evoClient();
  const instance = encodeURIComponent(config.instance);
  try {
    await api.delete(`/instance/logout/${instance}`);
    addHistory({ kind: "connection", ok: true, type: "disconnect", name: "Número desvinculado" });
    return res.json({ ok: true });
  } catch (e) {
    // En Evolution v2.3.7 el logout puede devolver 500 aunque la sesión se haya
    // cerrado (bug interno de Prisma). Confirmamos el estado real antes de fallar.
    try {
      const st = await api.get(`/instance/connectionState/${instance}`);
      if (st.data?.instance?.state !== "open") {
        addHistory({ kind: "connection", ok: true, type: "disconnect", name: "Número desvinculado (recuperado)" });
        return res.json({ ok: true, recovered: true });
      }
    } catch { /* seguimos al error original */ }
    const error = evoError(e);
    addHistory({ kind: "connection", ok: false, type: "disconnect", name: "Desvinculación", error });
    return res.status(502).json({ error });
  }
});

// Pide el QR o el código de vinculación. Si la instancia no existe (404), no la
// crea automáticamente: avisa al front para que pida confirmación y reintente
// con create=true. Así un typo en EVOLUTION_INSTANCE no genera otra sesión.
async function connectOrCreate(api, instanceName, number, allowCreate = false) {
  const instance = encodeURIComponent(instanceName);
  const query = number ? `?number=${encodeURIComponent(number)}` : "";
  try {
    return await api.get(`/instance/connect/${instance}${query}`);
  } catch (e) {
    if (e.response?.status !== 404) throw e;
    if (!allowCreate) return { needsCreate: true };
    const payload = { instanceName, integration: "WHATSAPP-BAILEYS", qrcode: true };
    if (number) payload.number = number;
    return await api.post(`/instance/create`, payload);
  }
}

app.post("/api/connect", async (req, res) => {
  const rawNumber = String(req.body?.number ?? "").trim();
  const allowCreate = req.body?.create === true;
  const link = normalizeLinkNumber(rawNumber, DEFAULT_COUNTRY);
  if (link.error) return res.status(400).json({ error: link.error });
  const kind = rawNumber ? "pairing" : "qr";
  try {
    const r = await connectOrCreate(evoClient(), config.instance, link.number, allowCreate);
    if (r && r.needsCreate) {
      return res.json({ ok: false, needsCreate: true, error: `La instancia "${config.instance}" no existe en Evolution API. ¿Crearla?` });
    }
    addHistory({ kind: "connection", ok: true, type: kind, name: kind === "pairing" ? "Código de vinculación generado" : "QR generado" });
    res.json(connectResponse(r.data || {}));
  } catch (e) {
    const error = evoError(e);
    addHistory({ kind: "connection", ok: false, type: kind, name: kind === "pairing" ? "Código de vinculación" : "QR", error });
    res.status(502).json({ error });
  }
});

app.post("/api/send", upload.array("files", MAX_SEND_FILES), (req, res) => {
  try {
    if (!configured()) return res.status(400).json({ error: "Falta configurar Evolution API en el archivo .env" });
    const { type, text, ids } = req.body;
    // El front envía ids como string JSON dentro de FormData, pero también se
    // acepta un array (clientes JSON) para que el endpoint sea consistente.
    let selectedIds;
    try { selectedIds = Array.isArray(ids) ? ids : JSON.parse(ids || "[]"); } catch { selectedIds = []; }
    if (!Array.isArray(selectedIds)) selectedIds = [];
    selectedIds = selectedIds.filter((x) => typeof x === "string" && x);
    const contacts = store.listContacts().filter(c => selectedIds.includes(c.id) && c.optIn);
    if (!contacts.length) return res.status(400).json({ error: "No hay clientes seleccionados con autorización para recibir promociones." });
    if (!["text", "image", "video"].includes(type)) return res.status(400).json({ error: "Tipo de mensaje no válido." });
    const parsedText = messageText(text, type);
    if (parsedText.error) return res.status(400).json({ error: parsedText.error });
    const cleanText = parsedText.text;
    if (type === "text" && !cleanText) return res.status(400).json({ error: "Escribí un mensaje." });
    const files = req.files || [];
    if (type !== "text" && !files.length) return res.status(400).json({ error: "Adjuntá al menos una imagen o video." });

    // Un reintento con la misma clave no debe duplicar la campaña.
    const idem = req.get("idempotency-key");
    if (idem) {
      const oldId = idempotencyJobs.get(idem);
      const old = oldId && jobs.get(oldId);
      if (old) {
        const wait = estimatedQueueWaitMs(old.id);
        return res.status(202).json({
          jobId: old.id, total: old.total,
          estimatedMs: estimatedJobMs(old.total) + wait,
          reused: true, ...jobQueueInfo(old)
        });
      }
    }

    // Tope de cola: evita acumular campañas que nadie va a esperar y que
    // seguirían ocupando la instancia de WhatsApp durante horas.
    const pendingJobs = sendQueue.length + (sendPumpActive ? 1 : 0);
    if (pendingJobs >= MAX_QUEUE_SIZE) {
      return res.status(429).json({ error: `Hay ${pendingJobs} envíos en curso o en cola. Esperá a que terminen antes de enviar otro.` });
    }

    let media = [];
    if (type !== "text") {
      if (totalUploadBytes(files) > MAX_TOTAL_UPLOAD_MB * 1024 * 1024) {
        return res.status(413).json({ error: `El total de archivos supera el límite de ${MAX_TOTAL_UPLOAD_MB} MB.` });
      }
      for (const f of files) {
        if (type === "image" && !f.mimetype.startsWith("image/")) return res.status(400).json({ error: "Todos los archivos deben ser imágenes." });
        if (type === "video" && f.mimetype !== "video/mp4") return res.status(400).json({ error: "Para video, usá archivos MP4." });
        if (type === "image" && !imageLooksValid(f.buffer)) return res.status(400).json({ error: "Uno de los archivos no es una imagen válida (PNG, JPG, GIF o WebP)." });
        if (type === "video" && !mp4LooksValid(f.buffer)) return res.status(400).json({ error: "Uno de los videos no tiene formato MP4 válido." });
        // Se codifica una sola vez para todos los destinatarios.
        media.push({ mime: f.mimetype, base64: f.buffer.toString("base64"), fileName: cut(f.originalname, 200) });
      }
    }

    const total = type === "text" ? contacts.length : contacts.length * media.length;
    const wait = estimatedQueueWaitMs(); // antes de encolar el job actual
    const queuePosition = sendQueue.length + (sendPumpActive ? 1 : 0);
    const job = createJob(total);
    if (idem) idempotencyJobs.set(idem, job.id);
    res.status(202).json({
      jobId: job.id, total: job.total,
      estimatedMs: estimatedJobMs(total) + wait,
      queued: queuePosition > 0, queuePosition, queueWaitMs: wait
    });
    enqueueSend(job, { type, text: cleanText, contacts, media });
  } catch (e) { res.status(400).json({ error: evoError(e) }); }
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Trabajo no encontrado." });
  res.json({
    id: job.id, status: job.status, total: job.total, processed: job.processed,
    sent: job.sent, failed: job.failed, results: job.results,
    truncated: job.truncated, error: job.error,
    queuedAt: job.queuedAt || null, startedAt: job.startedAt || null,
    ...jobQueueInfo(job)
  });
});

app.post("/api/status", upload.single("file"), async (req, res) => {
  const type = req.body.type;
  try {
    if (!configured()) return res.status(400).json({ error: "Falta configurar Evolution API en el archivo .env" });
    if (!["text", "image", "video"].includes(type)) return res.status(400).json({ error: "Tipo de estado no válido." });
    const parsedText = messageText(req.body.text, type);
    if (parsedText.error) return res.status(400).json({ error: parsedText.error });
    const text = parsedText.text;
    if (type === "text" && !text) return res.status(400).json({ error: "Escribí el texto del estado." });
    if (type !== "text" && !req.file) return res.status(400).json({ error: "Adjuntá una imagen o video." });
    const payload = { type, allContacts: true };
    if (type === "text") {
      payload.content = text;
      payload.backgroundColor = cut(req.body.backgroundColor || "#128C7E", 32) || "#128C7E";
      const font = Number(req.body.font);
      payload.font = Number.isInteger(font) && font >= 1 && font <= 5 ? font : 1;
    } else {
      const mime = req.file.mimetype;
      if (type === "image" && (!mime.startsWith("image/") || !imageLooksValid(req.file.buffer))) return res.status(400).json({ error: "El archivo no parece ser una imagen válida." });
      if (type === "video" && (mime !== "video/mp4" || !mp4LooksValid(req.file.buffer))) return res.status(400).json({ error: "Para estado de video, usá MP4 válido." });
      payload.content = `data:${mime};base64,${req.file.buffer.toString("base64")}`;
      payload.caption = text;
    }
    const r = await evoClient().post(`/message/sendStatus/${encodeURIComponent(config.instance)}`, payload);
    addHistory({ kind: "status", type, ok: true, response: r.data });
    res.json({ ok: true, data: r.data });
  } catch (e) {
    addHistory({ kind: "status", type, ok: false, error: evoError(e) });
    res.status(502).json({ error: evoError(e) });
  }
});

app.get("/api/history", (req, res) => res.json(store.listHistory(req.query.limit)));

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
    if (err.code === "LIMIT_TOTAL_SIZE") {
      return res.status(413).json({ error: `El total de archivos supera el límite de ${MAX_TOTAL_UPLOAD_MB} MB.` });
    }
    const message = err.code === "LIMIT_FILE_SIZE"
      ? `El archivo supera el límite de ${MAX_UPLOAD_MB} MB.`
      : err.code === "LIMIT_FILE_COUNT"
        ? `No podés adjuntar más de ${MAX_SEND_FILES} archivos.`
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
  if (!process.env.PANEL_PASSWORD || PANEL_PASSWORD === "change-me-now") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("PANEL_PASSWORD no configurada: definila antes de iniciar el panel en producción.");
    }
    console.warn("[PromoPanel] Usando contraseña por defecto. Configurá PANEL_PASSWORD en .env antes de exponer el panel.");
  }
}

function installShutdown(server) {
  const stop = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    sendQueue.length = 0;
    for (const job of jobs.values()) {
      if (job.status === "running" || job.status === "queued") {
        job.status = "error";
        job.error = "El servidor se detuvo durante el envío.";
        job.finishedAt = new Date().toISOString();
      }
    }
    const done = () => { store.close(); process.exit(0); };
    server.close(done);
    setTimeout(done, 5000).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (require.main === module) {
  warnConfig();
  const server = app.listen(PORT, () => console.log(`PromoPanel Lite escuchando en puerto ${PORT}`));
  installShutdown(server);
}

// Exponer el store permite a los tests cerrar SQLite antes de borrar su
// DATA_DIR temporal (en Windows un archivo abierto no se puede eliminar).
app.store = store;
module.exports = app;
