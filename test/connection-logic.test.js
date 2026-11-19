"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evoError, extractQr, normalizeLinkNumber, connectResponse } = require("../lib/connection");

test("evoError convierte errores de red en un mensaje accionable", () => {
  assert.equal(
    evoError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:8081" }),
    "No se pudo contactar con Evolution API. Revisá EVOLUTION_URL y que el servicio esté activo."
  );
  assert.equal(
    evoError({ message: "timeout of 5000ms exceeded" }),
    "No se pudo contactar con Evolution API. Revisá EVOLUTION_URL y que el servicio esté activo."
  );
});

test("evoError entiende los formatos de error de Evolution", () => {
  assert.equal(evoError({ response: { data: { message: "Evolution explotó" } } }), "Evolution explotó");
  assert.equal(evoError({ response: { data: { error: { message: "Instancia inválida" } } } }), "Instancia inválida");
  assert.equal(evoError({ response: { data: { response: { message: "Sin permisos" } } } }), "Sin permisos");
  assert.equal(evoError({ response: { data: { message: ["Datos malos", "Revisá el número"] } } }), "Datos malos Revisá el número");
  assert.equal(evoError(new Error("falló")), "falló");
  assert.equal(evoError({}), "Error al comunicarse con Evolution API.");
});

test("extractQr normaliza los formatos conocidos y rechaza los inválidos", () => {
  const png = "iVBORw0KGgo=";
  assert.deepEqual(extractQr({ base64: png }), { src: `data:image/png;base64,${png}`, mime: "image/png" });
  assert.deepEqual(extractQr({ qrcode: { base64: png } }), { src: `data:image/png;base64,${png}`, mime: "image/png" });
  assert.equal(extractQr({ qrcode: { base64: null } }), null);
  assert.equal(extractQr({ base64: "   " }), null);
  assert.equal(extractQr({ base64: "no es base64!!" }), null);

  const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  assert.deepEqual(extractQr({ qrcode: svg }), {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    mime: "image/svg+xml"
  });
  const svgB64 = Buffer.from(svg).toString("base64");
  assert.equal(extractQr({ base64: svgB64 }).mime, "image/svg+xml");

  const uri = "data:image/webp;base64,UklGRiQAAABXRUJQVlA4";
  assert.deepEqual(extractQr({ base64: uri }), { src: uri, mime: "image/webp" });
});

test("normalizeLinkNumber aplica el país por defecto y valida longitud", () => {
  assert.deepEqual(normalizeLinkNumber("3511234567", "AR"), { number: "543511234567" });
  assert.deepEqual(normalizeLinkNumber("+54 9 351 123-4567", "AR"), { number: "543511234567" });
  assert.deepEqual(normalizeLinkNumber("   "), { number: null });
  assert.match(normalizeLinkNumber("123", "AR").error, /8 a 15 dígitos/);
  assert.match(normalizeLinkNumber("12345678901234567890", "AR").error, /8 a 15 dígitos/);
});

test("connectResponse expone solo campos públicos, nunca el payload crudo", () => {
  const response = connectResponse({
    base64: "iVBORw0KGgo=",
    pairingCode: "12345678",
    apiKey: "super-secreto",
    instance: { token: "otro-secreto" },
    webhook: { url: "http://interno" }
  });
  assert.deepEqual(Object.keys(response).sort(), ["ok", "pairingCode", "qr", "qrMime"]);
  assert.equal(response.pairingCode, "12345678");
  assert.equal(response.qrMime, "image/png");
  assert.ok(!JSON.stringify(response).includes("super-secreto"));
  assert.ok(!JSON.stringify(response).includes("otro-secreto"));
  assert.equal(connectResponse({ code: "87654321" }).pairingCode, "87654321");
});
