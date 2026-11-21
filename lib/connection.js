"use strict";
const { normalizePhone, fallbackPhone } = require("./phone");

// ---------------------------------------------------------------------------
// Lógica pura del flujo de conexión (QR / código de vinculación).
// La mantenemos fuera de server.js para poder probarla sin levantar el panel.
// ---------------------------------------------------------------------------

// Mensaje de error legible a partir de una respuesta de Evolution API (formatos variados).
function evoError(e) {
  const code = String(e?.code || "");
  const raw = String(e?.message || "");
  if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "EPROTO"].includes(code) ||
      /timeout of \d+ms exceeded|network error/i.test(raw)) {
    return "No se pudo contactar con Evolution API. Revisá EVOLUTION_URL y que el servicio esté activo.";
  }
  const status = Number(e?.response?.status || 0);
  if (status === 401 || status === 403) {
    return "Evolution API rechazó la clave de acceso (401/403). Revisá EVOLUTION_API_KEY y sus permisos.";
  }
  const d = e?.response?.data;
  const msg = d?.response?.message || d?.error?.message || d?.message || d?.error || e?.message;
  if (Array.isArray(msg)) return msg.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  if (msg && typeof msg === "object") return JSON.stringify(msg);
  return typeof msg === "string" && msg ? msg : "Error al comunicarse con Evolution API.";
}

// Evolution devuelve el QR en formatos distintos según versión: base64 crudo,
// data URI, objeto {base64}, e incluso SVG. Lo normalizamos a una data URI que
// el navegador pueda mostrar y descargar con la extensión correcta.
function extractQr(data) {
  const raw = data?.base64 ?? data?.qrcode?.base64 ?? data?.qrcode ?? data?.qr ?? null;
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  if (/^data:image\/[a-z0-9.+-]+[;]/i.test(value)) {
    return { src: value, mime: value.slice(5, value.indexOf(";")) };
  }
  if (/^<svg[\s>]/i.test(value)) {
    return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(value)}`, mime: "image/svg+xml" };
  }
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(value)) {
    const compact = value.replace(/\s/g, "");
    let decoded = "";
    try { decoded = Buffer.from(compact, "base64").toString("utf8").slice(0, 200).trim(); } catch { /* no es base64 */ }
    if (/^<svg[\s>]/i.test(decoded)) {
      const svg = Buffer.from(compact, "base64").toString("utf8");
      return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, mime: "image/svg+xml" };
    }
    return { src: `data:image/png;base64,${compact}`, mime: "image/png" };
  }
  return null;
}

// Aplica la misma normalización que a los contactos y valida la longitud que
// espera Evolution. Devuelve { number } o { number: null, error }.
function normalizeLinkNumber(value, defaultCountry = "AR") {
  const raw = String(value ?? "").trim();
  if (!raw) return { number: null };
  let number = normalizePhone(raw, defaultCountry) || fallbackPhone(raw, defaultCountry);
  number = number ? String(number).replace(/\D/g, "") : "";
  if (!number || number.length < 8 || number.length > 15) {
    return { number: null, error: "Ingresá un número válido con código de país (8 a 15 dígitos)." };
  }
  return { number };
}

// Construye la respuesta pública del endpoint. Solo expone lo que el front
// necesita: nunca reenviamos el payload crudo de Evolution (puede incluir
// tokens internos, configuración de la instancia u otros datos sensibles).
function connectResponse(data) {
  const qr = extractQr(data);
  const pairingCode = data?.pairingCode || data?.qrcode?.pairingCode || data?.code || null;
  return {
    ok: true,
    qr: qr ? qr.src : null,
    qrMime: qr ? qr.mime : null,
    pairingCode: pairingCode ? String(pairingCode) : null
  };
}

module.exports = { evoError, extractQr, normalizeLinkNumber, connectResponse };
