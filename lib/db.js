"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { deriveMasterKey, createCipher } = require("./crypto");
const { normalizePhone, fallbackPhone, parseDni } = require("./phone");

// ---------------------------------------------------------------------------
// Almacén de datos sobre SQLite (node:sqlite, sin dependencias nativas).
// - contacts: teléfono y DNI cifrados + índices ciegos (HMAC) para unicidad.
// - history:  últimos MAX_HISTORY registros de actividad.
// ---------------------------------------------------------------------------

const MAX_NAME = 120;
const MAX_HISTORY = 1000;
const MAX_DRAFT_TEXT = 8000;
const DRAFT_SECTIONS = new Set(["send", "status"]);
const cut = (value, max) => String(value ?? "").trim().slice(0, max);

class StoreError extends Error {
  constructor(message, status = 400, code = "invalid") {
    super(message);
    this.name = "StoreError";
    this.status = status;
    this.code = code;
  }
}

function readJsonArray(file, onWarn) {
  if (!fs.existsSync(file)) return [];
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    onWarn(`No pude leer ${path.basename(file)}: ${e.message}`);
    return [];
  }
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(file, backup); } catch {}
    onWarn(`${path.basename(file)} estaba dañado (${e.message}). Copia guardada como ${path.basename(backup)}.`);
    return [];
  }
}

// Carga la clave de cifrado: primero ENCRYPTION_KEY, luego data/.key.
// Si no existe ninguna, genera una nueva y avisa por consola.
function loadMasterKey(dir, envKey, onWarn) {
  if (envKey && String(envKey).trim()) return deriveMasterKey(envKey);
  const keyFile = path.join(dir, ".key");
  try {
    if (fs.existsSync(keyFile)) {
      const stored = fs.readFileSync(keyFile, "utf8").trim();
      if (stored) return deriveMasterKey(stored);
    }
    const generated = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, generated.toString("hex"), { mode: 0o600 });
    onWarn(`Generé una clave de cifrado nueva en ${path.join(path.basename(dir), ".key")}. Guardala: sin ella no se pueden leer los datos cifrados.`);
    return generated;
  } catch (e) {
    onWarn(`No pude preparar la clave de cifrado (${e.message}). Los datos sensibles quedarán sin cifrar.`);
    return null;
  }
}

function createStore({ dir, encryptionKey, defaultCountry = "AR", logger = console } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const warn = (msg) => logger.warn(`[PromoPanel] ${msg}`);
  const cipher = createCipher(loadMasterKey(dir, encryptionKey, warn));

  const db = new DatabaseSync(path.join(dir, "promopanel.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      phone TEXT,
      phone_hash TEXT NOT NULL UNIQUE,
      dni TEXT,
      dni_hash TEXT UNIQUE,
      opt_in INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      kind TEXT,
      type TEXT,
      name TEXT,
      phone TEXT,
      ok INTEGER,
      error TEXT,
      response TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS drafts (
      section TEXT PRIMARY KEY,
      text TEXT,
      type TEXT,
      recipient_ids TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  const q = {
    listContacts: db.prepare("SELECT * FROM contacts ORDER BY rowid ASC"),
    getContact: db.prepare("SELECT * FROM contacts WHERE id = ?"),
    byPhoneHash: db.prepare("SELECT id FROM contacts WHERE phone_hash = ?"),
    byDniHash: db.prepare("SELECT id FROM contacts WHERE dni_hash = ?"),
    insertContact: db.prepare(
      "INSERT INTO contacts (id, name, phone, phone_hash, dni, dni_hash, opt_in, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ),
    updateContact: db.prepare(
      "UPDATE contacts SET name = ?, phone = ?, phone_hash = ?, dni = ?, dni_hash = ?, opt_in = ? WHERE id = ?"
    ),
    deleteContact: db.prepare("DELETE FROM contacts WHERE id = ?"),
    countContacts: db.prepare("SELECT COUNT(*) AS n FROM contacts"),
    countOptedIn: db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE opt_in = 1"),
    countHistory: db.prepare("SELECT COUNT(*) AS n FROM history"),
    insertHistory: db.prepare(
      "INSERT INTO history (id, at, kind, type, name, phone, ok, error, response) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ),
    pruneHistory: db.prepare(
      "DELETE FROM history WHERE rowid NOT IN (SELECT rowid FROM history ORDER BY rowid DESC LIMIT ?)"
    ),
    listHistory: db.prepare("SELECT * FROM history ORDER BY rowid DESC LIMIT ?"),
    getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
    setMeta: db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    getDraft: db.prepare("SELECT * FROM drafts WHERE section = ?"),
    listDrafts: db.prepare("SELECT * FROM drafts ORDER BY section ASC"),
    upsertDraft: db.prepare(
      "INSERT INTO drafts (section, text, type, recipient_ids, updated_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(section) DO UPDATE SET text = excluded.text, type = excluded.type, recipient_ids = excluded.recipient_ids, updated_at = excluded.updated_at"
    ),
    deleteDraft: db.prepare("DELETE FROM drafts WHERE section = ?")
  };

  function rowToContact(row) {
    return {
      id: row.id,
      name: row.name,
      phone: cipher.decrypt(row.phone) || "",
      dni: cipher.decrypt(row.dni) || "",
      optIn: Boolean(row.opt_in),
      createdAt: row.created_at
    };
  }

  function rowToHistory(row) {
    let response = null;
    if (row.response) {
      try { response = JSON.parse(row.response); } catch { response = row.response; }
    }
    return {
      id: row.id,
      at: row.at,
      kind: row.kind,
      type: row.type,
      name: row.name,
      phone: cipher.decrypt(row.phone) || "",
      ok: row.ok == null ? undefined : Boolean(row.ok),
      error: row.error || undefined,
      response: response || undefined
    };
  }

  function rowToDraft(row) {
    let recipientIds = [];
    if (row.recipient_ids) {
      try {
        const parsed = JSON.parse(row.recipient_ids);
        if (Array.isArray(parsed)) recipientIds = parsed.filter((x) => typeof x === "string" && x);
      } catch { recipientIds = []; }
    }
    return {
      section: row.section,
      text: cipher.decrypt(row.text) || "",
      type: ["text", "image", "video"].includes(row.type) ? row.type : "text",
      recipientIds,
      updatedAt: row.updated_at
    };
  }

  function addContact(input = {}) {
    const name = cut(input.name, MAX_NAME);
    const phone = normalizePhone(input.phone, defaultCountry) || fallbackPhone(input.phone);
    if (!phone) {
      throw new StoreError("Ingresá un teléfono válido con código de país y área (10 a 15 dígitos).", 400, "phone");
    }
    const phoneHash = cipher.blindIndex(phone);
    if (q.byPhoneHash.get(phoneHash)) {
      throw new StoreError("Ese teléfono ya está registrado.", 409, "phone_duplicate");
    }

    const strictDni = input.strictDni !== false;
    const parsed = parseDni(input.dni);
    let dniValue = null;
    if (parsed.error) {
      if (strictDni) throw new StoreError(parsed.error, 400, "dni");
    } else {
      dniValue = parsed.value;
    }

    let dniHash = null;
    if (dniValue) {
      dniHash = cipher.blindIndex(dniValue);
      if (q.byDniHash.get(dniHash)) {
        if (strictDni) throw new StoreError("Ese DNI ya está registrado.", 409, "dni_duplicate");
        dniValue = null;
        dniHash = null;
      }
    }

    const contact = {
      id: input.id || crypto.randomUUID(),
      name,
      phone,
      dni: dniValue || "",
      optIn: input.optIn === true,
      createdAt: input.createdAt || new Date().toISOString()
    };
    q.insertContact.run(
      contact.id,
      contact.name,
      cipher.encrypt(contact.phone),
      phoneHash,
      dniValue ? cipher.encrypt(dniValue) : null,
      dniHash,
      contact.optIn ? 1 : 0,
      contact.createdAt
    );
    return contact;
  }

  // Actualiza los campos provistos en `patch`. Los campos ausentes se conservan.
  // El teléfono se normaliza y tanto teléfono como DNI se validan y comprueban
  // contra su índice ciego (se ignora el propio contacto) para evitar duplicados.
  function updateContact(id, patch = {}) {
    const row = q.getContact.get(id);
    if (!row) return null;

    const name = typeof patch.name === "string" ? cut(patch.name, MAX_NAME) : row.name;
    const optIn = typeof patch.optIn === "boolean" ? (patch.optIn ? 1 : 0) : row.opt_in;

    let phone = row.phone;
    let phoneHash = row.phone_hash;
    if (Object.prototype.hasOwnProperty.call(patch, "phone")) {
      const normalized = normalizePhone(patch.phone, defaultCountry) || fallbackPhone(patch.phone);
      if (!normalized) {
        throw new StoreError("Ingresá un teléfono válido con código de país y área (10 a 15 dígitos).", 400, "phone");
      }
      const nextHash = cipher.blindIndex(normalized);
      const existing = q.byPhoneHash.get(nextHash);
      if (existing && existing.id !== id) {
        throw new StoreError("Ese teléfono ya está registrado.", 409, "phone_duplicate");
      }
      phone = cipher.encrypt(normalized);
      phoneHash = nextHash;
    }

    let dni = row.dni;
    let dniHash = row.dni_hash;
    if (Object.prototype.hasOwnProperty.call(patch, "dni")) {
      const parsed = parseDni(patch.dni);
      if (parsed.error) throw new StoreError(parsed.error, 400, "dni");
      if (!parsed.value) {
        dni = null;
        dniHash = null;
      } else {
        const nextHash = cipher.blindIndex(parsed.value);
        const existing = q.byDniHash.get(nextHash);
        if (existing && existing.id !== id) {
          throw new StoreError("Ese DNI ya está registrado.", 409, "dni_duplicate");
        }
        dni = cipher.encrypt(parsed.value);
        dniHash = nextHash;
      }
    }

    q.updateContact.run(name, phone, phoneHash, dni, dniHash, optIn, id);
    return rowToContact({ ...row, name, phone, phone_hash: phoneHash, dni, dni_hash: dniHash, opt_in: optIn });
  }

  function deleteContact(id) {
    return q.deleteContact.run(id).changes > 0;
  }

  function listContacts() {
    return q.listContacts.all().map(rowToContact);
  }

  function counts() {
    return {
      total: Number(q.countContacts.get().n),
      optedIn: Number(q.countOptedIn.get().n),
      history: Number(q.countHistory.get().n)
    };
  }

  function addHistory(entry = {}) {
    q.insertHistory.run(
      entry.id || crypto.randomUUID(),
      entry.at || new Date().toISOString(),
      entry.kind ?? null,
      entry.type ?? null,
      entry.name ?? null,
      entry.phone ? cipher.encrypt(entry.phone) : null,
      entry.ok == null ? null : (entry.ok ? 1 : 0),
      entry.error ?? null,
      entry.response == null ? null : JSON.stringify(entry.response)
    );
    q.pruneHistory.run(MAX_HISTORY);
  }

  function listHistory(limit = 150) {
    const n = Math.max(1, Math.min(Number(limit) || 150, MAX_HISTORY));
    return q.listHistory.all(n).map(rowToHistory);
  }

  // Borradores de redacción (texto, tipo y destinatarios), uno por sección
  // ("send" o "status"). El texto se cifra igual que el teléfono/DNI. No se
  // guardan adjuntos: solo el estado de redacción.
  function getDraft(section) {
    if (!DRAFT_SECTIONS.has(section)) return null;
    const row = q.getDraft.get(section);
    return row ? rowToDraft(row) : null;
  }

  function listDrafts() {
    return q.listDrafts.all().map(rowToDraft);
  }

  function saveDraft(section, input = {}) {
    if (!DRAFT_SECTIONS.has(section)) {
      throw new StoreError("Sección de borrador no válida.", 400, "draft_section");
    }
    const text = cut(input.text, MAX_DRAFT_TEXT);
    const type = ["text", "image", "video"].includes(input.type) ? input.type : "text";
    const ids = Array.isArray(input.recipientIds)
      ? [...new Set(input.recipientIds.filter((x) => typeof x === "string" && x))].slice(0, 5000)
      : [];
    // Un borrador totalmente vacío no se guarda: se elimina.
    if (!text && !ids.length) {
      q.deleteDraft.run(section);
      return { section, text: "", type, recipientIds: [], updatedAt: new Date().toISOString(), cleared: true };
    }
    const updatedAt = new Date().toISOString();
    q.upsertDraft.run(section, cipher.encrypt(text), type, JSON.stringify(ids), updatedAt);
    return { section, text, type, recipientIds: ids, updatedAt };
  }

  function deleteDraft(section) {
    if (!DRAFT_SECTIONS.has(section)) return false;
    return q.deleteDraft.run(section).changes > 0;
  }

  // Importa los datos del formato anterior (JSON) si la base está vacía.
  // Los archivos JSON NO se borran: quedan como respaldo. Un marcador evita
  // reimportarlos si más adelante el usuario borra todos los contactos.
  function importLegacy(legacyDir = dir) {
    const result = { contacts: 0, history: 0, skipped: 0 };
    if (q.getMeta.get("legacy_imported")) return result;
    if (Number(q.countContacts.get().n) > 0) {
      q.setMeta.run("legacy_imported", new Date().toISOString());
      return result;
    }
    const contacts = readJsonArray(path.join(legacyDir, "contacts.json"), warn);
    for (const c of contacts) {
      try {
        addContact({
          name: c.name,
          phone: c.phone,
          dni: c.dni,
          optIn: c.optIn === true,
          strictDni: false,
          id: c.id,
          createdAt: c.createdAt
        });
        result.contacts++;
      } catch {
        result.skipped++;
      }
    }
    const history = readJsonArray(path.join(legacyDir, "history.json"), warn);
    for (const h of history) {
      addHistory(h);
      result.history++;
    }
    q.setMeta.run("legacy_imported", new Date().toISOString());
    return result;
  }

  function close() {
    try { db.close(); } catch {}
  }

  // Comprueba que la clave actual pueda descifrar los datos existentes.
  function verifyDecryption() {
    try {
      const row = db.prepare("SELECT phone, dni FROM contacts LIMIT 1").get();
      if (!row) return true;
      cipher.decrypt(row.phone);
      cipher.decrypt(row.dni);
      return true;
    } catch {
      return false;
    }
  }

  return {
    cipherEnabled: cipher.enabled,
    addContact,
    updateContact,
    deleteContact,
    listContacts,
    counts,
    addHistory,
    listHistory,
    getDraft,
    listDrafts,
    saveDraft,
    deleteDraft,
    importLegacy,
    verifyDecryption,
    close
  };
}

module.exports = { createStore, StoreError };
