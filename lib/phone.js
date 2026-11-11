"use strict";
const { parsePhoneNumberFromString } = require("libphonenumber-js");

// ---------------------------------------------------------------------------
// Normalización de teléfonos y validación de DNI.
// ---------------------------------------------------------------------------

const cleanDigits = (value) => String(value ?? "").replace(/\D/g, "");

// Devuelve el teléfono en formato canónico (E.164 sin el "+") o null.
// Se intenta primero como número nacional del país por defecto y luego como
// número internacional, para aceptar tanto "3511234567" como "5493511234567".
function normalizePhone(value, defaultCountry = "AR") {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  const candidates = raw.startsWith("+") ? [`+${digits}`] : [digits, `+${digits}`];
  for (const candidate of candidates) {
    try {
      const parsed = parsePhoneNumberFromString(candidate, defaultCountry);
      if (parsed && parsed.isValid()) return parsed.number.replace(/^\+/, "");
    } catch {
      // candidato inválido: probamos el siguiente
    }
  }
  return null;
}

// Respaldo para números que la librería no reconoce pero que igual son
// plausibles (10 a 15 dígitos). Mantiene compatibilidad con datos previos.
function fallbackPhone(value) {
  const digits = cleanDigits(value);
  return /^\d{10,15}$/.test(digits) ? digits : null;
}

// DNI: opcional, solo dígitos, 7 u 8 dígitos. Vacío => null.
function parseDni(value) {
  const digits = cleanDigits(value);
  if (!digits) return { value: null };
  if (digits.length < 7 || digits.length > 8) {
    return { error: "El DNI debe tener 7 u 8 dígitos." };
  }
  return { value: digits };
}

module.exports = { cleanDigits, normalizePhone, fallbackPhone, parseDni };
