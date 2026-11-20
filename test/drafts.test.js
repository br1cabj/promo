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

test("1. borrador y plantillas quedan arriba del toolbar, cerrado por defecto", () => {
  assert.equal((html.match(/class="draft-box" data-draft-for="(send|status)"/g) || []).length, 2);
  assert.equal((html.match(/class="template-box" data-template-box="(send|status)"/g) || []).length, 2);
  const send = html.slice(html.indexOf('<div class="card"><h3>1. Contenido</h3>'), html.indexOf('<div class="card"><h3>2. Destinatarios</h3>'));
  const status = html.slice(html.indexOf('<div class="card narrow">'), html.indexOf("id=\"status-result\""));
  for (const [name, card, sec] of [["Enviar", send, "send"], ["Estados", status, "status"]]) {
    const draft = card.indexOf('data-draft-for="' + sec + '"');
    const templates = card.indexOf('data-template-box="' + sec + '"');
    const format = card.indexOf("format-details");
    const preview = card.indexOf("format-preview");
    assert.ok(draft >= 0 && templates > draft && format > templates && preview > format, name + ": orden " + [draft, templates, format, preview]);
  }
  assert.equal((html.match(/<details class="format-details"><summary>Formato y emojis<\/summary>/g) || []).length, 2);
  assert.ok(!html.includes("<details class=\"format-details\" open>"));
  assert.ok(!app.includes("syncFormatDetails"));
  assert.ok(!html.includes("data-template-for="), "se fue el desplegable de plantillas");
  assert.ok(!html.includes("data-template-save="), "se fue el botón camaleón");
  assert.ok(!html.includes("data-template-delete="));
  assert.ok(!css.includes(".template-line"), "queda CSS del desplegable");
  assert.ok(!css.includes(".draft-line"), "queda CSS muerto del borrador");
});

test("2. la tarjeta de borrador explica qué se guarda sin ruido", () => {
  assert.equal((html.match(/<strong>Borrador automático<\/strong>/g) || []).length, 2);
  assert.equal((html.match(/role="status" aria-live="polite" aria-atomic="true"/g) || []).length, 2);
  assert.equal((html.match(/Los archivos adjuntos no se guardan en el borrador\./g) || []).length, 2);
  assert.equal((html.match(/data-draft-time="(send|status)"/g) || []).length, 2);
  assert.equal((html.match(/data-draft-meta="(send|status)"/g) || []).length, 2);
  assert.equal((html.match(/data-draft-retry="(send|status)"/g) || []).length, 2);
  assert.equal((html.match(/class="secondary small draft-discard hidden"/g) || []).length, 2);
  assert.equal((html.match(/class="draft-time hidden" data-draft-time="(send|status)"/g) || []).length, 2);
  assert.equal((html.match(/class="draft-note hidden" data-draft-note="(send|status)"/g) || []).length, 2);
  assert.ok(css.includes(".draft-note{") && css.includes("font-size:12px"));
  assert.ok(css.includes(".draft-box.saved{") && css.includes(".draft-box.error{"));
  assert.ok(app.includes("noteEl.classList.toggle(\"hidden\",type===\"text\")"), "aviso de adjuntos solo si aplica");
  assert.ok(app.includes("discard.classList.toggle(\"hidden\",!has);discard.disabled=!has"));
  assert.ok(app.includes("time.classList.toggle(\"hidden\",!when)"));
  assert.ok(app.includes('function draftTime(iso){if(!iso)return "";'));
});

test("3. el borrador deja rastro en la navegación y en el Inicio", () => {
  assert.equal((html.match(/data-draft-badge="(send|status)"/g) || []).length, 2);
  assert.ok(html.includes('id="resume-card" class="resume-card hidden"'));
  assert.ok(html.includes("Continuar donde lo dejaste"));
  assert.ok(html.includes('id="resume-send"'));
  assert.ok(html.includes('id="resume-status"'));
  assert.ok(app.includes("function updateDraftBadges()"));
  assert.ok(app.includes("function updateResumeCard()"));
  assert.ok(app.includes("if(name===\"home\")updateResumeCard();"));
  assert.ok(app.includes("updateDraftBadges();") && app.includes("updateResumeCard();"));
  assert.ok(css.includes(".nav-badge{") && css.includes(".resume-card{"));
  assert.ok(readme.includes("Continuar donde lo dejaste"));
});

test("4. las plantillas son una lista legible con acciones separadas", () => {
  assert.equal((html.match(/class="template-list" data-template-list="(send|status)"/g) || []).length, 2);
  assert.equal((html.match(/data-template-new="(send|status)"/g) || []).length, 2);
  assert.equal((html.match(/data-template-empty="(send|status)"/g) || []).length, 2);
  assert.equal((html.match(/Disponibles también en Enviar y Estados\./g) || []).length, 2);
  assert.ok(app.includes("function templateSnippet(text)"));
  assert.ok(app.includes("function renderTemplates(sec)"));
  assert.ok(app.includes('data-template-action="use"') && app.includes('data-template-action="rename"'));
  assert.ok(app.includes('data-template-action="update"') && app.includes('data-template-action="delete"'));
  assert.ok(app.includes('<span class="template-inuse">En uso</span>'));
  assert.ok(app.includes('empty.classList.toggle("hidden",items.length>0)'));
  assert.ok(app.includes('$$("div.template-list[data-template-list]").forEach('), "un solo listener por lista");
  assert.ok(css.includes(".template-list{") && css.includes(".template-item{") && css.includes(".template-snippet{"));
  assert.ok(css.includes(".template-empty{") && css.includes(".template-hint{"));
});

test("5. aplicar reemplaza con confirmación y deshacer; el modal muestra vista previa", () => {
  assert.ok(html.includes('id="template-modal-preview"'));
  assert.ok(app.includes("acceptLabel=\"Guardar\",preview=\"\""));
  assert.ok(app.includes("p.textContent=preview||\"\""));
  assert.ok(app.includes("reemplaza el texto que estás escribiendo. ¿Aplicarla?"));
  assert.ok(app.includes('title:"Aplicar plantilla"'));
  assert.ok(app.includes('toast("Plantilla aplicada",{label:"Deshacer"'));
  assert.ok(app.includes("prevSelected=selectedTemplate[sec]"));
  assert.ok(app.includes("closeTemplate(false)"));
  assert.ok(!/\bprompt\s*\(/.test(app), "no debe usar prompt() nativo");
  assert.ok(!/\bconfirm\s*\(/.test(app), "no debe usar confirm() nativo");
  assert.ok(!html.includes("data-template-for="));
  assert.ok(readme.includes("sin diálogos nativos del navegador"));
});

test("6. crear, renombrar, actualizar y eliminar piden confirmación accesible", () => {
  assert.ok(app.includes("async function newTemplate(sec)"));
  assert.ok(app.includes("async function renameTemplate(sec,t)"));
  assert.ok(app.includes("async function updateTemplateFromComposer(sec,t)"));
  assert.ok(app.includes("async function deleteTemplate(sec,t)"));
  assert.ok(app.includes("askText({title:\"Nueva plantilla\""));
  assert.ok(app.includes("askText({title:\"Renombrar plantilla\""));
  assert.ok(app.includes("title:\"Actualizar plantilla\""));
  assert.ok(app.includes("title:\"Eliminar plantilla\""));
  assert.ok(app.includes("({use:useTemplate,rename:renameTemplate,update:updateTemplateFromComposer,delete:deleteTemplate})"));
  assert.ok(app.includes('$$("[data-template-new]").forEach('));
  assert.ok(readme.includes("Renombrar") && readme.includes("Actualizar") && readme.includes("Eliminar"));
});

test("7. después de enviar se conserva el texto y se limpian los destinatarios", () => {
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
});
