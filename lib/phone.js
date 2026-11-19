"use strict";
const { parsePhoneNumberFromString, getCountryCallingCode } = require("libphonenumber-js");

// ---------------------------------------------------------------------------
// Normalización de teléfonos y validación de DNI.
// ---------------------------------------------------------------------------

const cleanDigits = (value) => String(value ?? "").replace(/\D/g, "");

// Argentina tiene dos formas de escribir el mismo móvil: con el "9" (formato
// internacional, +54 9 ...) y sin él (formato nacional, 351 ...). Unificamos a
// la forma sin el "9" para que ambas produzcan el mismo valor canónico y, por
// lo tanto, el mismo índice ciego de duplicados.
function canonicalPhone(e164, country) {
  const number = String(e164 || "").replace(/^\+/, "");
  if (country === "AR" && number.startsWith("54")) {
    const rest = number.slice(2);
    if (/^9\d{10}$/.test(rest)) return "54" + rest.slice(1);
  }
  return number;
}

// Devuelve el teléfono en formato canónico (E.164 sin el "+") o null.
// Nunca se prueba un "+" genérico sobre los dígitos: eso haría que un número
// local argentino que empieza con 9 se interprete como India (+91). Para
// números internacionales se exige el "+" explícito, o bien que los dígitos
// empiecen con el código del país por defecto.
function normalizePhone(value, defaultCountry = "AR") {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  let callingCode = "";
  try { callingCode = getCountryCallingCode(defaultCountry); } catch { /* país inválido */ }

  const candidates = raw.startsWith("+")
    ? [`+${digits}`]
    : [digits, `+${digits}`, callingCode ? `+${callingCode}${digits}` : ""];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = parsePhoneNumberFromString(candidate, defaultCountry);
      if (!parsed || !parsed.isValid()) continue;
      // Un número sin "+" solo se acepta como internacional si pertenece al
      // país configurado; si no, se descarta para no cambiarle el país.
      if (!raw.startsWith("+") && candidate === `+${digits}` && parsed.country !== defaultCountry) continue;
      return canonicalPhone(parsed.number, parsed.country || defaultCountry);
    } catch {
      // candidato inválido: probamos el siguiente
    }
  }
  return null;
}

// Respaldo para números que la librería no reconoce pero que igual son
// plausibles (10 a 15 dígitos). Si no traen el código de país, se lo agregamos
// para no guardar un número local que luego no sirva para WhatsApp.
function fallbackPhone(value, defaultCountry = "AR") {
  const digits = cleanDigits(value);
  if (!/^\d{10,15}$/.test(digits)) return null;
  try {
    const code = getCountryCallingCode(defaultCountry);
    if (code && !digits.startsWith(code)) return code + digits;
  } catch { /* país inválido: se guarda tal cual */ }
  return digits;
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
