"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

// 1, 8, 9, 11: estado inicial del formulario y búsqueda por DNI.
test("el formulario arranca en Solo texto, sin archivos y con resultado anunciable", () => {
  const select = html.match(/<select id="send-type">[\s\S]*?<\/select>/);
  assert.ok(select, "falta #send-type");
  assert.match(select[0], /<option value="text" selected>Solo texto<\/option>/);
  assert.match(html, /<label id="send-file-wrap" class="hidden">/);
  assert.match(html, /id="send-result"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(html, /id="track-job"/);
});

test("la búsqueda de destinatarios incluye el DNI", () => {
  assert.match(app, /const visible=eligible\.filter\(c=>\(c\.name\+" "\+c\.phone\+" "\+\(c\.dni\|\|""\)\)\.toLowerCase\(\)\.includes\(q\)\)/);
});

// 2, 3, 10: archivos en modo texto, límite en el front y confirm con el total real.
test("el cliente no adjunta archivos cuando el tipo es texto", () => {
  assert.match(app, /if\(isText\)\$\("#send-file"\)\.value="";/);
  assert.match(app, /const files=type==="text"\?\[\]:\[\.\.\.\$\("#send-file"\)\.files\]/);
  assert.match(app, /files\.forEach\(f=>fd\.append\("files",f\)\);/);
  const handler = app.match(/\$\("#send-button"\)\.onclick=[\s\S]*?\n\};/);
  assert.ok(handler, "falta el handler de #send-button");
  assert.match(handler[0], /if\(files\.length>maxSendFiles\)/);
  assert.match(handler[0], /const messages=ids\.length\*Math\.max\(1,files\.length\)/);
});

// 4, 5, 6, 7: seguimiento reanudable, idempotencia y limpieza tras enviar.
test("el seguimiento es reanudable, tolera fallos y no muestra éxito falso", () => {
  assert.match(app, /let activeJob = null/);
  assert.match(app, /let monitoringJob = false/);
  assert.match(app, /async function monitorJob\(/);
  assert.match(app, /const deadline=Date\.now\(\)\+Math\.max\(30\*60\*1000,Number\(estimatedMs\|\|0\)\+10\*60\*1000\)/);
  assert.match(app, /errors\+\+;\s*\n\s*delay=Math\.min\(delay\*2,15000\)/);
  assert.match(app, /\$\("#track-job"\)\.onclick=async\(\)=>/);
  assert.match(app, /headers:\{"Idempotency-Key":key\}/);
  assert.ok(!app.includes("Campaña procesada"), "no debe avisar éxito si no se confirmó el job");
  assert.match(app, /async function resetSendComposer\(\)/);
  assert.match(app, /await resetSendComposer\(\);\s*\n\s*showJobResult\(j\)/);
});

// 3, 11: validaciones del servidor (firma, límite de archivos, idempotencia).
test("el servidor valida firma de archivos, límite de cantidad e idempotencia", () => {
  assert.match(server, /function imageLooksValid\(buf\)/);
  assert.match(server, /function mp4LooksValid\(buf\)/);
  assert.match(server, /!imageLooksValid\(f\.buffer\)/);
  assert.match(server, /!mp4LooksValid\(f\.buffer\)/);
  assert.match(server, /err\.code === "LIMIT_FILE_COUNT"/);
  assert.match(server, /const idempotencyJobs = new Map\(\)/);
  assert.match(server, /req\.get\("idempotency-key"\)/);
  assert.match(server, /reused: true/);
  assert.match(server, /estimatedMs: estimatedJobMs\(old\.total\)/);
  assert.match(server, /maxSendFiles: MAX_SEND_FILES/);
});

test("la clave de idempotencia depende del contenido, no del último intento", () => {
  assert.match(app, /function campaignKey\(type, text, ids, files\)/);
  assert.match(app, /const key=campaignKey\(type,\$\("#send-text"\)\.value,ids,files\)/);
  assert.ok(!app.includes("pendingSendKey"), "no debe quedar una clave pendiente reutilizable");
  assert.equal((app.match(/const key=campaignKey\(type/g) || []).length, 1,
    "la clave se calcula una sola vez por envío");
});

test("el front muestra el estado en cola y sigue sondeando", () => {
  assert.match(app, /if\(j\.status==="queued"\)\{/);
  assert.match(app, /En cola \(puesto \$\{j\.queuePosition\|\|1\}\)/);
  assert.match(app, /start\.queued\?`En cola \(puesto \$\{start\.queuePosition\}\)/);
  assert.match(app, /activeJob\.last\.status!=="queued"/);
});

test("el servidor serializa las campañas en una cola global", () => {
  assert.match(server, /const sendQueue = \[\]/);
  assert.match(server, /function pumpSendQueue\(\)/);
  assert.match(server, /function enqueueSend\(job, params\)/);
  assert.match(server, /enqueueSend\(job, \{ type, text: cleanText, contacts, media \}\)/);
  assert.match(server, /id, status: "queued"/);
  assert.match(server, /queuePosition: index >= 0 \? index \+ 1 : 0/);
  assert.match(server, /queueWaitMs: wait/);
  assert.match(server, /estimatedMs: estimatedJobMs\(total\) \+ wait/);
});

test("el progreso conserva el mensaje de cola y el resultado final", () => {
  assert.ok(app.includes('renderJobProgress(j,`En cola (puesto ${j.queuePosition||1})'));
  assert.ok(app.includes('<p class="job-summary">Proceso finalizado. Enviados: ${j.sent}. Fallidos: ${j.failed}.</p>'));
});

test("el chequeo de tamaño total solo aplica a multimedia", () => {
  const send = server.match(/app\.post\("\/api\/send"[\s\S]*?\n\}\);/);
  assert.ok(send, "falta /api/send");
  const mediaBlock = send[0].match(/if \(type !== "text"\) \{[\s\S]*?\n    \}/);
  assert.ok(mediaBlock, "falta el bloque multimedia");
  assert.match(mediaBlock[0], /totalUploadBytes\(files\) > MAX_TOTAL_UPLOAD_MB/);
  const beforeMedia = send[0].split("let media = [];")[0];
  assert.ok(!beforeMedia.includes("totalUploadBytes(files)"), "el tamaño total no debe evaluarse para texto");
});
