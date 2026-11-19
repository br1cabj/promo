"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, "public", name), "utf8");
const html = read("index.html");
const app = read("app.js");
const css = read("styles.css");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

test("1. la tarjeta de borrador es visible y explica qué se guarda", () => {
  assert.equal((html.match(/class="draft-box" data-draft-for="(send|status)"/g) || []).length, 2);
  assert.equal((html.match(/<strong>Borrador automático<\/strong>/g) || []).length, 2);
  assert.equal((html.match(/role="status" aria-live="polite" aria-atomic="true"/g) || []).length, 2);
  assert.equal((html.match(/Los archivos adjuntos no se guardan\./g) || []).length, 2);
  assert.equal((html.match(/data-draft-time="(send|status)"/g) || []).length, 2);
  assert.equal((html.match(/data-draft-meta="(send|status)"/g) || []).length, 2);
  assert.equal((html.match(/data-draft-retry="(send|status)"/g) || []).length, 2);
  assert.equal((html.match(/>Descartar borrador<\/button>/g) || []).length, 2);
  assert.ok(css.includes(".draft-box{"));
  assert.ok(css.includes(".draft-box.saved{"));
  assert.ok(css.includes(".draft-box.error{"));
  assert.ok(css.includes(".draft-discard:disabled{"));
});

test("2. el JS muestra hora real, meta y reintento del borrador", () => {
  assert.ok(app.includes("function draftTime(iso)"));
  assert.ok(app.includes('hour:"2-digit",minute:"2-digit"'));
  assert.ok(app.includes("function draftMetaText(section,draft)"));
  assert.ok(app.includes('parts.push(n+" destinatario"+(n===1?"":"s"))'));
  assert.ok(app.includes("function paintDraft(section,"));
  assert.ok(app.includes('message:"Guardado automáticamente"'));
  assert.ok(app.includes('message:"No se pudo guardar. Revisá tu conexión.",retry:true'));
  assert.ok(app.includes("function saveDraftNow(section,{silent=false}={})"));
  assert.ok(app.includes("meta:draftMetaText(section,r)"));
  assert.ok(app.includes("$$(\"[data-draft-retry]\").forEach"));
});

test("3. descartar pide confirmación y el borrador se recupera con su hora", () => {
  assert.ok(app.includes('if(!await askConfirm("¿Descartar el borrador y limpiar el formulario?",{title:"Descartar borrador",acceptLabel:"Descartar",danger:true}))return;'));
  assert.ok(app.includes("await request(\"/api/drafts/\"+section,{method:\"DELETE\"})"));
  assert.ok(app.includes('toast("Borrador descartado")'));
  assert.ok(app.includes("applyDraft(d.section,d,{restored:true})"));
  assert.ok(app.includes('restored?(has?"Borrador recuperado de otra sesión"'));
  assert.ok(app.includes("meta:draftMetaText(section,draft)"));
});

test("4. las plantillas tienen bloque propio y modal sin prompt() nativo", () => {
  assert.equal((html.match(/class="template-box" data-template-box="(send|status)"/g) || []).length, 2);
  assert.equal((html.match(/Plantillas guardadas/g) || []).length, 2);
  assert.ok(html.includes('id="template-modal" class="modal hidden"'));
  assert.ok(html.includes('role="dialog" aria-modal="true" aria-labelledby="template-modal-title"'));
  assert.ok(html.includes('id="template-name" type="text" maxlength="60"'));
  assert.ok(html.includes('id="template-form"'));
  assert.ok(html.includes('id="template-cancel"'));
  assert.ok(app.includes("function askText({title="));
  assert.ok(app.includes("function closeTemplate(result)"));
  assert.ok(app.includes("return new Promise(resolve=>{templateResolver=resolve})"));
  assert.ok(!/\bprompt\s*\(/.test(app), "no debe usar prompt() nativo");
  assert.ok(app.includes("const name=await askText({"));
  assert.ok(app.includes("closeTemplate(false)"));
  assert.ok(css.includes(".template-box{"));
});

test("5. después de enviar se conserva el texto y se limpian los destinatarios", () => {
  assert.ok(app.includes("async function resetSendComposer()"));
  assert.ok(app.includes('const text=$(f.text)?.value||""'));
  assert.ok(app.includes("selectedRecipients.clear()"));
  assert.ok(app.includes('await request("/api/drafts/send",{method:"PUT"'));
  assert.ok(app.includes("recipientIds:[]"));
  assert.ok(app.includes('message:"Borrador conservado para reutilizar"'));
  assert.ok(app.includes('toast("Borrador conservado para reutilizar")'));
  assert.ok(!app.includes('await request("/api/drafts/send",{method:"DELETE"})'));
  assert.ok(readme.includes("los **destinatarios se limpian**"));
  assert.ok(readme.includes("Guardado automáticamente"));
  assert.ok(readme.includes("**Reintentar guardado**"));
  assert.ok(readme.includes("sin diálogos nativos del navegador"));
});
