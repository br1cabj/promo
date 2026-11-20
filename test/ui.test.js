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

test("accesibilidad: resultado anunciable y navegación con aria-current", () => {
  assert.match(html, /id="status-result"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.ok(app.includes('b.setAttribute("aria-current","page")'));
  assert.ok(app.includes('else b.removeAttribute("aria-current")'));
  assert.ok(css.includes(".status-dot.warn{"));
});
