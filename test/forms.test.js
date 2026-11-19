"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

// El handler de estos formularios busca el botón con type="submit"; si el HTML
// lo omite, btn es null y el submit falla antes de llamar al API (bug real).
for (const id of ["add-contact", "import-form", "edit-contact"]) {
  test(`#${id} tiene un botón type="submit"`, () => {
    const form = html.match(new RegExp(`<form[^>]*id="${id}"[\\s\\S]*?</form>`));
    assert.ok(form, `falta el formulario #${id}`);
    assert.match(form[0], /<button[^>]*type="submit"/, `falta type="submit" en #${id}`);
  });
}

test("los handlers usan un buscador de botón tolerante", () => {
  assert.match(app, /function submitButton\(form\)/);
  assert.ok(!/(?:e\.target|f)\.querySelector\('button\[type="submit"\]'\)/.test(app), "los handlers no deben buscar solo por type=submit");
  assert.match(app, /const btn=submitButton\(e\.target\)/);
  assert.match(app, /const btn=submitButton\(f\)/);
});
