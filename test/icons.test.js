"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const html = read("public/index.html");
const app = read("public/app.js");
const css = read("public/styles.css");
const icons = read("public/icons.js");
const buildIcons = read("scripts/build-icons.js");
const pkg = JSON.parse(read("package.json"));

test("1. Lucide está como devDependency y el sprite se genera desde el paquete", () => {
  assert.ok(pkg.devDependencies && pkg.devDependencies["lucide-static"], "falta lucide-static");
  assert.ok(pkg.scripts.icons === "node scripts/build-icons.js");
  assert.match(buildIcons, /"lucide-static", "icons"/);
  assert.match(buildIcons, /fs\.writeFileSync\(path\.join\(root, "public", "icons\.js"\)/);
  assert.ok(icons.includes("Generado por scripts/build-icons.js desde lucide-static (ISC)"));
  for (const name of ["close", "home", "contacts", "send", "status", "history", "connection", "menu", "draft", "sparkles", "addUser", "publish", "smile", "account"]) {
    assert.ok(icons.includes(`"${name}":`), `falta el icono ${name}`);
  }
});

test("2. los iconos son locales: sin CDN, sin webfonts y sin script remoto", () => {
  assert.ok(html.includes('<script src="/icons.js"></script>'));
  assert.ok(html.indexOf("/icons.js") < html.indexOf("/app.js"), "icons.js debe cargar antes");
  assert.ok(!/<script[^>]+src="https?:/.test(html), "no debe haber scripts remotos");
  assert.ok(!/@import\s+url\(https?:/.test(css), "no debe haber fuentes remotas");
  assert.ok(html.includes('<link rel="icon" href="/favicon.svg" type="image/svg+xml">'));
  assert.ok(fs.existsSync(path.join(root, "public", "favicon.svg")));
  assert.ok(app.includes("function hydrateIcons()"));
  assert.ok(app.includes("iconSvg(el.dataset.icon)"));
  assert.ok(app.includes("el.outerHTML=svg"), "el placeholder se reemplaza por el SVG");
  assert.match(icons, /function iconSvg\(name,className=""\)/);
  assert.match(icons, /viewBox="0 0 24 24" class="icon/);
  assert.match(icons, /aria-hidden="true"/);
});

test("3. los glifos sueltos desaparecen de la chrome de la app", () => {
  for (const glyph of ["✦", "＋", "➤", "◉", "👤", "😀"]) {
    assert.ok(!html.includes(glyph), `queda el glifo ${glyph} en el HTML`);
  }
  assert.ok(!app.includes('ebtn.textContent="😀"'), "el botón de emojis usa el icono");
  assert.ok(app.includes('ebtn.innerHTML=iconSvg("smile")'));
  // El selector de emojis y el toolbar son contenido, no chrome: se conservan.
  assert.ok(app.includes('ebtn.title="Insertar emoji"'));
  assert.ok(html.includes("❝"), "el símbolo de cita del toolbar se mantiene");
  assert.ok(html.includes("• Lista"), "el símbolo de viñeta del toolbar se mantiene");
});

test("4. el HTML usa placeholders con nombre semántico", () => {
  const expected = ["sparkles", "close", "home", "contacts", "send", "status", "history", "connection", "menu", "addUser", "publish", "account", "draft"];
  for (const name of expected) {
    assert.ok(html.includes(`data-icon="${name}"`), `falta el placeholder ${name}`);
  }
  assert.equal((html.match(/data-icon="draft"/g) || []).length, 3, "el borrador aparece en Enviar, Estados y la tarjeta del Inicio");
  assert.equal((html.match(/data-icon="sparkles"/g) || []).length, 2, "marca de agua y brand");
  assert.ok(!/<svg viewBox="0 0 24 24"/.test(html), "no quedaron SVG escritos a mano");
});

test("5. los tamaños contextuales heredan currentColor", () => {
  assert.ok(css.includes(".icon{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8"));
  assert.ok(css.includes(".brand-icon .icon,.quick b .icon{width:19px;height:19px}"));
  assert.ok(css.includes(".welcome-mark .icon{width:90px;height:90px;stroke-width:1}"));
  assert.ok(css.includes(".welcome-mark .icon{width:64px;height:64px}"), "la marca se adapta al celular");
  assert.ok(css.includes(".account-avatar .icon{width:20px;height:20px}"));
  assert.ok(css.includes(".sidebar-close svg{width:20px;height:20px}"));
  assert.ok(css.includes(".menu-button svg{width:22px;height:22px}"));
});
