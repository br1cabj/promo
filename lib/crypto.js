"use strict";
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Cifrado de campos sensibles (teléfono/DNI) en reposo.
// - AES-256-GCM para confidencialidad e integridad (detecta manipulación).
// - HMAC-SHA256 ("blind index") para poder comparar/buscar por igualdad sin
//   descifrar: la unicidad de teléfono y DNI se apoya en este índice ciego.
// ---------------------------------------------------------------------------

const PREFIX = "v1:";

// Convierte el secreto (env o archivo) en una clave maestra de 32 bytes.
function deriveMasterKey(secret) {
  if (!secret) return null;
  const raw = String(secret).trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const asBase64 = Buffer.from(raw, "base64");
  if (asBase64.length === 32 && raw.replace(/=+$/, "").length >= 42) return asBase64;
  // Cualquier otra cadena: derivamos una clave determinista de 32 bytes.
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

// Subclaves independientes para cifrado y para el índice ciego.
function subKey(master, label) {
  return crypto.createHash("sha256").update(Buffer.concat([master, Buffer.from(label)])).digest();
}

function createCipher(masterKey) {
  const enabled = Boolean(masterKey);
  const aesKey = enabled ? subKey(masterKey, "aes") : null;
  const macKey = enabled ? subKey(masterKey, "hmac") : null;

  function encrypt(value) {
    if (value == null || value === "") return null;
    if (!enabled) return String(value);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
    const body = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, body]).toString("base64");
  }

  function decrypt(payload) {
    if (payload == null || payload === "") return null;
    const raw = String(payload);
    if (!raw.startsWith(PREFIX)) return raw; // datos previos sin cifrar
    if (!enabled) throw new Error("Falta la clave de cifrado para leer los datos.");
    const buf = Buffer.from(raw.slice(PREFIX.length), "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const body = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  }

  function blindIndex(value) {
    if (value == null || value === "") return null;
    if (!enabled) return String(value);
    return crypto.createHmac("sha256", macKey).update(String(value)).digest("hex");
  }

  return { enabled, encrypt, decrypt, blindIndex };
}

module.exports = { deriveMasterKey, createCipher };
