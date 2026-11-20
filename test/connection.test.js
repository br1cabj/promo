"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

test("el servidor delega la normalización al módulo puro", () => {
  assert.match(server, /require\("\.\/lib\/connection"\)/);
  assert.match(server, /const link = normalizeLinkNumber\(rawNumber, DEFAULT_COUNTRY\)/);
  assert.match(server, /if \(link\.error\) return res\.status\(400\)/);
  assert.ok(html.includes('id="connect-phone"'), "falta #connect-phone");
  assert.ok(html.includes('pattern="[0-9+()\\s-]{8,20}" maxlength="20"'), "falta patrón y límite de longitud");
});

test("un 404 no crea la instancia sin confirmación", () => {
  const fn = server.match(/async function connectOrCreate\([\s\S]*?\n\}/);
  assert.ok(fn, "falta connectOrCreate");
  assert.match(fn[0], /allowCreate = false/);
  assert.match(fn[0], /if \(!allowCreate\) return \{ needsCreate: true \}/);
  assert.match(fn[0], /if \(e\.response\?\.status !== 404\) throw e/);
  assert.match(app, /if\(r\.needsCreate\)\{\s*\n\s*if\(!await askConfirm\(r\.error\|\|"La instancia no existe\. ¿Crearla\?",\{title:"Crear instancia"/);
  assert.match(app, /create:true/);
  assert.ok(!server.includes("if (e.response?.status !== 404) throw e;\n    const payload"), "no debe crear automáticamente");
});

test("el front usa la versión pública del QR y avisa si no hay imagen", () => {
  assert.match(server, /res\.json\(connectResponse\(r\.data \|\| \{\}\)\)/);
  assert.match(app, /dl\.download="whatsapp-qr\."\+\(r\.qrMime==="image\/svg\+xml"\?"svg":"png"\)/);
  assert.match(app, /if\(!r\.qr\)\{hideLinkBoxes\(\);toast\("Evolution API no devolvió un QR/);
});

test("el endpoint no reenvía el payload crudo de Evolution", () => {
  const endpoint = server.match(/app\.post\("\/api\/connect"[\s\S]*?\n\}\);/);
  assert.ok(endpoint, "falta /api/connect");
  assert.match(endpoint[0], /connectResponse\(r\.data \|\| \{\}\)/);
  assert.ok(!/\bdata:\s*data\b/.test(endpoint[0]), "no debe devolver data cruda");
  assert.ok(!/^\s*data\s*,\s*$/m.test(endpoint[0]), "no debe devolver data cruda");
});

test("los errores amigables vienen del módulo compartido", () => {
  assert.match(server, /const \{ evoError, normalizeLinkNumber, connectResponse \} = require\("\.\/lib\/connection"\)/);
});

test("sin configuración el front avisa y no sugiere vincular", () => {
  assert.match(server, /if \(!configured\(\)\) return res\.json\(\{ configured: false, connected: false, state: null \}\)/);
  assert.match(app, /if\(r\.configured===false\)\{\s*\n\s*title\.textContent="Evolution API sin configurar"/);
  assert.match(app, /detail\.textContent="Configurá EVOLUTION_URL, EVOLUTION_API_KEY y EVOLUTION_INSTANCE en el servidor\."/);
});

test("hay polling, countdown y ocultado al conectar", () => {
  assert.match(server, /linkTtlMs: LINK_TTL_MS/);
  assert.match(app, /if\(Number\(s\.linkTtlMs\)>0\)linkTtlMs=Number\(s\.linkTtlMs\)/);
  assert.match(app, /let connectionWatch = null/);
  assert.match(app, /function startConnectionWatch\(\)/);
  assert.match(app, /if\(connectionPollTick%5===0\)await loadConnection\(\{silent:true\}\)/);
  assert.match(app, /function updateLinkCountdown\(\)/);
  assert.match(app, /toast\(was==="qr"\?"El QR venció\. Generá uno nuevo\.":"El código venció\. Generá uno nuevo\."\)/);
  assert.match(app, /if\(connected\)\{\s*\n\s*const hadLink=!!linkKind;\s*\n\s*hideLinkBoxes\(\);stopConnectionWatch\(\);/);
  assert.match(app, /if\(name==="connection"\)loadConnection\(\);else stopConnectionWatch\(\)/);
  assert.match(html, /id="qr-expiry" class="muted"/);
  assert.match(html, /id="pairing-expiry"/);
});

test("los botones se deshabilitan y se registra la auditoría", () => {
  assert.match(app, /async function requestConnect\(payload,button\)/);
  assert.match(app, /if\(button\.disabled\)return null/);
  assert.match(app, /button\.disabled=true;button\.textContent="Generando\.\.\."/);
  assert.match(app, /\}\s*finally\{button\.disabled=false;button\.textContent=original\}/);
  assert.match(server, /kind: "connection"/);
  assert.match(server, /type: "disconnect", name: "Número desvinculado"/);
  assert.match(app, /function historyKindLabel\(kind\)\{return kind==="message"\?"Mensaje":kind==="status"\?"Estado":"Conexión"\}/);
});

test("los confirms nativos se reemplazan por un modal accesible", () => {
  assert.ok(!/window\.confirm\s*\(/.test(app), "no debe usar window.confirm");
  assert.ok(!/if\(!confirm\(/.test(app), "no debe usar confirm() directo");
  assert.ok(!/\bprompt\s*\(/.test(app), "no debe usar prompt() nativo");
  assert.ok(html.includes('id="confirm-modal" class="modal hidden"'), "falta #confirm-modal");
  assert.match(html, /role="alertdialog" aria-modal="true" aria-labelledby="confirm-modal-title" aria-describedby="confirm-modal-message"/);
  assert.match(html, /id="confirm-accept"/);
  assert.match(app, /function askConfirm\(message/);
  assert.match(app, /function closeConfirm\(result\)/);
  assert.match(app, /if\(ev\.key==="Escape"\)\{closeEmojiPanels\(\);closeEdit\(\);closeConfirm\(false\);closeTemplate\(false\);closeNav\(true\)\}/);
  assert.equal((app.match(/await askConfirm\(/g) || []).length, 9, "debe reemplazar los 9 confirms (incluye plantillas y borrado de clientes)");
});
