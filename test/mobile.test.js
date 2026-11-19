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

test("1. el menú móvil es un cajón lateral, no una barra inferior", () => {
  assert.ok(html.includes('content="width=device-width,initial-scale=1,viewport-fit=cover"'));
  assert.ok(html.includes('<aside class="sidebar">'));
  assert.ok(html.includes('id="sidebar-close"'));
  assert.ok(html.includes('id="nav-overlay"'));
  assert.ok(html.includes('id="menu-button"'));
  assert.ok(html.includes('id="sidebar-nav">'));
  assert.ok(!css.includes("padding-bottom:66px"), "quedó la barra inferior");
  assert.ok(css.includes(".sidebar.open{transform:none}"));
  assert.ok(css.includes(".nav-overlay.open{opacity:1;pointer-events:auto}"));
  assert.ok(css.includes("body.nav-open{overflow:hidden}"));
});

test("2. el botón del menú mantiene estado accesible y cierra con Escape", () => {
  assert.ok(html.includes('aria-label="Abrir menú" aria-expanded="false" aria-controls="sidebar-nav"'));
  assert.ok(app.includes("function openNav()"));
  assert.ok(app.includes("function closeNav(restoreFocus=false)"));
  assert.ok(app.includes('btn.setAttribute("aria-expanded","true")'));
  assert.ok(app.includes('btn.setAttribute("aria-expanded","false")'));
  assert.ok(app.includes('document.body.classList.add("nav-open")'));
  assert.ok(app.includes('document.body.classList.remove("nav-open")'));
  assert.ok(app.includes('if(ev.key==="Escape"){closeEmojiPanels();closeEdit();closeConfirm(false);closeTemplate(false);closeNav(true)}'));
  assert.ok(app.includes('const container=modal||(side&&side.classList.contains("open")?side:null)'));
});

test("3. los iconos SVG y las etiquetas completas reemplazan a los caracteres de 9px", () => {
  const nav = html.slice(html.indexOf('<nav id="sidebar-nav">'), html.indexOf("</nav>"));
  assert.equal((nav.match(/<svg viewBox="0 0 24 24"/g) || []).length, 6);
  for (const label of ["Inicio", "Clientes", "Enviar mensaje", "Estados", "Historial", "WhatsApp"]) {
    assert.ok(nav.includes(`<span>${label}</span>`), `falta la etiqueta ${label}`);
  }
  assert.ok(css.includes(".nav svg{"));
  assert.ok(!css.includes(".nav span{font-size:9px}"), "quedaron etiquetas diminutas");
});

test("4. al cambiar de página se cierra el cajón, se sube el scroll y se mueve el foco", () => {
  assert.ok(app.includes('const drawerWasOpen=$(".sidebar").classList.contains("open")'));
  assert.ok(app.includes("closeNav();"));
  assert.ok(app.includes("window.scrollTo(0,0);"));
  assert.ok(app.includes('if(drawerWasOpen){const h=$("#page-title");if(h){h.setAttribute("tabindex","-1");h.focus({preventScroll:true})}}'));
});

test("5. el toolbar de formato se colapsa en celular sin perder el preview", () => {
  assert.equal((html.match(/<details class="format-details" open><summary>Formato y emojis<\/summary>/g) || []).length, 2);
  assert.ok(app.includes('const mobileLayout=window.matchMedia("(max-width:650px)")'));
  assert.ok(app.includes("function syncFormatDetails(){$$(\".format-details\").forEach(d=>{d.open=!mobileLayout.matches})}"));
  assert.ok(app.includes("mobileLayout.addEventListener(\"change\",syncFormatDetails)"));
  assert.ok(css.includes(".format-details>summary{"));
});

test("6. el historial muestra fecha corta en celular y completa en escritorio", () => {
  assert.ok(app.includes('class="history-date-full"'));
  assert.ok(app.includes('class="history-date-short"'));
  assert.ok(app.includes("historyDate(x.at)"));
  assert.ok(app.includes('day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"'));
  assert.ok(css.includes(".history-date-full{display:none}"));
  assert.ok(css.includes(".history-date-short{display:inline}"));
});

test("7. los campos y modales se adaptan al teclado y al área segura", () => {
  assert.ok(app.includes('if(smallScreen&&active&&typeof active.blur==="function")active.blur();'));
  assert.ok(css.includes("input:not([type=checkbox]),select,textarea{font-size:16px}"));
  assert.ok(css.includes("header{position:sticky;top:0;z-index:10;gap:8px;background:var(--bg);padding:8px 0;margin:0 0 19px}"));
  assert.ok(css.includes(".stats{grid-template-columns:repeat(2,1fr);gap:8px}"));
  assert.ok(css.includes(".modal-actions{position:sticky;bottom:-17px;background:var(--card)"));
  assert.ok(css.includes(".toast{left:12px;right:12px;bottom:calc(16px + env(safe-area-inset-bottom))"));
  assert.ok(css.includes("height:100dvh"));
});
