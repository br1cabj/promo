require("dotenv").config();
const express = require("express");
const basicAuth = require("express-basic-auth");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parse } = require("csv-parse/sync");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA = path.join(__dirname, "data");
const UPLOADS = path.join(__dirname, "uploads");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

const contactsFile = path.join(DATA, "contacts.json");
const historyFile = path.join(DATA, "history.json");
if (!fs.existsSync(contactsFile)) fs.writeFileSync(contactsFile, "[]");
if (!fs.existsSync(historyFile)) fs.writeFileSync(historyFile, "[]");

const readJson = (file, fallback = []) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));
const cleanPhone = (value) => String(value || "").replace(/\D/g, "");
const config = {
  url: (process.env.EVOLUTION_URL || "").replace(/\/+$/, ""),
  key: process.env.EVOLUTION_API_KEY || "",
  instance: process.env.EVOLUTION_INSTANCE || ""
};
const configured = () => Boolean(config.url && config.key && config.instance);
const auth = basicAuth({
  users: { [process.env.PANEL_USER || "admin"]: process.env.PANEL_PASSWORD || "change-me-now" },
  challenge: true,
  realm: "PromoPanel Lite",
  unauthorizedResponse: "Acceso no autorizado"
});
app.use(auth);
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB || 25)) * 1024 * 1024 }
});

function evoClient() {
  if (!configured()) throw new Error("Falta configurar Evolution API en el archivo .env");
  return axios.create({
    baseURL: config.url,
    timeout: 45000,
    headers: { apikey: config.key, "Content-Type": "application/json" }
  });
}
function normalizeContact(row) {
  const name = String(row.name || row.nombre || "").trim();
  const phone = cleanPhone(row.phone || row.telefono || row.celular || row.whatsapp || "");
  const dni = String(row.dni || "").trim();
  const optInRaw = String(row.optin || row.autorizado || row.consentimiento || "").toLowerCase().trim();
  const optIn = ["si", "sí", "yes", "true", "1", "acepta", "autorizado"].includes(optInRaw);
  return { id: crypto.randomUUID(), name, phone, dni, optIn, createdAt: new Date().toISOString() };
}
function addHistory(entry) {
  const history = readJson(historyFile);
  history.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), ...entry });
  writeJson(historyFile, history.slice(0, 1000));
}
function jid(phone) { return cleanPhone(phone) + "@s.whatsapp.net"; }

app.get("/api/summary", (req, res) => {
  const contacts = readJson(contactsFile);
  const history = readJson(historyFile);
  res.json({
    total: contacts.length,
    optedIn: contacts.filter(c => c.optIn).length,
    history: history.length,
    connectedConfig: configured()
  });
});

app.get("/api/contacts", (req, res) => res.json(readJson(contactsFile)));

app.post("/api/contacts", (req, res) => {
  const name = String(req.body.name || "").trim();
  const phone = cleanPhone(req.body.phone);
  if (!phone || phone.length < 8) return res.status(400).json({ error: "Ingresá un teléfono válido con código de país y área." });
  const contacts = readJson(contactsFile);
  if (contacts.some(c => c.phone === phone)) return res.status(409).json({ error: "Ese teléfono ya está registrado." });
  const contact = { id: crypto.randomUUID(), name, phone, dni: String(req.body.dni || "").trim(), optIn: req.body.optIn === true, createdAt: new Date().toISOString() };
  contacts.push(contact); writeJson(contactsFile, contacts);
  res.json(contact);
});

app.patch("/api/contacts/:id", (req, res) => {
  const contacts = readJson(contactsFile);
  const item = contacts.find(c => c.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Cliente no encontrado." });
  if (typeof req.body.optIn === "boolean") item.optIn = req.body.optIn;
  if (typeof req.body.name === "string") item.name = req.body.name.trim();
  writeJson(contactsFile, contacts); res.json(item);
});

app.delete("/api/contacts/:id", (req, res) => {
  const contacts = readJson(contactsFile).filter(c => c.id !== req.params.id);
  writeJson(contactsFile, contacts); res.json({ ok: true });
});

app.post("/api/import", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Seleccioná un archivo CSV." });
  try {
    const rows = parse(req.file.buffer.toString("utf8").replace(/^\uFEFF/, ""), {
      columns: true, skip_empty_lines: true, bom: true, trim: true, relax_column_count: true
    });
    const contacts = readJson(contactsFile);
    const existing = new Set(contacts.map(c => c.phone));
    let added = 0, duplicates = 0, invalid = 0;
    for (const row of rows) {
      const c = normalizeContact(row);
      if (c.phone.length < 8) { invalid++; continue; }
      if (existing.has(c.phone)) { duplicates++; continue; }
      contacts.push(c); existing.add(c.phone); added++;
    }
    writeJson(contactsFile, contacts);
    res.json({ added, duplicates, invalid, total: rows.length });
  } catch (e) { res.status(400).json({ error: "No pude leer el CSV. Revisá que tenga encabezados y esté separado por comas." }); }
});

app.get("/api/connection", async (req, res) => {
  try {
    const api = evoClient();
    const r = await api.get(`/instance/connectionState/${encodeURIComponent(config.instance)}`);
    res.json({ configured: true, data: r.data });
  } catch (e) {
    res.status(200).json({ configured: configured(), error: e.response?.data?.message || e.message });
  }
});

app.post("/api/connect", async (req, res) => {
  try {
    const r = await evoClient().get(`/instance/connect/${encodeURIComponent(config.instance)}`);
    const data = r.data || {};
    const qr = data.base64 || data.qrcode?.base64 || data.qrcode || null;
    res.json({ ok: true, qr, data });
  } catch (e) { res.status(502).json({ error: e.response?.data?.message || e.message }); }
});

app.post("/api/send", upload.single("file"), async (req, res) => {
  try {
    const { type, text, ids } = req.body;
    const selectedIds = JSON.parse(ids || "[]");
    const contacts = readJson(contactsFile).filter(c => selectedIds.includes(c.id) && c.optIn);
    if (!contacts.length) return res.status(400).json({ error: "No hay clientes seleccionados con autorización para recibir promociones." });
    if (!["text", "image", "video"].includes(type)) return res.status(400).json({ error: "Tipo de mensaje no válido." });
    if (type === "text" && !String(text || "").trim()) return res.status(400).json({ error: "Escribí un mensaje." });
    if (type !== "text" && !req.file) return res.status(400).json({ error: "Adjuntá una imagen o video." });

    const api = evoClient();
    const results = [];
    // Envío secuencial para no saturar el servidor ni disparar ráfagas accidentales.
    for (const c of contacts) {
      try {
        let payload, endpoint;
        if (type === "text") {
          endpoint = `/message/sendText/${encodeURIComponent(config.instance)}`;
          payload = { number: c.phone, text: String(text).trim() };
        } else {
          endpoint = `/message/sendMedia/${encodeURIComponent(config.instance)}`;
          const mime = req.file.mimetype;
          if (type === "image" && !mime.startsWith("image/")) throw new Error("El archivo no parece ser una imagen.");
          if (type === "video" && mime !== "video/mp4") throw new Error("Para video, usá un archivo MP4.");
          payload = {
            number: c.phone, mediatype: type, mimetype: mime,
            caption: String(text || "").trim(),
            media: req.file.buffer.toString("base64"),
            fileName: req.file.originalname
          };
        }
        await api.post(endpoint, payload);
        results.push({ name: c.name, phone: c.phone, ok: true });
        addHistory({ kind: "chat", type, name: c.name, phone: c.phone, ok: true });
      } catch (err) {
        results.push({ name: c.name, phone: c.phone, ok: false, error: err.response?.data?.message || err.message });
        addHistory({ kind: "chat", type, name: c.name, phone: c.phone, ok: false, error: err.message });
      }
    }
    res.json({ sent: results.filter(x => x.ok).length, failed: results.filter(x => !x.ok).length, results });
  } catch (e) { res.status(400).json({ error: e.response?.data?.message || e.message }); }
});

app.post("/api/status", upload.single("file"), async (req, res) => {
  try {
    const type = req.body.type;
    const text = String(req.body.text || "").trim();
    if (!["text", "image", "video"].includes(type)) return res.status(400).json({ error: "Tipo de estado no válido." });
    if (type === "text" && !text) return res.status(400).json({ error: "Escribí el texto del estado." });
    if (type !== "text" && !req.file) return res.status(400).json({ error: "Adjuntá una imagen o video." });
    const payload = { type, allContacts: true };
    if (type === "text") {
      payload.content = text;
      payload.backgroundColor = req.body.backgroundColor || "#128C7E";
      payload.font = Number(req.body.font || 1);
    } else {
      const mime = req.file.mimetype;
      if (type === "image" && !mime.startsWith("image/")) throw new Error("El archivo no parece ser una imagen.");
      if (type === "video" && mime !== "video/mp4") throw new Error("Para estado de video, usá MP4.");
      payload.content = `data:${mime};base64,${req.file.buffer.toString("base64")}`;
      payload.caption = text;
    }
    const r = await evoClient().post(`/message/sendStatus/${encodeURIComponent(config.instance)}`, payload);
    addHistory({ kind: "status", type, ok: true, response: r.data });
    res.json({ ok: true, data: r.data });
  } catch (e) {
    addHistory({ kind: "status", type: req.body.type, ok: false, error: e.message });
    res.status(502).json({ error: e.response?.data?.message || e.message });
  }
});

app.get("/api/history", (req, res) => res.json(readJson(historyFile).slice(0, 150)));

app.get("/api/config-public", (req, res) => res.json({
  instance: config.instance, configured: configured(),
  panelUser: process.env.PANEL_USER || "admin"
}));

app.listen(PORT, () => console.log(`PromoPanel Lite escuchando en puerto ${PORT}`));
