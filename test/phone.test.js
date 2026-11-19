"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePhone, fallbackPhone, parseDni } = require("../lib/phone");

test("un móvil argentino es el mismo con o sin el prefijo 9", () => {
  const nacional = normalizePhone("3511234567", "AR");
  const internacional = normalizePhone("+54 9 351 123-4567", "AR");
  const con9 = normalizePhone("93511234567", "AR");
  assert.equal(nacional, "543511234567");
  assert.equal(internacional, nacional);
  assert.equal(con9, nacional);
});

test("un número nacional que empieza con 9 no se interpreta como otro país", () => {
  assert.equal(normalizePhone("91123456789", "AR"), "541123456789");
  assert.equal(normalizePhone("9112345678", "AR"), null);
  // Con "+" explícito sí es un número internacional legítimo (India).
  assert.equal(normalizePhone("+91 12345678", "AR"), "9112345678");
});

test("la normalización respeta DEFAULT_COUNTRY", () => {
  assert.equal(normalizePhone("612345678", "ES"), "34612345678");
  assert.equal(normalizePhone("+34 612 345 678", "AR"), "34612345678");
});

test("el respaldo agrega el código de país cuando falta", () => {
  assert.equal(fallbackPhone("3511234567", "AR"), "543511234567");
  assert.equal(fallbackPhone("5493511234567", "AR"), "5493511234567");
  assert.equal(fallbackPhone("123", "AR"), null);
});

test("DNI opcional de 7 u 8 dígitos", () => {
  assert.deepEqual(parseDni(""), { value: null });
  assert.deepEqual(parseDni("30.123.456"), { value: "30123456" });
  assert.equal(parseDni("123").error, "El DNI debe tener 7 u 8 dígitos.");
});
