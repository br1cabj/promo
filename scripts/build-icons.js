"use strict";
// Genera public/icons.js a partir de los SVG de lucide-static (ISC).
// El resultado se commitea: en producción no hace falta instalar devDependencies.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const icons = {
  close: "x",
  home: "house",
  contacts: "users",
  send: "send",
  status: "circle-dot",
  history: "history",
  connection: "plug-zap",
  menu: "menu",
  draft: "file-pen",
  sparkles: "sparkles",
  addUser: "user-plus",
  publish: "circle-play",
  smile: "smile",
  account: "user-round"
};

let out = "// Generado por scripts/build-icons.js desde lucide-static (ISC). No editar a mano.\n";
out += "const LUCIDE_ICONS={\n";
for (const [key, file] of Object.entries(icons)) {
  const src = fs.readFileSync(path.join(root, "node_modules", "lucide-static", "icons", file + ".svg"), "utf8");
  const inner = src
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .trim()
    .replace(/\s+/g, " ");
  out += `  ${JSON.stringify(key)}:${JSON.stringify(inner)},\n`;
}
out += "};\n";
out += 'function iconSvg(name,className=""){const inner=LUCIDE_ICONS[name];if(!inner)return "";return `<svg viewBox="0 0 24 24" class="icon${className?" "+className:""}" aria-hidden="true">${inner}</svg>`}\n';

fs.writeFileSync(path.join(root, "public", "icons.js"), out);
console.log(`Generado public/icons.js con ${Object.keys(icons).length} iconos de Lucide.`);
