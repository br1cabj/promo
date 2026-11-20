"use strict";
// Smoke real del frontend: ejecuta icons.js y app.js dentro de jsdom contra un
// fetch simulado. Los otros tests de UI solo leen el código; acá se comprueba
// que la página inicialice y que los handlers críticos respondan.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const icons = fs.readFileSync(path.join(root, "public/icons.js"), "utf8");
const appSource = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const summary = {
  total: 2, optedIn: 1, history: 3, maxSendFiles: 10,
  linkTtlMs: 300000, sendDelayMs: 1, sendDelayJitterMs: 0,
  sendBatchSize: 0, sendBatchPauseMs: 0
};

function makeDom({ responses = {}, delays = {}, onFetch } = {}) {
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1/", runScripts: "outside-only", pretendToBeVisual: true
  });
  const { window } = dom;
  window.matchMedia = () => ({
    matches: false, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}
  });
  window.scrollTo = () => {};
  window.fetch = async (url, options = {}) => {
    if (onFetch) onFetch(String(url), options);
    const key = String(url).replace(/^https?:\/\/[^/]+/, "");
    let wait = delays[key] || 0;
    if (!wait && options.method === "PUT") wait = delays.PUT || 0;
    if (wait) await sleep(wait);
    let body;
    if (Object.prototype.hasOwnProperty.call(responses, key)) body = responses[key];
    else if (key.startsWith("/api/drafts/")) {
      body = { section: key.split("/").pop(), text: "", type: "text", recipientIds: [], updatedAt: new Date().toISOString() };
    } else if (key.startsWith("/api/jobs/")) body = { status: "done", total: 1, sent: 1, failed: 0, results: [] };
    else body = {};
    return { ok: true, status: 200, json: async () => body };
  };
  window.eval(icons);
  window.eval(appSource);
  return dom;
}

test("app.js se ejecuta en el DOM real: iconos, métricas y navegación", async () => {
  const dom = makeDom({
    responses: {
      "/api/summary": summary,
      "/api/connection": { configured: true, connected: false },
      "/api/drafts": [],
      "/api/contacts": [],
      "/api/history?limit=150": []
    }
  });
  try {
    await sleep(60);
    const d = dom.window.document;
    assert.ok(d.querySelector("svg"), "los iconos Lucide se hidratan");
    assert.equal(d.querySelector("#stat-total").textContent, "2");
    assert.equal(d.querySelector("#page-title").textContent, "Inicio");
    d.querySelector('.nav[data-page="history"]').click();
    await sleep(60);
    assert.equal(d.querySelector("#page-title").textContent, "Historial");
    assert.ok(!d.querySelector("#page-history").classList.contains("hidden"));
    assert.equal(d.querySelector("#history-summary").textContent, "Todavía no hay actividad.");
  } finally { dom.window.close(); }
});

test("un borrador remoto no pisa texto que el usuario ya escribió", async () => {
  const dom = makeDom({
    delays: { "/api/drafts": 40 },
    responses: {
      "/api/drafts": [{ section: "send", text: "Texto viejo del servidor", type: "text", recipientIds: [], updatedAt: new Date().toISOString() }],
      "/api/summary": summary,
      "/api/connection": { configured: true, connected: false }
    }
  });
  try {
    const ta = dom.window.document.querySelector("#send-text");
    ta.value = "Lo que acabo de escribir";
    ta.dispatchEvent(new dom.window.Event("input"));
    await sleep(120);
    assert.equal(ta.value, "Lo que acabo de escribir");
  } finally { dom.window.close(); }
});

test("los PUT de borrador se serializan y el último guarda el texto actual", async () => {
  const puts = [];
  const dom = makeDom({
    delays: { PUT: 30 },
    onFetch: (url, options) => {
      if (options.method === "PUT" && url.includes("/api/drafts/")) puts.push(JSON.parse(options.body).text);
    },
    responses: { "/api/drafts": [], "/api/summary": summary, "/api/connection": { configured: true, connected: false } }
  });
  try {
    const ta = dom.window.document.querySelector("#send-text");
    ta.value = "Primero";
    dom.window.saveDraftNow("send");
    ta.value = "Segundo";
    dom.window.saveDraftNow("send");
    await sleep(150);
    assert.deepEqual(puts, ["Primero", "Segundo"], "el segundo PUT usa el DOM más reciente");
  } finally { dom.window.close(); }
});

test("dos respuestas de conexión desordenadas: gana la más reciente", async () => {
  let call = 0;
  const dom = makeDom({
    onFetch: (url) => { if (url === "/api/connection") call++; },
    responses: { "/api/drafts": [], "/api/summary": summary }
  });
  try {
    const { window } = dom;
    window.fetch = async (url, options = {}) => {
      const key = String(url).replace(/^https?:\/\/[^/]+/, "");
      if (key === "/api/connection") {
        const n = ++call;
        await sleep(n === 1 ? 60 : 5);
        return { ok: true, status: 200, json: async () => ({ configured: true, connected: n === 1, error: n === 1 ? "" : "sin sesión" }) };
      }
      let body = key === "/api/summary" ? summary : [];
      return { ok: true, status: 200, json: async () => body };
    };
    const first = window.loadConnection({ silent: true });
    const second = window.loadConnection({ silent: true });
    await Promise.all([first, second]);
    await sleep(90);
    assert.equal(window.document.querySelector("#connection-title").textContent, "WhatsApp sin conexión");
  } finally { dom.window.close(); }
});

test("cambiar el tipo de archivo limpia el input en Enviar y en Estados", async () => {
  const dom = makeDom({ responses: { "/api/drafts": [], "/api/summary": summary, "/api/connection": { configured: true, connected: false } } });
  try {
    const d = dom.window.document;
    for (const section of ["send", "status"]) {
      const input = d.querySelector("#" + section + "-file");
      Object.defineProperty(input, "value", { writable: true, value: "archivo-anterior" });
      const select = d.querySelector("#" + section + "-type");
      select.value = "video";
      select.dispatchEvent(new dom.window.Event("change"));
      assert.equal(input.value, "", section + " descarta el archivo al cambiar a video");
      select.value = "text";
      select.dispatchEvent(new dom.window.Event("change"));
      assert.equal(input.value, "", section + " descarta el archivo al volver a texto");
    }
  } finally { dom.window.close(); }
});
