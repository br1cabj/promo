"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

test("el servidor normaliza y valida el número de vinculación", () => {
  assert.match(server, /const DEFAULT_COUNTRY = process\.env\.DEFAULT_COUNTRY \|\| "AR"/);
  assert.match(server, /number = normalizePhone\(rawNumber, DEFAULT_COUNTRY\) \|\| fallbackPhone\(rawNumber, DEFAULT_COUNTRY\)/);
  assert.match(server, /number\.length < 8 \|\| number\.length > 15/);
  assert.ok(html.includes('id="connect-phone"'), "falta #connect-phone");
  assert.ok(html.includes('pattern="[0-9+()\\s-]{8,20}" maxlength="20"'), "falta patrón y límite de longitud");
});

test("un 404 no crea la instancia sin confirmación", () => {
  const fn = server.match(/async function connectOrCreate\([\s\S]*?\n\}/);
  assert.ok(fn, "falta connectOrCreate");
  assert.match(fn[0], /allowCreate = false/);
  assert.match(fn[0], /if \(!allowCreate\) return \{ needsCreate: true \}/);
  assert.match(fn[0], /if \(e\.response\?\.status !== 404\) throw e/);
  assert.match(app, /if\(r\.needsCreate\)\{\s*\n\s*if\(!confirm\(r\.error\|\|"La instancia no existe\. ¿Crearla\?"\)\)return null;/);
  assert.match(app, /create:true/);
  assert.ok(!server.includes("if (e.response?.status !== 404) throw e;\n    const payload"), "no debe crear automáticamente");
});

test("el QR se normaliza a data URI y se detecta SVG o formato inválido", () => {
  assert.match(server, /function extractQr\(data\)/);
  assert.match(server, /data\?\.base64 \?\? data\?\.qrcode\?\.base64 \?\? data\?\.qrcode \?\? data\?\.qr \?\? null/);
  assert.match(server, /data:image\/svg\+xml;charset=utf-8/);
  assert.match(server, /data:image\/png;base64/);
  assert.match(server, /qrMime: qr \? qr\.mime : null/);
  assert.match(app, /dl\.download="whatsapp-qr\."\+\(r\.qrMime==="image\/svg\+xml"\?"svg":"png"\)/);
  assert.match(app, /if\(!r\.qr\)\{hideLinkBoxes\(\);toast\("Evolution API no devolvió un QR/);
});

test("los errores de red se muestran con un mensaje amigable", () => {
  assert.match(server, /function evoError\(e\)/);
  assert.match(server, /ECONNREFUSED.*ENOTFOUND.*EAI_AGAIN.*ETIMEDOUT/);
  assert.match(server, /No se pudo contactar con Evolution API\. Revisá EVOLUTION_URL/);
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
  assert.match(app, /x\.kind==="connection"\?"Conexión"/);
});
