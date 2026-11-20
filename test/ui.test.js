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
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

test("1. el estado de WhatsApp se ve en Enviar y se actualiza al conectar", () => {
  assert.match(html, /id="send-connection"[^>]*role="status"/);
  assert.ok(html.includes('id="send-connection-dot"'));
  assert.ok(html.includes('id="send-connection-text"'));
  assert.ok(html.includes('data-go="connection"'));
  assert.ok(app.includes("function updateSendConnection(r)"));
  assert.ok(app.includes("updateSendConnection(r);return applyConnection(r,{silent})"));
  assert.ok(app.includes("loadConnection({silent:true})"));
  assert.ok(app.includes("$$(\"[data-go]\").forEach("));
});

test("2. el último envío se guarda y se retoma tras recargar la página", () => {
  assert.ok(app.includes('const LAST_JOB_KEY = "pp-last-job"'));
  assert.ok(app.includes("function saveLastJob(job)"));
  assert.ok(app.includes("function loadLastJob()"));
  assert.ok(app.includes("(async function restoreLastJob()"));
  assert.ok(app.includes('saveLastJob({jobId,total,estimatedMs,status:"running"})'));
  assert.ok(app.includes("monitorJob(saved.jobId,saved.total,saved.estimatedMs)"));
  assert.ok(app.includes("showJobResult(saved)") === false, "debe verificar el job antes de mostrar un resultado guardado");
});

test("3. el ritmo mostrado sale de la configuración real del servidor", () => {
  for (const key of ["sendDelayMs", "sendDelayJitterMs", "sendBatchSize", "sendBatchPauseMs"]) {
    assert.ok(server.includes(`${key}: `), `/api/summary no expone ${key}`);
  }
  assert.ok(html.includes('id="send-pace"'));
  assert.ok(app.includes("function updatePaceHint()"));
  assert.ok(app.includes("sendConfig={sendDelayMs:Number(s.sendDelayMs)||1500"));
  assert.ok(app.includes("updatePaceHint()"));
});

test("4. cambiar a Texto en Estados descarta el archivo anterior", () => {
  const handler = app.match(/\$\("#status-type"\)\.onchange=[^\n]*/);
  assert.ok(handler, "falta el handler de #status-type");
  assert.ok(handler[0].includes('if(isText)$("#status-file").value=""'));
  assert.ok(handler[0].includes('renderFilePreview("status")'));
});

test("5. el seguimiento muestra barra, ETA y los destinatarios fallidos", () => {
  assert.ok(app.includes("function renderJobProgress(j,message)"));
  assert.ok(app.includes('role="progressbar"'));
  assert.ok(app.includes('aria-valuenow="${pct}"'));
  assert.ok(app.includes("function formatDuration(ms)"));
  assert.ok(app.includes("function failedDetails(j)"));
  assert.ok(app.includes("Ver detalle de ${failed.length} fallido"));
  assert.ok(app.includes("j.truncated?'<p class=\"tiny muted\">Mostrando solo los últimos resultados registrados.</p>'"));
  assert.ok(css.includes(".progress-bar{"));
  assert.ok(css.includes(".fail-list{"));
});

test("6. vista previa de archivos en Enviar y en Estados", () => {
  assert.match(html, /id="send-file-preview"[^>]*role="status"/);
  assert.match(html, /id="status-file-preview"[^>]*role="status"/);
  assert.ok(app.includes("function renderFilePreview(which)"));
  assert.ok(app.includes('$("#send-file").onchange=()=>renderFilePreview("send")'));
  assert.ok(app.includes('$("#status-file").onchange=()=>renderFilePreview("status")'));
  assert.ok(app.includes("URL.revokeObjectURL(urls.pop())"));
  assert.ok(css.includes(".file-preview-item img{"));
});

test("7. la confirmación muestra texto, miniaturas y aviso del pie", () => {
  assert.match(html, /id="confirm-modal-detail"[^>]*class="confirm-detail hidden"/);
  assert.ok(app.includes("detail=null}={}"));
  assert.ok(app.includes("lines.map(l=>`<div>${esc(l)}</div>`)"));
  assert.ok(app.includes("confirmObjectUrls.push(u)"));
  assert.ok(app.includes("releaseConfirmUrls()"));
  assert.ok(app.includes("El pie de texto se envía solo con el primer archivo."));
  assert.ok(css.includes(".confirm-thumbs img{"));
});

test("8. el historial se filtra, explica el resultado y puede cargar más", () => {
  assert.ok(html.includes('id="history-search"'));
  assert.ok(html.includes('id="history-kind"'));
  assert.ok(html.includes('id="history-result"'));
  assert.ok(html.includes('id="history-refresh"'));
  assert.ok(html.includes('id="history-summary"'));
  assert.ok(html.includes('id="history-more"'));
  assert.ok(html.includes('role="status" aria-live="polite"'));
  assert.ok(html.includes("<th>Detalle</th>"));
  assert.ok(app.includes("let historyRows = []"));
  assert.ok(app.includes("let historyTotal = 0"));
  assert.ok(app.includes("const HISTORY_PAGE_SIZE = 150"));
  assert.ok(app.includes("function renderHistory()"));
  assert.ok(app.includes('if(kind&&k!==kind)return false'));
  assert.ok(app.includes('if(result==="ok"&&x.ok!==true)return false'));
  assert.ok(app.includes('if(result==="error"&&x.ok!==false)return false'));
  assert.ok(app.includes("historyKind(x)"));
  assert.ok(app.includes("historyTypeLabel(kind,type)"));
  assert.ok(app.includes("Código de vinculación"));
  assert.ok(app.includes("Desvinculación"));
  assert.ok(app.includes('class="history-error"'));
  assert.ok(app.includes('label:"Registrado"'));
  assert.ok(app.includes("Mostrando ${rows.length} de ${total} registros"));
  assert.ok(app.includes('request("/api/history?limit="+nextLimit)'));
  assert.ok(app.includes('Ningún registro coincide con los filtros.'));
  assert.ok(css.includes(".history-tools select{"));
  assert.ok(css.includes(".history-error{"));
  assert.ok(css.includes(".history-detail strong{"));
});

test("9. clientes: formularios plegables, filtro, resumen y acciones con contexto", () => {
  assert.ok(html.includes('id="contact-forms" class="contact-forms"'));
  assert.ok(html.includes("<summary>Agregar o importar clientes</summary>"));
  assert.ok(html.includes('data-go="contacts" data-open-forms'));
  assert.ok(html.includes('<section id="page-contacts"'));
  // La lista va antes que los formularios en el markup.
  assert.ok(html.indexOf('id="contacts-body"') < html.indexOf('id="contact-forms"'));
  assert.ok(html.includes('id="contact-search" type="search"'));
  assert.ok(html.includes('id="contact-search" type="search" placeholder="Buscar nombre, teléfono o DNI..." aria-label="Buscar en los clientes"'));
  assert.ok(html.includes('id="contacts-filter" aria-label="Filtrar clientes por autorización"'));
  assert.ok(html.includes('<option value="ok">Solo autorizados</option>'));
  assert.ok(html.includes('<option value="pending">Sin autorizar</option>'));
  assert.ok(html.includes('id="contacts-summary" class="contacts-summary" role="status" aria-live="polite"'));
  assert.ok(app.includes("function formatPhoneDisplay(phone)"));
  assert.ok(app.includes("if(d.startsWith(\"54\")&&d.length===12)"));
  assert.ok(app.includes("function openContactForms()"));
  assert.ok(app.includes("if(b.dataset.openForms!==undefined){openContactForms();return}"));
  assert.ok(app.includes('let contactFormsAutoOpened = false;'));
  assert.ok(app.includes('if(forms&&!contacts.length&&!contactFormsAutoOpened){forms.open=true;contactFormsAutoOpened=true}'));
  assert.ok(app.includes('if(status==="ok"&&!c.optIn)return false'));
  assert.ok(app.includes('if(status==="pending"&&c.optIn)return false'));
  assert.ok(app.includes("Mostrando ${rows.length} de ${contacts.length} clientes"));
  assert.ok(app.includes(" · ${authorized} autorizados."));
  assert.ok(app.includes('aria-label="Editar a ${esc(name)}"'));
  assert.ok(app.includes('aria-label="Eliminar a ${esc(name)}"'));
  assert.ok(app.includes('class="small-btn danger" data-delete'));
  assert.ok(app.includes("Todavía no cargaste clientes."));
  assert.ok(app.includes("data-empty-add"));
  assert.ok(app.includes("data-clear-filters"));
  assert.ok(app.includes('await askConfirm(`¿Eliminar a ${c.name||"Sin nombre"}'));
  assert.ok(css.includes(".contact-forms>summary{"));
  assert.ok(css.includes(".contacts-summary{"));
  assert.ok(css.includes(".small-btn.danger{"));
});

test("10. Inicio: acciones a la vista, métricas compactas y resumen por destino", () => {
  assert.ok(html.includes('<div class="welcome-mark" aria-hidden="true">'));
  assert.ok(html.includes("<p>Cargá contactos y enviá novedades.</p>"));
  assert.ok(html.includes("<span>AUTORIZADOS</span>"));
  assert.equal((html.match(/class="quick" data-go="/g) || []).length, 5, "cinco acciones rápidas");
  assert.ok(html.includes('class="quick" data-go="history"'));
  assert.ok(html.includes('class="quick" data-go="connection"'));
  assert.ok(html.includes('id="home-notice" class="notice" open'));
  assert.ok(html.includes("<summary>Antes de enviar</summary>"));
  assert.ok(html.includes('id="resume-meta" class="resume-meta" role="list"'));
  assert.ok(html.includes('id="resume-row-send" class="resume-row" role="listitem"'));
  assert.ok(html.includes('id="resume-status-meta" class="resume-row-text"'));
  assert.ok(html.includes('id="resume-send" aria-label="Seguir en Enviar mensaje">Seguir</button>'));
  assert.ok(app.includes("function collapseHomeNotice()"));
  assert.ok(app.includes("collapseHomeNotice();\nloadSummary();"));
  assert.ok(app.includes('const heading=$("#page-"+page+" .section-head h2")'));
  assert.ok(app.includes('heading.setAttribute("tabindex","-1");heading.focus({preventScroll:true})'));
  assert.ok(app.includes('meta.textContent=item?item.label+" · "+item.detail:""'));
  assert.ok(!app.includes('join("  |  ")'), "el resumen ya no separa destinos con |");
  assert.ok(css.includes(".resume-row{display:flex;align-items:center;justify-content:space-between"));
  assert.ok(css.includes(".notice>summary{"));
  assert.ok(css.includes("@media(min-width:1180px){.quick-grid{grid-template-columns:repeat(5,minmax(0,1fr))}}"));
});

test("accesibilidad: resultado anunciable y navegación con aria-current", () => {
  assert.match(html, /id="status-result"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.ok(app.includes('b.setAttribute("aria-current","page")'));
  assert.ok(app.includes('else b.removeAttribute("aria-current")'));
  assert.ok(css.includes(".status-dot.warn{"));
});
