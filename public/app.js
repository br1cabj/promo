const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
// Iconos Lucide inyectados desde public/icons.js (generado desde lucide-static).
// Se hidratan acá para no depender de CDN: la CSP solo permite scripts 'self'.
function hydrateIcons(){$$("[data-icon]").forEach(el=>{const svg=iconSvg(el.dataset.icon);if(svg)el.outerHTML=svg})}
hydrateIcons();
let contacts = [];
let contactFormsAutoOpened = false;
let toastTimer;
let selectedRecipients = new Set();
let authorizedCount = 0;
let focusBeforeModal = null;
let focusBeforeConfirm = null;
let confirmResolver = null;
let templateResolver = null;
let focusBeforeTemplate = null;
const MAX_TEXT = 4096, MAX_CAPTION = 1024;
let maxSendFiles = 10;
let activeJob = null;          // último job enviado, para poder reanudar el seguimiento
let monitoringJob = false;
let linkTtlMs = 5 * 60 * 1000; // lo ajusta /api/summary
let connectionWatch = null;
let connectionPollTick = 0;
let linkKind = null;           // "qr" | "pairing"
let linkExpiresAt = 0;
let historyRows = [];          // se filtra en el navegador, sin recargar la API
let historyTotal = 0;          // lo ajusta /api/summary
let historyLimit = 150;
const HISTORY_PAGE_SIZE = 150;
let sendConfig = {             // lo ajusta /api/summary
  sendDelayMs: 1500, sendDelayJitterMs: 2500,
  sendBatchSize: 20, sendBatchPauseMs: 60000
};
const confirmObjectUrls = [];  // miniaturas del modal: se liberan al cerrar
const previewUrls = { send: [], status: [] }; // miniaturas de los inputs
const LAST_JOB_KEY = "pp-last-job"; // permite retomar el seguimiento tras recargar
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Idempotencia por contenido: reintentar el MISMO envío reusa el job, pero
// cambiar texto, destinatarios o archivos genera una clave nueva. Así una
// clave colgada tras un error de seguimiento no puede pisar una campaña nueva.
function campaignKey(type, text, ids, files) {
  const raw = [type, text, [...ids].sort().join(","),
    files.map(f => `${f.name}:${f.size}:${f.lastModified || 0}`).join(",")].join("\u001f");
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
    h2 = ((h2 << 13) | (h2 >>> 19)) >>> 0;
  }
  return "cmp-" + h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
function toast(msg,action){const el=$("#toast");el.innerHTML="";const span=document.createElement("span");span.textContent=msg;el.appendChild(span);if(action){const btn=document.createElement("button");btn.type="button";btn.className="toast-action";btn.textContent=action.label;btn.onclick=()=>{clearTimeout(toastTimer);el.classList.remove("show");action.onClick()};el.appendChild(btn)}el.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),action?7000:2800)}
async function request(url, options={}){const r=await fetch(url,options);let data={};try{data=await r.json()}catch{}if(r.status===401){window.location.href="/login";throw new Error("Sesión expirada")}if(!r.ok)throw new Error(data.error||"Ocurrió un error");return data}
// Busca el botón que dispara el submit aunque el HTML no lleve type="submit".
function submitButton(form){return form.querySelector('button[type="submit"]')||form.querySelector('button:not([type])')||form.querySelector('button')}
function showPage(name){
  const drawerWasOpen=$(".sidebar").classList.contains("open");
  closeNav();
  $$(".page").forEach(p=>p.classList.add("hidden"));
  $("#page-"+name).classList.remove("hidden");
  $$(".nav").forEach(b=>{const active=b.dataset.page===name;b.classList.toggle("active",active);if(active)b.setAttribute("aria-current","page");else b.removeAttribute("aria-current")});
  $("#page-title").textContent=({home:"Inicio",contacts:"Clientes",send:"Enviar mensaje",status:"Estados",history:"Historial",connection:"WhatsApp"})[name];
  if(name==="home")updateResumeCard();
  window.scrollTo(0,0);
  if(drawerWasOpen){const h=$("#page-title");if(h){h.setAttribute("tabindex","-1");h.focus({preventScroll:true})}}
  if(name==="contacts")refreshContacts();
  if(name==="send")renderRecipients();
  if(name==="history")loadHistory();
  if(name==="connection")loadConnection();else stopConnectionWatch();
}
$$(".nav").forEach(b=>b.addEventListener("click",()=>showPage(b.dataset.page)));
// Incluye las acciones rápidas y el chip "Ver WhatsApp" de Enviar.
$$("[data-go]").forEach(b=>b.addEventListener("click",()=>{
  const page=b.dataset.go;
  showPage(page);
  if(b.dataset.openForms!==undefined){openContactForms();return}
  // Las acciones rápidas llevan el foco al título de la vista destino, igual que el menú lateral.
  const heading=$("#page-"+page+" .section-head h2");
  if(heading){heading.setAttribute("tabindex","-1");heading.focus({preventScroll:true})}
}));
// Navegación móvil: cajón lateral en vez de barra inferior.
function openNav(){
  const side=$(".sidebar"),overlay=$("#nav-overlay"),btn=$("#menu-button");
  if(!side||side.classList.contains("open"))return;
  side.classList.add("open");overlay.classList.add("open");
  btn.setAttribute("aria-expanded","true");btn.setAttribute("aria-label","Cerrar menú");
  document.body.classList.add("nav-open");
  const first=side.querySelector(".nav");if(first)first.focus();
}
function closeNav(restoreFocus=false){
  const side=$(".sidebar"),overlay=$("#nav-overlay"),btn=$("#menu-button");
  if(!side||!side.classList.contains("open"))return;
  side.classList.remove("open");overlay.classList.remove("open");
  btn.setAttribute("aria-expanded","false");btn.setAttribute("aria-label","Abrir menú");
  document.body.classList.remove("nav-open");
  if(restoreFocus)btn.focus();
}
$("#menu-button").onclick=()=>{if($(".sidebar").classList.contains("open"))closeNav(true);else openNav()};
$("#sidebar-close").onclick=()=>closeNav(true);
$("#nav-overlay").onclick=()=>closeNav(true);
async function loadSummary(){try{const s=await request("/api/summary");$("#stat-total").textContent=s.total;$("#stat-optin").textContent=s.optedIn;$("#stat-history").textContent=s.history;historyTotal=Number(s.history)||0;if(!$("#page-history").classList.contains("hidden"))renderHistory();if(Number(s.maxSendFiles)>0)maxSendFiles=Number(s.maxSendFiles);if(Number(s.linkTtlMs)>0)linkTtlMs=Number(s.linkTtlMs);sendConfig={sendDelayMs:Number(s.sendDelayMs)||1500,sendDelayJitterMs:Number(s.sendDelayJitterMs)||0,sendBatchSize:Number(s.sendBatchSize)||0,sendBatchPauseMs:Number(s.sendBatchPauseMs)||0};updatePaceHint()}catch(e){toast(e.message)}}
// Mostrar el ritmo real evita que una campaña larga parezca colgada.
function updatePaceHint(){
  const {sendDelayMs,sendDelayJitterMs,sendBatchSize,sendBatchPauseMs}=sendConfig;
  const per=(sendDelayMs+sendDelayJitterMs/2)/1000;
  const secs=new Intl.NumberFormat("es-AR",{maximumFractionDigits:1}).format(per);
  let text=`Ritmo: ~${secs} s por mensaje`;
  if(sendBatchSize>0&&sendBatchPauseMs>0)text+=` + ${Math.round(sendBatchPauseMs/60000)} min cada ${sendBatchSize}`;
  text+=". Pausas que evitan bloquear el número.";
  const el=$("#send-pace");
  if(el)el.textContent=text;
}
async function loadContacts(){contacts=await request("/api/contacts");pruneSelected();return contacts}
// Quita de la selección los contactos que ya no existen o perdieron la
// autorización: así el contador y el confirm coinciden con lo que envía el API.
function pruneSelected(){const valid=new Set(contacts.filter(c=>c.optIn).map(c=>c.id));for(const id of [...selectedRecipients])if(!valid.has(id))selectedRecipients.delete(id)}
async function refreshContacts(){try{
  await loadContacts();
  // Con la agenda vacía el alta tiene que estar a la vista. Se decide después
  // de cargar (no antes) y una sola vez, para no reabrir lo que el usuario plegó.
  const forms=$("#contact-forms");
  if(forms&&!contacts.length&&!contactFormsAutoOpened){forms.open=true;contactFormsAutoOpened=true}
  renderContacts();updateSelected();
}catch(e){toast(e.message)}}
// El número guardado sigue siendo el canónico de WhatsApp: esto solo lo hace
// legible en pantalla y también entra en la búsqueda con o sin espacios.
function formatPhoneDisplay(phone){
  const d=String(phone||"").replace(/\D/g,"");
  if(d.startsWith("54")&&d.length===13)return `+54 ${d.slice(2,3)} ${d.slice(3,6)} ${d.slice(6,9)}-${d.slice(9)}`;
  if(d.startsWith("54")&&d.length===12)return `+54 ${d.slice(2,5)} ${d.slice(5,8)}-${d.slice(8)}`;
  if(d.length===10)return `${d.slice(0,3)} ${d.slice(3,6)}-${d.slice(6)}`;
  if(d.length>7)return `+${d.slice(0,d.length-7)} ${d.slice(-7,-4)}-${d.slice(-4)}`;
  return String(phone||"");
}
function openContactForms(){
  const details=$("#contact-forms");if(!details)return;
  details.open=true;
  const field=$("#add-contact [name=name]");
  if(field)field.focus({preventScroll:false});
}
function renderContacts(){
  const q=($("#contact-search").value||"").toLowerCase().trim();
  const filter=$("#contacts-filter"),status=filter?filter.value:"";
  const rows=contacts.filter(c=>{
    if(status==="ok"&&!c.optIn)return false;
    if(status==="pending"&&c.optIn)return false;
    if(!q)return true;
    return [c.name,c.phone,formatPhoneDisplay(c.phone),c.dni].join(" ").toLowerCase().includes(q);
  });
  const summary=$("#contacts-summary");
  if(summary){
    const authorized=contacts.filter(c=>c.optIn).length;
    summary.textContent=contacts.length
      ? `Mostrando ${rows.length} de ${contacts.length} clientes${rows.length!==contacts.length?" (filtrados)":""} · ${authorized} autorizados.`
      : "Todavía no hay clientes.";
  }
  const body=$("#contacts-body");
  body.innerHTML=rows.map(c=>{
    const name=c.name||"Sin nombre";
    const perm=c.optIn?"Quitar":"Autorizar";
    const permLabel=c.optIn?`Quitar autorización a ${name}`:`Autorizar a ${name}`;
    return `<tr><td data-label="Nombre"><span class="contact-name">${esc(name)}</span></td><td data-label="Teléfono"><span class="contact-phone">${esc(formatPhoneDisplay(c.phone))}</span></td><td data-label="DNI"><span class="contact-dni">${esc(c.dni||"—")}</span></td><td data-label="Autorizado"><span class="pill ${c.optIn?"yes":"no"}">${c.optIn?"Autorizado":"Pendiente"}</span></td><td data-label="Acciones"><button class="small-btn" data-edit="${c.id}" aria-label="Editar a ${esc(name)}">Editar</button><button class="small-btn" data-toggle="${c.id}" aria-label="${esc(permLabel)}">${perm}</button><button class="small-btn danger" data-delete="${c.id}" aria-label="Eliminar a ${esc(name)}">Eliminar</button></td></tr>`;
  }).join("")||(contacts.length
    ? '<tr class="contacts-empty-row"><td colspan="5"><div class="empty-state">Ningún cliente coincide con los filtros. <button type="button" class="text-button" data-clear-filters>Limpiar filtros</button></div></td></tr>'
    : '<tr class="contacts-empty-row"><td colspan="5"><div class="empty-state">Todavía no cargaste clientes. <button type="button" class="text-button" data-empty-add>Agregar el primero</button></div></td></tr>');
  body.querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>openEdit(b.dataset.edit));
  body.querySelectorAll("[data-toggle]").forEach(b=>b.onclick=async()=>{
    const c=contacts.find(x=>x.id===b.dataset.toggle);if(!c)return;
    try{await request("/api/contacts/"+c.id,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({optIn:!c.optIn})});refreshContacts();loadSummary()}
    catch(e){toast(e.message)}
  });
  body.querySelectorAll("[data-delete]").forEach(b=>b.onclick=async()=>{
    const c=contacts.find(x=>x.id===b.dataset.delete);if(!c)return;
    if(!await askConfirm(`¿Eliminar a ${c.name||"Sin nombre"}? Podés restaurarlo desde el aviso.`,{title:"Eliminar cliente",acceptLabel:"Eliminar",danger:true}))return;
    try{await request("/api/contacts/"+c.id,{method:"DELETE"});selectedRecipients.delete(c.id);refreshContacts();loadSummary();toast("Cliente eliminado",{label:"Deshacer",onClick:()=>restoreContact(c)})}
    catch(e){toast(e.message)}
  });
  const add=body.querySelector("[data-empty-add]");
  if(add)add.onclick=openContactForms;
  const clear=body.querySelector("[data-clear-filters]");
  if(clear)clear.onclick=()=>{const s=$("#contact-search"),f=$("#contacts-filter");if(s)s.value="";if(f)f.value="";renderContacts()};
}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
let searchTimer;$("#contact-search").addEventListener("input",()=>{clearTimeout(searchTimer);searchTimer=setTimeout(renderContacts,200)});
$("#contacts-filter").addEventListener("change",renderContacts);
function csvCell(v){const s=String(v??"");return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}
async function exportContacts(){try{if(!contacts.length)await loadContacts();if(!contacts.length)return toast("No hay clientes para exportar.");const rows=[["nombre","telefono","dni","optin"]];for(const c of contacts)rows.push([c.name||"",c.phone||"",c.dni||"",c.optIn?"si":"no"]);const csv="\uFEFF"+rows.map(r=>r.map(csvCell).join(",")).join("\r\n")+"\r\n";const blob=new Blob([csv],{type:"text/csv;charset=utf-8"});const url=URL.createObjectURL(blob);const d=new Date();const stamp=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");const a=document.createElement("a");a.href=url;a.download="clientes-"+stamp+".csv";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);toast("Exportados "+contacts.length+" clientes.")}catch(e){toast(e.message)}}
$("#export-contacts").onclick=exportContacts;
function openEdit(id){const c=contacts.find(x=>x.id===id);if(!c)return;focusBeforeModal=document.activeElement;const f=$("#edit-contact");f.elements.id.value=c.id;f.elements.name.value=c.name||"";f.elements.phone.value=c.phone||"";f.elements.dni.value=c.dni||"";f.elements.optIn.checked=!!c.optIn;$("#edit-modal").classList.remove("hidden");f.elements.name.focus()}
function closeEdit(){const modal=$("#edit-modal");if(modal.classList.contains("hidden"))return;modal.classList.add("hidden");if(focusBeforeModal&&typeof focusBeforeModal.focus==="function")focusBeforeModal.focus();focusBeforeModal=null}
// Confirmaciones accesibles, en reemplazo del diálogo nativo.
function releaseConfirmUrls(){while(confirmObjectUrls.length){URL.revokeObjectURL(confirmObjectUrls.pop())}}
function askConfirm(message,{title="Confirmar acción",acceptLabel="Confirmar",danger=false,detail=null}={}){
  if(confirmResolver)return Promise.resolve(false);
  const modal=$("#confirm-modal");
  $("#confirm-modal-title").textContent=title;
  $("#confirm-modal-message").textContent=message;
  const detailBox=$("#confirm-modal-detail");
  releaseConfirmUrls();
  detailBox.innerHTML="";
  detailBox.classList.add("hidden");
  if(detail){
    const lines=(detail.lines||[]).filter(Boolean);
    const images=[...(detail.images||[]),...(detail.files||[]).filter(f=>f&&f.type&&f.type.startsWith("image/")).slice(0,4).map(f=>{const u=URL.createObjectURL(f);confirmObjectUrls.push(u);return u})];
    let html="";
    if(lines.length)html+='<div class="confirm-lines">'+lines.map(l=>`<div>${esc(l)}</div>`).join("")+"</div>";
    if(images.length)html+='<div class="confirm-thumbs">'+images.map(u=>`<img src="${u}" alt="Archivo adjunto">`).join("")+"</div>";
    if(html){detailBox.innerHTML=html;detailBox.classList.remove("hidden")}
  }
  const accept=$("#confirm-accept");
  accept.textContent=acceptLabel;
  accept.classList.toggle("danger",!!danger);
  const active=document.activeElement;
  // En celular, cerrar el teclado antes de mostrar la confirmación.
  const smallScreen=window.matchMedia("(max-width:650px)").matches;
  if(smallScreen&&active&&typeof active.blur==="function")active.blur();
  focusBeforeConfirm=smallScreen?null:active;
  modal.classList.remove("hidden");
  accept.focus();
  return new Promise(resolve=>{confirmResolver=resolve});
}
function closeConfirm(result){
  const modal=$("#confirm-modal");
  if(modal.classList.contains("hidden"))return;
  modal.classList.add("hidden");
  const detailBox=$("#confirm-modal-detail");
  detailBox.classList.add("hidden");detailBox.innerHTML="";releaseConfirmUrls();
  const resolve=confirmResolver;confirmResolver=null;
  if(focusBeforeConfirm&&typeof focusBeforeConfirm.focus==="function")focusBeforeConfirm.focus();
  focusBeforeConfirm=null;
  if(resolve)resolve(!!result);
}
// Modal propio para pedir el nombre de una plantilla, sin diálogo nativo.
function askText({title="Nombre de la plantilla",message="",value="",acceptLabel="Guardar",preview=""}={}){
  if(templateResolver)return Promise.resolve(null);
  const modal=$("#template-modal");
  $("#template-modal-title").textContent=title;
  $("#template-modal-message").textContent=message;
  const p=$("#template-modal-preview");if(p){p.textContent=preview||"";p.classList.toggle("hidden",!preview)}
  const input=$("#template-name");
  input.value=value||"";
  $("#template-accept").textContent=acceptLabel;
  focusBeforeTemplate=document.activeElement;
  modal.classList.remove("hidden");
  input.focus();input.select();
  return new Promise(resolve=>{templateResolver=resolve});
}
function closeTemplate(result){
  const modal=$("#template-modal");
  if(modal.classList.contains("hidden"))return;
  const value=$("#template-name").value.trim();
  modal.classList.add("hidden");
  const resolve=templateResolver;templateResolver=null;
  if(focusBeforeTemplate&&typeof focusBeforeTemplate.focus==="function")focusBeforeTemplate.focus();
  focusBeforeTemplate=null;
  if(resolve)resolve(result?value:null);
}
// Mantiene el foco dentro del modal mientras está abierto.
function trapModalFocus(ev){
  if(ev.key!=="Tab")return;
  const confirm=$("#confirm-modal"),edit=$("#edit-modal"),template=$("#template-modal");
  const modal=!confirm.classList.contains("hidden")?confirm:!edit.classList.contains("hidden")?edit:!template.classList.contains("hidden")?template:null;
  const side=$(".sidebar");
  const container=modal||(side&&side.classList.contains("open")?side:null);
  if(!container)return;
  const items=[...container.querySelectorAll("button, input, select, textarea, a[href]")].filter(el=>!el.disabled&&el.offsetParent!==null);
  if(!items.length)return;
  const first=items[0],last=items[items.length-1];
  if(ev.shiftKey&&document.activeElement===first){ev.preventDefault();last.focus()}
  else if(!ev.shiftKey&&document.activeElement===last){ev.preventDefault();first.focus()}
}
async function restoreContact(c){try{await request("/api/contacts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:c.name,phone:c.phone,dni:c.dni,optIn:c.optIn})});toast("Cliente restaurado");refreshContacts();loadSummary()}catch(e){toast(e.message)}}
$("#edit-cancel").onclick=closeEdit;
$("#edit-modal").addEventListener("click",e=>{if(e.target.id==="edit-modal")closeEdit()});
$("#confirm-cancel").onclick=()=>closeConfirm(false);
$("#confirm-accept").onclick=()=>closeConfirm(true);
$("#confirm-modal").addEventListener("click",e=>{if(e.target.id==="confirm-modal")closeConfirm(false)});
$("#template-form").addEventListener("submit",e=>{e.preventDefault();if($("#template-name").value.trim())closeTemplate(true)});
$("#template-cancel").onclick=()=>closeTemplate(false);
$("#template-modal").addEventListener("click",e=>{if(e.target.id==="template-modal")closeTemplate(false)});
$("#edit-contact").addEventListener("submit",async e=>{e.preventDefault();const f=e.target;const btn=submitButton(f);btn.disabled=true;try{await request("/api/contacts/"+f.elements.id.value,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:f.elements.name.value,phone:f.elements.phone.value,dni:f.elements.dni.value,optIn:f.elements.optIn.checked})});closeEdit();toast("Cliente actualizado");refreshContacts();loadSummary()}catch(err){toast(err.message)}finally{btn.disabled=false}});
// --- Formato de texto al estilo WhatsApp -----------------------------------
function lineBounds(value,start,end){const from=value.lastIndexOf("\n",start-1)+1;let to=value.indexOf("\n",end);if(to===-1)to=value.length;return[from,to]}
function wrapInline(ta,marker){const value=ta.value,start=ta.selectionStart,end=ta.selectionEnd,sel=value.slice(start,end),m=marker.length;if(sel.length>=2*m&&sel.startsWith(marker)&&sel.endsWith(marker)){const inner=sel.slice(m,sel.length-m);ta.value=value.slice(0,start)+inner+value.slice(end);ta.setSelectionRange(start,start+inner.length)}else{const inner=sel.length?sel:"texto";ta.value=value.slice(0,start)+marker+inner+marker+value.slice(end);ta.setSelectionRange(start+m,start+m+inner.length)}ta.focus()}
function prefixLines(ta,kind){const value=ta.value;let start=ta.selectionStart,end=ta.selectionEnd;if(start===end){const b=lineBounds(value,start,end);start=b[0];end=b[1]}const lines=value.slice(start,end).split("\n");let out;if(kind==="quote"){const on=lines.every(l=>/^>\s?/.test(l));out=lines.map(l=>on?l.replace(/^>\s?/,""):(/^>\s?/.test(l)?l:"> "+l))}else if(kind==="bullets"){const on=lines.every(l=>/^[-*]\s+/.test(l));out=lines.map(l=>on?l.replace(/^[-*]\s+/,""):(/^[-*]\s+/.test(l)?l:"- "+l))}else{const on=lines.every((l,i)=>new RegExp("^"+(i+1)+"\\.\\s").test(l));out=lines.map((l,i)=>on?l.replace(/^\d+\.\s/,""):(i+1)+". "+l.replace(/^\d+\.\s/,""))}const replaced=out.join("\n");ta.value=value.slice(0,start)+replaced+value.slice(end);ta.setSelectionRange(start,start+replaced.length);ta.focus()}
function headingLine(line,marker){const t=line.trim();if(!t)return line;if(t.startsWith(marker)&&t.endsWith(marker)&&t.length>2*marker.length)return t.slice(marker.length,-marker.length);return marker+t+marker}
function makeHeading(ta,marker){const value=ta.value;let start=ta.selectionStart,end=ta.selectionEnd;if(start===end){const b=lineBounds(value,start,end);start=b[0];end=b[1]}const block=value.slice(start,end);
  if(block.includes("\n")){const replaced=block.split("\n").map(l=>headingLine(l,marker)).join("\n");ta.value=value.slice(0,start)+replaced+value.slice(end);ta.setSelectionRange(start,start+replaced.length);ta.focus();return}
  const wrapped=headingLine(block,marker);let before=value.slice(0,start),after=value.slice(end);if(before&&!before.endsWith("\n"))before+="\n";if(after&&!after.startsWith("\n"))after="\n"+after;ta.value=before+wrapped+after;ta.setSelectionRange(before.length,before.length+wrapped.length);ta.focus()}
function applyFormat(ta,fmt){const inline={bold:"*",italic:"_",strike:"~",mono:"```"};if(inline[fmt])return wrapInline(ta,inline[fmt]);if(fmt==="title")return makeHeading(ta,"*");if(fmt==="subtitle")return makeHeading(ta,"_");if(fmt==="quote"||fmt==="bullets"||fmt==="numbers")return prefixLines(ta,fmt)}
function renderWhatsApp(text){const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));const inline=s=>{let out=esc(s);const codes=[];out=out.replace(/```([\s\S]+?)```/g,(_,c)=>{codes.push(c);return"\u0000"+(codes.length-1)+"\u0000"});out=out.replace(/\*([^*\n]+)\*/g,"<strong>$1</strong>");out=out.replace(/_([^_\n]+)_/g,"<em>$1</em>");out=out.replace(/~([^~\n]+)~/g,"<del>$1</del>");out=out.replace(/\u0000(\d+)\u0000/g,(_,i)=>"<code>"+codes[Number(i)]+"</code>");return out};const lines=String(text||"").split("\n");const html=[];let list=null;const closeList=()=>{if(list){html.push("</"+list+">");list=null}};for(const line of lines){const q=/^>\s?(.*)$/.exec(line);if(q){closeList();html.push("<blockquote>"+inline(q[1])+"</blockquote>");continue}const b=/^[-*]\s+(.*)$/.exec(line);if(b){if(list!=="ul"){closeList();html.push("<ul>");list="ul"}html.push("<li>"+inline(b[1])+"</li>");continue}const n=/^\d+\.\s+(.*)$/.exec(line);if(n){if(list!=="ol"){closeList();html.push("<ol>");list="ol"}html.push("<li>"+inline(n[1])+"</li>");continue}closeList();html.push(line===""?'<div class="empty"></div>':"<div>"+inline(line)+"</div>")}closeList();return html.join("")}
const EMOJI_GROUPS=[{name:"Caras",items:"😀 😃 😄 😁 😆 😅 😂 🙂 🙃 😉 😊 😇 😍 😘 😎 🤗 🤔 😴 😢 😭 😡 😱 😬".split(" ")},{name:"Gestos",items:"👍 👎 👌 ✌️ ✋ 🙌 👏 🙏 💪 👋 🤝 ✊ 👊 🤞".split(" ")},{name:"Corazones",items:"❤️ 💚 💙 💛 💜 🖤 💔 💕 💞 💖 💗 💘 ✨ ⭐ 🌟 💫".split(" ")},{name:"Promos y compras",items:"🔥 💯 🎉 🎊 🎁 💰 💸 🛒 🏷️ 💳 📢 📣 📞 📱 📍 🕒 ⏰ 🚚 ✅ ❌ ⚠️ ➡️".split(" ")},{name:"Comida",items:"🍕 🍔 🍟 🌭 🍿 🍩 🍰 🍦 ☕ 🍺 🍷 🍫 🍎 🍗 🥗 🍳".split(" ")},{name:"Símbolos",items:"✔️ ❌ ➕ ➖ ➡️ ⬅️ ⬆️ ⬇️ 🔴 🔵 ⚪ ⚫ 🔔 🔒 🔓 📌 📎 🔗 ⏩ 🔄".split(" ")}];
function insertAtCursor(ta,text){const value=ta.value,start=ta.selectionStart,end=ta.selectionEnd;ta.value=value.slice(0,start)+text+value.slice(end);const pos=start+text.length;ta.setSelectionRange(pos,pos);ta.focus()}
function closeEmojiPanels(){$$(".emoji-panel").forEach(p=>p.classList.add("hidden"))}
function attachFormatting(){$$(".format-toolbar").forEach(tb=>{const ta=document.getElementById(tb.dataset.formatTarget);if(!ta)return;const preview=document.querySelector('[data-preview-for="'+tb.dataset.formatTarget+'"]');const counter=document.querySelector('[data-count-for="'+tb.dataset.formatTarget+'"]');const typeSel=document.getElementById(tb.dataset.formatTarget==="send-text"?"send-type":"status-type");const update=()=>{if(preview)preview.innerHTML=ta.value.trim()?renderWhatsApp(ta.value):'<span class="muted">La vista previa aparecerá acá a medida que escribas.</span>';if(counter){const n=ta.value.length;const isText=!!(typeSel&&typeSel.value==="text");const max=isText?MAX_TEXT:MAX_CAPTION;counter.textContent=n+" / "+max+" caracteres"+(n>max?" · supera el límite para "+(isText?"mensajes de texto":"imágenes y videos"):"");counter.classList.toggle("warn",n>max)}};tb.querySelectorAll("button[data-fmt]").forEach(btn=>{btn.setAttribute("aria-label",btn.title||btn.textContent);btn.onclick=()=>{applyFormat(ta,btn.dataset.fmt);ta.dispatchEvent(new Event("input"));update()}});const wrap=document.createElement("span");wrap.className="emoji-wrap";const ebtn=document.createElement("button");ebtn.type="button";ebtn.className="emoji-btn";ebtn.title="Insertar emoji";ebtn.setAttribute("aria-label","Insertar emoji");ebtn.innerHTML=iconSvg("smile");const panel=document.createElement("div");panel.className="emoji-panel hidden";EMOJI_GROUPS.forEach(g=>{const t=document.createElement("div");t.className="emoji-group-title";t.textContent=g.name;panel.appendChild(t);const grid=document.createElement("div");grid.className="emoji-grid";g.items.forEach(e=>{const b=document.createElement("button");b.type="button";b.className="emoji-item";b.textContent=e;b.setAttribute("aria-label","Emoji "+e);b.onclick=()=>{insertAtCursor(ta,e);ta.dispatchEvent(new Event("input"));update();if(window.matchMedia("(max-width:650px)").matches)closeEmojiPanels()};grid.appendChild(b)});panel.appendChild(grid)});ebtn.onclick=ev=>{ev.stopPropagation();const open=!panel.classList.contains("hidden");closeEmojiPanels();if(!open)panel.classList.remove("hidden")};document.addEventListener("click",ev=>{if(!wrap.contains(ev.target))panel.classList.add("hidden")});wrap.appendChild(ebtn);wrap.appendChild(panel);tb.appendChild(wrap);ta.addEventListener("input",update);update()})}
document.addEventListener("keydown",ev=>{if(ev.key==="Escape"){closeEmojiPanels();closeEdit();closeConfirm(false);closeTemplate(false);closeNav(true)}trapModalFocus(ev)});
attachFormatting();
// El toolbar empieza cerrado en todas las pantallas: así el borrador y las
// plantillas quedan visibles sin hacer scroll.
// --- Borradores de redacción (se guardan en el servidor) --------------------
// El borrador vive en el servidor (SQLite), así está disponible desde la PC y
// el celular. Guardamos texto, tipo y destinatarios; nunca imágenes ni videos.
const DRAFT_FIELDS={send:{text:"#send-text",type:"#send-type"},status:{text:"#status-text",type:"#status-type"}};
const DRAFT_TYPE_LABEL={text:"Texto",image:"Imagen",video:"Video"};
const draftTimers={};
const lastDraftSavedAt={send:null,status:null};
let applyingDraft=false;
function draftTime(iso){if(!iso)return "";const d=new Date(iso);return Number.isNaN(d.getTime())?"":d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
function draftMetaText(section,draft){
  const parts=[];
  if(draft.text)parts.push("Texto");
  const type=DRAFT_TYPE_LABEL[draft.type];
  if(type&&draft.type!=="text")parts.push(type);
  const n=section==="send"&&Array.isArray(draft.recipientIds)?draft.recipientIds.length:0;
  if(n)parts.push(n+" destinatario"+(n===1?"":"s"));
  return parts.join(" · ");
}
function hasDraftContent(section){const f=DRAFT_FIELDS[section];return !!($(f.text)?.value||"").trim()||(section==="send"&&selectedRecipients.size>0)}
function paintDraft(section,{message,saved=false,updatedAt=null,meta="",retry=false}={}){
  const box=document.querySelector('[data-draft-for="'+section+'"]');if(!box)return;
  const status=box.querySelector('[data-draft-status="'+section+'"]');
  const time=box.querySelector('[data-draft-time="'+section+'"]');
  const metaEl=box.querySelector('[data-draft-meta="'+section+'"]');
  const noteEl=box.querySelector('[data-draft-note="'+section+'"]');
  const retryBtn=box.querySelector('[data-draft-retry="'+section+'"]');
  const discard=box.querySelector('[data-draft-clear="'+section+'"]');
  if(status)status.textContent=message;
  const when=draftTime(updatedAt||lastDraftSavedAt[section]);
  if(time){time.textContent=when;time.classList.toggle("hidden",!when)}
  if(metaEl){metaEl.textContent=meta;metaEl.classList.toggle("hidden",!meta)}
  if(noteEl){const f=DRAFT_FIELDS[section];const type=$(f.type)?.value||"text";noteEl.classList.toggle("hidden",type==="text")}
  if(retryBtn)retryBtn.classList.toggle("hidden",!retry);
  const has=hasDraftContent(section);
  if(discard){discard.classList.toggle("hidden",!has);discard.disabled=!has}
  box.classList.toggle("saved",!!saved);
  box.classList.toggle("error",!!retry);
  updateDraftBadges();
  updateResumeCard();
}
function updateDraftBadges(){
  ["send","status"].forEach(sec=>{const b=document.querySelector('[data-draft-badge="'+sec+'"]');if(b)b.classList.toggle("hidden",!hasDraftContent(sec))});
}
function updateResumeCard(){
  const card=$("#resume-card");if(!card)return;
  const rows=["send","status"].map(sec=>{
    if(!hasDraftContent(sec))return null;
    const d=draftPayload(sec), meta=draftMetaText(sec,d), t=draftTime(lastDraftSavedAt[sec]);
    return{section:sec,label:sec==="send"?"Enviar mensaje":"Estados",detail:(meta||"Texto")+(t?" · "+t:"")};
  }).filter(Boolean);
  if(!rows.length){card.classList.add("hidden");return}
  card.classList.remove("hidden");
  // Cada destino es su propia fila: se lee mejor y empuja menos el contenido en el celular.
  for(const sec of ["send","status"]){
    const item=rows.find(r=>r.section===sec);
    const row=$("#resume-row-"+sec),btn=$("#resume-"+sec),meta=$("#resume-"+sec+"-meta");
    if(row)row.classList.toggle("hidden",!item);
    if(btn)btn.classList.toggle("hidden",!item);
    if(meta)meta.textContent=item?item.label+" · "+item.detail:"";
  }
}
// El aviso legal se pliega una sola vez en celular; en escritorio sigue abierto.
let homeNoticeCollapsed=false;
function collapseHomeNotice(){
  if(homeNoticeCollapsed)return;
  homeNoticeCollapsed=true;
  if(!window.matchMedia||!matchMedia("(max-width:650px)").matches)return;
  const notice=$("#home-notice");if(notice)notice.open=false;
}
function draftPayload(section){const f=DRAFT_FIELDS[section];return{text:$(f.text)?.value||"",type:$(f.type)?.value||"text",recipientIds:section==="send"?[...selectedRecipients]:[]}}
async function saveDraftNow(section,{silent=false}={}){
  if(applyingDraft)return null;
  clearTimeout(draftTimers[section]);delete draftTimers[section];
  if(!silent)paintDraft(section,{message:"Guardando…"});
  try{
    const r=await request("/api/drafts/"+section,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(draftPayload(section))});
    if(r.cleared){
      lastDraftSavedAt[section]=null;
      paintDraft(section,{message:"Sin borrador. Escribí y se guarda automáticamente."});
    }else{
      lastDraftSavedAt[section]=r.updatedAt||new Date().toISOString();
      paintDraft(section,{message:"Guardado automáticamente",saved:true,updatedAt:lastDraftSavedAt[section],meta:draftMetaText(section,r)});
    }
    return r;
  }catch(e){
    paintDraft(section,{message:"No se pudo guardar. Revisá tu conexión.",retry:true});
    return null;
  }
}
function scheduleDraftSave(section){if(applyingDraft)return;paintDraft(section,{message:"Guardando…"});clearTimeout(draftTimers[section]);draftTimers[section]=setTimeout(()=>saveDraftNow(section),800)}
function flushDrafts(){for(const section of Object.keys(draftTimers)){clearTimeout(draftTimers[section]);delete draftTimers[section];try{fetch("/api/drafts/"+section,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(draftPayload(section)),keepalive:true})}catch{}}}
function applyDraft(section,draft,{restored=false}={}){
  const f=DRAFT_FIELDS[section];if(!f)return;
  clearTimeout(draftTimers[section]);delete draftTimers[section];applyingDraft=true;
  try{
    const ta=$(f.text);if(ta){ta.value=draft.text||"";ta.dispatchEvent(new Event("input"))}
    const sel=$(f.type);if(sel){sel.value=["text","image","video"].includes(draft.type)?draft.type:"text";sel.dispatchEvent(new Event("change"))}
    if(section==="send"){selectedRecipients=new Set(Array.isArray(draft.recipientIds)?draft.recipientIds:[]);if(contacts.length)renderRecipientList()}
    const has=!!(draft.text||(draft.recipientIds&&draft.recipientIds.length));
    lastDraftSavedAt[section]=has?(draft.updatedAt||null):null;
    paintDraft(section,{message:restored?(has?"Borrador recuperado de otra sesión":"Sin borrador. Escribí y se guarda automáticamente."):(has?"Borrador listo para seguir":"Sin borrador. Escribí y se guarda automáticamente."),saved:has,meta:draftMetaText(section,draft)});
  }finally{applyingDraft=false}
}
async function loadDrafts(){try{const list=await request("/api/drafts");list.forEach(d=>applyDraft(d.section,d,{restored:true}))}catch{}}
async function clearDraft(section){
  const f=DRAFT_FIELDS[section];if(!f)return;
  if(!await askConfirm("¿Descartar el borrador y limpiar el formulario?",{title:"Descartar borrador",acceptLabel:"Descartar",danger:true}))return;
  clearTimeout(draftTimers[section]);delete draftTimers[section];applyingDraft=true;
  try{
    const ta=$(f.text);if(ta){ta.value="";ta.dispatchEvent(new Event("input"))}
    const sel=$(f.type);if(sel){sel.value="text";sel.dispatchEvent(new Event("change"))}
    if(section==="send"){selectedRecipients.clear();if(contacts.length)renderRecipientList()}
    await request("/api/drafts/"+section,{method:"DELETE"});
    lastDraftSavedAt[section]=null;
    paintDraft(section,{message:"Borrador descartado. Escribí y se guarda automáticamente."});
    toast("Borrador descartado");
  }catch(e){toast(e.message);paintDraft(section,{message:"No se pudo descartar el borrador.",retry:true})}
  finally{applyingDraft=false}
}
["send","status"].forEach(section=>{const f=DRAFT_FIELDS[section];const ta=$(f.text);if(ta)ta.addEventListener("input",()=>scheduleDraftSave(section));const sel=$(f.type);if(sel)sel.addEventListener("change",()=>scheduleDraftSave(section))});
$$("[data-draft-clear]").forEach(b=>b.onclick=()=>clearDraft(b.dataset.draftClear));
$$("[data-draft-retry]").forEach(b=>b.onclick=()=>saveDraftNow(b.dataset.draftRetry));
window.addEventListener("pagehide",flushDrafts);
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="hidden")flushDrafts()});
loadDrafts();
// --- Plantillas de texto (mensajes ya escritos, preseleccionables) ----------
const templateCache={send:[],status:[]};
const selectedTemplate={send:"",status:""};
function templateSnippet(text){const raw=String(text||"").trim();const lines=raw.split("\n").filter(Boolean);return lines.slice(0,2).join(" · ").slice(0,110)+(raw.length>110?"…":"")}
function renderTemplates(sec){
  const list=document.querySelector('[data-template-list="'+sec+'"]');if(!list)return;
  const items=templateCache[sec]||[];
  list.innerHTML=items.map(t=>{
    const active=selectedTemplate[sec]===t.id;
    return '<div class="template-item'+(active?" active":"")+'">'+
      '<button type="button" class="template-use" data-template-action="use" data-id="'+esc(t.id)+'">'+
      '<strong>'+esc(t.name)+'</strong><span class="template-snippet">'+esc(templateSnippet(t.text))+'</span>'+
      (active?'<span class="template-inuse">En uso</span>':"")+'</button>'+
      '<span class="template-actions">'+
      '<button type="button" class="small-btn" data-template-action="rename" data-id="'+esc(t.id)+'">Renombrar</button>'+
      '<button type="button" class="small-btn" data-template-action="update" data-id="'+esc(t.id)+'">Actualizar</button>'+
      '<button type="button" class="small-btn danger" data-template-action="delete" data-id="'+esc(t.id)+'">Eliminar</button>'+
      '</span></div>';
  }).join("");
  const count=document.querySelector('[data-template-count="'+sec+'"]');if(count)count.textContent=items.length?"("+items.length+")":"";
  const empty=document.querySelector('[data-template-empty="'+sec+'"]');if(empty)empty.classList.toggle("hidden",items.length>0);
}
async function loadTemplates(){try{const list=await request("/api/templates");["send","status"].forEach(sec=>{templateCache[sec]=list;renderTemplates(sec)})}catch{}}
function composerText(sec){return $(DRAFT_FIELDS[sec].text)?.value||""}
async function useTemplate(sec,t){
  const ta=$(DRAFT_FIELDS[sec].text);if(!ta)return;
  const previous=ta.value,prevSelected=selectedTemplate[sec];
  if(previous.trim()&&previous!==t.text){
    if(!await askConfirm('La plantilla “'+t.name+'” reemplaza el texto que estás escribiendo. ¿Aplicarla?',{title:"Aplicar plantilla",acceptLabel:"Aplicar",danger:true}))return;
  }
  ta.value=t.text;ta.dispatchEvent(new Event("input"));
  selectedTemplate[sec]=t.id;renderTemplates(sec);
  if(previous!==t.text)toast("Plantilla aplicada",{label:"Deshacer",onClick:()=>{ta.value=previous;ta.dispatchEvent(new Event("input"));selectedTemplate[sec]=prevSelected;renderTemplates(sec)}});
  else toast("Plantilla aplicada");
}
async function newTemplate(sec){
  const text=composerText(sec).trim();if(!text)return toast("Escribí el texto antes de guardarlo como plantilla.");
  const name=await askText({title:"Nueva plantilla",message:"Se guarda el texto del cuadro y queda disponible en Enviar y Estados.",value:"",acceptLabel:"Guardar",preview:text});
  if(name===null||!name.trim())return;
  try{const created=await request("/api/templates",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name.trim(),text})});selectedTemplate[sec]=created.id;toast("Plantilla guardada");await loadTemplates()}catch(e){toast(e.message)}
}
async function renameTemplate(sec,t){
  const name=await askText({title:"Renombrar plantilla",message:"Cambiá solo el nombre; el texto se mantiene.",value:t.name,acceptLabel:"Guardar",preview:t.text});
  if(name===null||!name.trim()||name.trim()===t.name)return;
  try{await request("/api/templates/"+encodeURIComponent(t.id),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name.trim(),text:t.text})});toast("Plantilla renombrada");await loadTemplates()}catch(e){toast(e.message)}
}
async function updateTemplateFromComposer(sec,t){
  const text=composerText(sec).trim();if(!text)return toast("Escribí el texto antes de actualizar la plantilla.");
  if(!await askConfirm('¿Actualizar “'+t.name+'” con el texto que hay ahora?',{title:"Actualizar plantilla",acceptLabel:"Actualizar"}))return;
  try{await request("/api/templates/"+encodeURIComponent(t.id),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:t.name,text})});toast("Plantilla actualizada");await loadTemplates()}catch(e){toast(e.message)}
}
async function deleteTemplate(sec,t){
  if(!await askConfirm('¿Eliminar la plantilla “'+t.name+'”?',{title:"Eliminar plantilla",acceptLabel:"Eliminar",danger:true}))return;
  try{await request("/api/templates/"+encodeURIComponent(t.id),{method:"DELETE"});if(selectedTemplate[sec]===t.id)selectedTemplate[sec]="";toast("Plantilla eliminada");await loadTemplates()}catch(e){toast(e.message)}
}
$$("div.template-list[data-template-list]").forEach(list=>{list.addEventListener("click",async e=>{const btn=e.target.closest("button[data-template-action]");if(!btn)return;const sec=list.dataset.templateList;const t=(templateCache[sec]||[]).find(x=>x.id===btn.dataset.id);if(!t)return;({use:useTemplate,rename:renameTemplate,update:updateTemplateFromComposer,delete:deleteTemplate})[btn.dataset.templateAction]?.(sec,t)})});
$$("[data-template-new]").forEach(b=>b.onclick=()=>newTemplate(b.dataset.templateNew));
loadTemplates();

$("#add-contact").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.target);const btn=submitButton(e.target);btn.disabled=true;try{await request("/api/contacts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:f.get("name"),phone:f.get("phone"),dni:f.get("dni"),optIn:f.has("optIn")})});e.target.reset();toast("Cliente guardado");refreshContacts();loadSummary()}catch(err){toast(err.message)}finally{btn.disabled=false}});
$("#import-form").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.target);const btn=submitButton(e.target);btn.disabled=true;try{const r=await request("/api/import",{method:"POST",body:f});toast(`Importados: ${r.added}. Duplicados: ${r.duplicates}. Inválidos: ${r.invalid}.`);e.target.reset();refreshContacts();loadSummary()}catch(err){toast(err.message)}finally{btn.disabled=false}});
function renderRecipients(){loadContacts().then(renderRecipientList).catch(e=>toast(e.message))}
function renderRecipientList(){const q=($("#recipient-search").value||"").toLowerCase();const eligible=contacts.filter(c=>c.optIn);authorizedCount=eligible.length;const visible=eligible.filter(c=>(c.name+" "+c.phone+" "+(c.dni||"")).toLowerCase().includes(q));$("#send-recipients").innerHTML=visible.map(c=>`<label class="recipient"><input type="checkbox" class="recipient-check" value="${c.id}"${selectedRecipients.has(c.id)?" checked":""}><span>${esc(c.name||"Sin nombre")}<small>${esc(c.phone)}</small></span></label>`).join("")||(eligible.length?'<div class="recipient">Ningún cliente autorizado coincide con la búsqueda.</div>':'<div class="recipient">No hay clientes autorizados. Importá contactos y marcá su autorización.</div>');$$(".recipient-check").forEach(c=>c.onchange=()=>{c.checked?selectedRecipients.add(c.value):selectedRecipients.delete(c.value);updateSelected();scheduleDraftSave("send")});updateSelected()}
function updateSelected(){$("#selected-count").textContent=selectedRecipients.size;$("#recipient-summary").textContent="Seleccionados de "+authorizedCount+" autorizados"}
$("#recipient-search").addEventListener("input",renderRecipientList);
$("#select-all").onclick=()=>{$$(".recipient-check").forEach(c=>{c.checked=true;selectedRecipients.add(c.value)});updateSelected();scheduleDraftSave("send")};
$("#select-none").onclick=()=>{selectedRecipients.clear();$$(".recipient-check").forEach(c=>c.checked=false);updateSelected();scheduleDraftSave("send")};
function formatBytes(n){const b=Number(n)||0;return b>=1048576?(b/1048576).toFixed(1).replace(".",",")+" MB":Math.max(1,Math.round(b/1024))+" KB"}
function renderFilePreview(which){
  const isSend=which==="send";
  const input=$(isSend?"#send-file":"#status-file"),box=$(isSend?"#send-file-preview":"#status-file-preview");
  if(!input||!box)return;
  const urls=previewUrls[which];
  while(urls.length)URL.revokeObjectURL(urls.pop());
  const files=[...(input.files||[])];
  box.innerHTML="";
  box.classList.toggle("hidden",!files.length);
  if(!files.length)return;
  box.innerHTML=files.map(f=>{
    const isImage=!!(f.type&&f.type.startsWith("image/"));
    let thumb='<span class="file-icon" aria-hidden="true">▶</span>';
    if(isImage){const u=URL.createObjectURL(f);urls.push(u);thumb=`<img src="${u}" alt="">`}
    return `<div class="file-preview-item">${thumb}<span>${esc(f.name)} · ${formatBytes(f.size)}</span></div>`;
  }).join("");
}
$("#send-file").onchange=()=>renderFilePreview("send");
$("#status-file").onchange=()=>renderFilePreview("status");
$("#send-type").onchange=()=>{const isText=$("#send-type").value==="text";$("#send-file-wrap").classList.toggle("hidden",isText);$("#send-file").accept=$("#send-type").value==="video"?"video/mp4":"image/*";if(isText)$("#send-file").value="";renderFilePreview("send");$("#send-text").dispatchEvent(new Event("input"))};
function formatDuration(ms){const mins=Math.max(1,Math.ceil(ms/60000));return mins>=60?`${Math.floor(mins/60)} h ${mins%60} min`:`${mins} min`}
function saveLastJob(job){try{localStorage.setItem(LAST_JOB_KEY,JSON.stringify(job))}catch{}}
function loadLastJob(){try{const raw=localStorage.getItem(LAST_JOB_KEY);return raw?JSON.parse(raw):null}catch{return null}}
function failedDetails(j){
  const failed=(j.results||[]).filter(r=>r&&r.ok===false);
  if(!failed.length)return "";
  const items=failed.map(r=>`<li>${esc(r.name||"Sin nombre")} · ${esc(r.phone||"")}${r.error?" · "+esc(r.error):""}</li>`).join("");
  const note=j.truncated?'<p class="tiny muted">Mostrando solo los últimos resultados registrados.</p>':"";
  return `<details class="result-details"><summary>Ver detalle de ${failed.length} fallido${failed.length===1?"":"s"}</summary><ul class="fail-list">${items}</ul>${note}</details>`;
}
function showJobResult(j){
  const box=$("#send-result");
  box.classList.remove("hidden");
  const detail=failedDetails(j);
  if(j.status==="error"){
    box.classList.add("error");
    box.innerHTML=`<p class="job-summary">No se pudo completar el envío: ${esc(j.error||"error desconocido")}</p>${detail}`;
  }else{
    box.classList.remove("error");
    box.innerHTML=`<p class="job-summary">Proceso finalizado. Enviados: ${j.sent}. Fallidos: ${j.failed}.</p>${detail}`;
  }
  saveLastJob({jobId:j.id||j.jobId||(activeJob&&activeJob.jobId),total:j.total||(activeJob&&activeJob.total),estimatedMs:(activeJob&&activeJob.estimatedMs)||0,status:j.status,sent:j.sent,failed:j.failed,error:j.error,truncated:j.truncated,results:(j.results||[]).filter(r=>r&&r.ok===false).slice(0,20)});
}
function renderJobProgress(j,message){
  const box=$("#send-result");
  const total=Number(j.total)||0,processed=Number(j.processed)||0;
  const pct=total?Math.min(100,Math.round(processed/total*100)):0;
  let eta="";
  if(j.status==="queued"&&Number(j.queueWaitMs)>0)eta=`~${formatDuration(j.queueWaitMs)} de espera`;
  else if(activeJob&&activeJob.startedAt){
    const left=Number(activeJob.estimatedMs||0)-(Date.now()-activeJob.startedAt);
    if(left>0)eta=`quedan ~${formatDuration(left)}`;
  }
  const meta=`${processed}/${total} · Enviados: ${j.sent||0} · Fallidos: ${j.failed||0}`+(eta?"":" · Calculando tiempo restante...");
  box.innerHTML=`<div class="job-head"><span class="job-message">${esc(message)}</span>${eta?`<span class="job-eta">${esc(eta)}</span>`:""}</div><div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Progreso del envío"><div class="progress-bar" style="width:${pct}%"></div></div><div class="progress-meta">${esc(meta)}</div>`;
}
async function resetSendComposer(){
  applyingDraft=true;
  try{
    const f=DRAFT_FIELDS.send;
    const text=$(f.text)?.value||"";
    const type=$(f.type)?.value||"text";
    $("#send-file").value="";
    renderFilePreview("send");
    selectedRecipients.clear();
    if(contacts.length)renderRecipientList();else updateSelected();
    // Conservamos el texto para reutilizarlo, pero no la lista de destinatarios:
    // así no se envía dos veces a la misma gente por accidente.
    const r=await request("/api/drafts/send",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({text,type,recipientIds:[]})});
    if(r.cleared){
      lastDraftSavedAt.send=null;
      paintDraft("send",{message:"Sin borrador. Escribí y se guarda automáticamente."});
    }else{
      lastDraftSavedAt.send=r.updatedAt||new Date().toISOString();
      paintDraft("send",{message:"Borrador conservado para reutilizar",saved:true,updatedAt:lastDraftSavedAt.send,meta:draftMetaText("send",r)});
      toast("Borrador conservado para reutilizar");
    }
  }catch(e){
    // El resultado del envío no debe fallar porque no se pudo actualizar el borrador.
  }finally{applyingDraft=false}
}
async function monitorJob(jobId,total,estimatedMs=0){
  if(monitoringJob)return null;
  monitoringJob=true;
  activeJob={jobId,total,estimatedMs,startedAt:Date.now(),last:null};
  saveLastJob({jobId,total,estimatedMs,status:"running"});
  $("#track-job").classList.remove("hidden");
  const box=$("#send-result");
  const deadline=Date.now()+Math.max(30*60*1000,Number(estimatedMs||0)+10*60*1000);
  let delay=1000,errors=0;
  while(Date.now()<deadline){
    await sleep(delay);
    if(!monitoringJob)return null;
    let j;
    try{
      j=await request("/api/jobs/"+encodeURIComponent(jobId));
      errors=0;delay=1000;
    }catch(e){
      errors++;
      delay=Math.min(delay*2,15000);
      box.classList.add("error");
      box.textContent=`No se pudo consultar el estado (${e.message}). Reintentando...`;
      if(errors>=6){
        monitoringJob=false;
        box.textContent="No se pudo confirmar el estado del envío. Usá \"Ver estado del último envío\" para reintentar.";
        return null;
      }
      continue;
    }
    activeJob.last=j;
    if(j.status==="queued"){
      box.classList.remove("error");
      renderJobProgress(j,`En cola (puesto ${j.queuePosition||1}) · ${j.total} mensajes. Esperando al envío anterior...`);
      continue;
    }
    if(j.status==="running"){
      box.classList.remove("error");
      renderJobProgress(j,`Procesando ${j.processed}/${j.total} · Enviados: ${j.sent} · Fallidos: ${j.failed}`);
      continue;
    }
    monitoringJob=false;
    await resetSendComposer();
    showJobResult(j);
    loadSummary();
    return j;
  }
  monitoringJob=false;
  box.classList.add("error");
  box.textContent="El envío sigue en curso. Podés seguir consultando con \"Ver estado del último envío\".";
  return null;
}
$("#send-button").onclick=async()=>{
  const ids=[...selectedRecipients];
  if(!ids.length)return toast("Seleccioná al menos un cliente autorizado.");
  const type=$("#send-type").value;
  const files=type==="text"?[]:[...$("#send-file").files];
  if(type!=="text"&&!files.length)return toast("Adjuntá al menos una imagen o video.");
  if(files.length>maxSendFiles)return toast(`No podés adjuntar más de ${maxSendFiles} archivos.`);
  const messages=ids.length*Math.max(1,files.length);
  const rawFirst=$("#send-text").value.split("\n").find(l=>l.trim())||"(sin texto)";
  const firstLine=rawFirst.slice(0,80)+(rawFirst.length>80?"…":"");
  const detail={lines:[`Texto: ${firstLine}`,`${ids.length} destinatario${ids.length===1?"":"s"}`,files.length?`${files.length} archivo${files.length===1?"":"s"} por cliente`:"Solo texto",files.length>1?"El pie de texto se envía solo con el primer archivo.":null].filter(Boolean),files};
  if(!await askConfirm(`Vas a enviar ${messages} mensaje${messages===1?"":"s"} a ${ids.length} cliente${ids.length===1?"":"s"}${files.length>1?" ("+files.length+" archivos por cliente)":""}. ¿Continuar?`,{title:"Confirmar envío",acceptLabel:"Enviar",detail}))return;
  const fd=new FormData();
  fd.append("type",type);
  fd.append("text",$("#send-text").value);
  fd.append("ids",JSON.stringify(ids));
  files.forEach(f=>fd.append("files",f));
  const b=$("#send-button"),box=$("#send-result");
  const key=campaignKey(type,$("#send-text").value,ids,files);
  b.disabled=true;b.textContent="Enviando...";
  box.classList.remove("hidden","error");box.textContent="Preparando el envío...";
  try{
    const start=await request("/api/send",{method:"POST",body:fd,headers:{"Idempotency-Key":key}});
    box.textContent=start.reused?`Reanudando envío anterior (${start.total} mensajes)...`:start.queued?`En cola (puesto ${start.queuePosition}) · ${start.total} mensajes...`:`Procesando 0/${start.total}...`;
    await monitorJob(start.jobId,start.total,start.estimatedMs);
  }catch(e){
    box.classList.remove("hidden");box.classList.add("error");box.textContent=e.message;
  }finally{b.disabled=false;b.textContent="Enviar promoción"}
};
$("#track-job").onclick=async()=>{
  if(monitoringJob)return toast("El envío ya se está siguiendo.");
  if(!activeJob)return toast("No hay un envío reciente para consultar.");
  if(activeJob.status&&activeJob.status!=="running"&&activeJob.status!=="queued")return showJobResult(activeJob);
  if(activeJob.last&&activeJob.last.status!=="running"&&activeJob.last.status!=="queued")return showJobResult(activeJob.last);
  try{
    const j=await request("/api/jobs/"+encodeURIComponent(activeJob.jobId));
    if(j.status!=="running"&&j.status!=="queued"){activeJob.last=j;return showJobResult(j)}
  }catch{}
  $("#send-result").classList.remove("hidden");
  await monitorJob(activeJob.jobId,activeJob.total,activeJob.estimatedMs);
};
$("#status-type").onchange=()=>{const isText=$("#status-type").value==="text";$("#status-file-wrap").classList.toggle("hidden",isText);$("#status-file").accept=$("#status-type").value==="video"?"video/mp4":"image/*";if(isText)$("#status-file").value="";renderFilePreview("status");$("#status-text").dispatchEvent(new Event("input"))};
$("#status-button").onclick=async()=>{
  const type=$("#status-type").value,file=$("#status-file").files[0];
  if(type!=="text"&&!file)return toast("Adjuntá una imagen o video para el estado.");
  const rawFirst=$("#status-text").value.split("\n").find(l=>l.trim())||"(sin texto)";
  const firstLine=rawFirst.slice(0,80)+(rawFirst.length>80?"…":"");
  const detail={lines:[`Texto: ${firstLine}`,file?`Archivo: ${file.name}`:"Solo texto"].filter(Boolean),files:file?[file]:[]};
  if(!await askConfirm("¿Publicar este contenido en el Estado de WhatsApp del número conectado?",{title:"Publicar estado",acceptLabel:"Publicar",detail}))return;
  const fd=new FormData();fd.append("type",type);fd.append("text",$("#status-text").value);if(file)fd.append("file",file);
  const b=$("#status-button");b.disabled=true;b.textContent="Publicando...";
  try{await request("/api/status",{method:"POST",body:fd});$("#status-file").value="";renderFilePreview("status");$("#status-result").classList.remove("hidden","error");$("#status-result").textContent="Solicitud de publicación enviada a WhatsApp.";toast("Estado enviado")}catch(e){$("#status-result").classList.remove("hidden");$("#status-result").classList.add("error");$("#status-result").textContent=e.message}finally{b.disabled=false;b.textContent="Publicar estado"}
};
function historyKind(x){return x.kind==="chat"?"message":x.kind||"message"}
function historyKindLabel(kind){return kind==="message"?"Mensaje":kind==="status"?"Estado":"Conexión"}
function historyTypeLabel(kind,type){
  const t=String(type||"").toLowerCase();
  if(kind==="connection")return ({qr:"QR",pairing:"Código de vinculación",disconnect:"Desvinculación"})[t]||"Conexión";
  return ({text:"Texto",image:"Imagen",video:"Video"})[t]||"Registro";
}
function historyStatus(x){
  if(x.ok===true)return{pill:"yes",label:"Procesado"};
  if(x.ok===false)return{pill:"no",label:"Error"};
  return{pill:"",label:"Registrado"};
}
function historyDetail(x,kind){
  const error=x.error?`<span class="history-error">${esc(x.error)}</span>`:"";
  if(kind==="message"){
    const phone=x.phone?`<small>${esc(x.phone)}</small>`:"";
    return `<span class="history-detail"><strong>${esc(x.name||"Cliente")}</strong>${phone}${error}</span>`;
  }
  if(kind==="status")return `<span class="history-detail"><strong>Publicación de estado</strong><small>Cuenta conectada</small>${error}</span>`;
  return `<span class="history-detail"><strong>${esc(x.name||"Actividad de conexión")}</strong>${error}</span>`;
}
async function loadHistory(append=false){
  const btn=$("#history-refresh"),more=$("#history-more"),summary=$("#history-summary");
  if(btn)btn.disabled=true;
  if(more&&append)more.disabled=true;
  if(!append&&summary)summary.textContent="Cargando historial...";
  try{
    const nextLimit=append?historyLimit+HISTORY_PAGE_SIZE:HISTORY_PAGE_SIZE;
    // listHistory(limit) devuelve los últimos N registros (no un offset):
    // al pedir un limit mayor ya vienen los anteriores, así que reemplazamos.
    const rows=await request("/api/history?limit="+nextLimit);
    historyRows=rows;
    historyLimit=nextLimit;
    renderHistory();
  }catch(e){
    if(summary)summary.textContent="No se pudo cargar el historial.";
    toast(e.message);
  }finally{
    if(btn)btn.disabled=false;
    if(more)more.disabled=false;
  }
}
// La fecha completa se mantiene accesible: en celular se oculta visualmente y
// la corta se marca aria-hidden para que los lectores no lean dos veces lo mismo.
function historyDate(at){
  const d=new Date(at),valid=!Number.isNaN(d.getTime());
  const iso=valid?d.toISOString():String(at??"");
  const full=valid?d.toLocaleString():iso;
  const short=valid?d.toLocaleString(undefined,{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}):iso;
  return `<time class="history-date-full" datetime="${esc(iso)}" title="${esc(full)}">${esc(full)}</time><time class="history-date-short" datetime="${esc(iso)}" title="${esc(full)}" aria-hidden="true">${esc(short)}</time>`;
}
function renderHistory(){
  const q=($("#history-search").value||"").toLowerCase().trim();
  const kind=$("#history-kind").value,result=$("#history-result").value;
  const rows=historyRows.filter(x=>{
    const k=historyKind(x);
    if(kind&&k!==kind)return false;
    if(result==="ok"&&x.ok!==true)return false;
    if(result==="error"&&x.ok!==false)return false;
    if(!q)return true;
    const haystack=[historyKindLabel(k),historyTypeLabel(k,x.type),x.type,x.name,x.phone,x.error,new Date(x.at).toLocaleString()].join(" ");
    return haystack.toLowerCase().includes(q);
  });
  const summary=$("#history-summary");
  if(summary){
    const total=historyTotal||historyRows.length;
    summary.textContent=historyRows.length
      ? `Mostrando ${rows.length} de ${total} registros${rows.length!==historyRows.length?" (filtrados)":""}.`
      : "Todavía no hay actividad.";
  }
  const more=$("#history-more");
  if(more){
    const remaining=Math.max(0,(historyTotal||0)-historyRows.length);
    more.classList.toggle("hidden",remaining<=0);
    more.textContent=`Cargar más registros (${Math.min(HISTORY_PAGE_SIZE,remaining)})`;
  }
  $("#history-body").innerHTML=rows.map(x=>{
    const k=historyKind(x),st=historyStatus(x),type=historyTypeLabel(k,x.type);
    return `<tr><td data-label="Fecha">${historyDate(x.at)}</td><td data-label="Acción">${historyKindLabel(k)} · ${esc(type)}</td><td data-label="Detalle">${historyDetail(x,k)}</td><td data-label="Estado"><span class="pill${st.pill?" "+st.pill:""}">${st.label}</span></td></tr>`;
  }).join("")||(historyRows.length?'<tr><td colspan="4">Ningún registro coincide con los filtros.</td></tr>':'<tr><td colspan="4">Todavía no hay actividad.</td></tr>');
}
$("#history-search").addEventListener("input",renderHistory);
$("#history-kind").addEventListener("change",renderHistory);
$("#history-result").addEventListener("change",renderHistory);
$("#history-refresh").addEventListener("click",()=>{loadSummary();loadHistory()});
$("#history-more").addEventListener("click",()=>loadHistory(true));
function formatOwner(owner){const d=String(owner||"").replace(/\D/g,"");return d?"+"+d:""}
function hideLinkBoxes(){
  const qr=$("#qr-box"),pair=$("#pairing-box");
  if(qr)qr.classList.add("hidden");
  if(pair)pair.classList.add("hidden");
  const img=$("#qr-image");if(img)img.removeAttribute("src");
  const dl=$("#qr-download");
  if(dl){dl.removeAttribute("href");dl.setAttribute("aria-disabled","true");dl.setAttribute("tabindex","-1");dl.download="whatsapp-qr.png"}
  const qe=$("#qr-expiry");if(qe)qe.textContent="";
  const pe=$("#pairing-expiry");if(pe)pe.textContent="El código vence en pocos minutos.";
  linkKind=null;linkExpiresAt=0;
}
function stopConnectionWatch(){if(connectionWatch){clearInterval(connectionWatch);connectionWatch=null}connectionPollTick=0}
function updateLinkCountdown(){
  if(!linkKind||!linkExpiresAt)return;
  const left=linkExpiresAt-Date.now();
  if(left<=0){
    const was=linkKind;
    hideLinkBoxes();stopConnectionWatch();
    toast(was==="qr"?"El QR venció. Generá uno nuevo.":"El código venció. Generá uno nuevo.");
    return;
  }
  const mins=Math.floor(left/60000),secs=Math.floor((left%60000)/1000);
  const text=`Vence en ${mins}:${String(secs).padStart(2,"0")}.`;
  const el=linkKind==="qr"?$("#qr-expiry"):$("#pairing-expiry");
  if(el)el.textContent=text;
}
function startConnectionWatch(){
  if(connectionWatch)return;
  connectionPollTick=0;
  connectionWatch=setInterval(async()=>{
    if($("#page-connection").classList.contains("hidden")||document.visibilityState!=="visible")return;
    updateLinkCountdown();
    if(!linkKind){stopConnectionWatch();return}
    connectionPollTick++;
    if(connectionPollTick%5===0)await loadConnection({silent:true});
  },1000);
}
function applyConnection(r,{silent=false}={}){
  const connected=!!r.connected;
  const dot=$("#connection-dot"),title=$("#connection-title"),detail=$("#connection-detail"),account=$("#connection-account");
  dot.classList.toggle("ok",connected);
  if(r.configured===false){
    title.textContent="Evolution API sin configurar";
    detail.textContent="Configurá EVOLUTION_URL, EVOLUTION_API_KEY y EVOLUTION_INSTANCE en el servidor.";
  }else{
    title.textContent=connected?"Conectado a WhatsApp":"WhatsApp sin conexión";
    detail.textContent=r.error||(connected?"La sesión está activa y lista para enviar.":"Vinculá un número para empezar a enviar.");
  }
  if(connected&&(r.owner||r.profileName)){
    $("#connection-name").textContent=r.profileName||"Cuenta de WhatsApp";
    $("#connection-number").textContent=formatOwner(r.owner);
    account.classList.remove("hidden");
  }else account.classList.add("hidden");
  $("#disconnect-button").classList.toggle("hidden",!connected);
  if(connected){
    const hadLink=!!linkKind;
    hideLinkBoxes();stopConnectionWatch();
    if(hadLink&&!silent)toast("WhatsApp vinculado");
  }else if(linkKind)startConnectionWatch();
  return connected;
}
async function loadConnection({silent=false}={}){
  try{const r=await request("/api/connection");updateSendConnection(r);return applyConnection(r,{silent})}
  catch(e){
    $("#connection-title").textContent="No se pudo consultar";
    $("#connection-detail").textContent=e.message;
    $("#connection-account").classList.add("hidden");
    $("#disconnect-button").classList.add("hidden");
    updateSendConnection({connected:false,error:e.message});
    return false;
  }
}
// Chip de Enviar: evita armar toda una campaña con WhatsApp desvinculado.
function updateSendConnection(r){
  const dot=$("#send-connection-dot"),text=$("#send-connection-text");
  if(!dot||!text)return;
  const configured=r.configured!==false,connected=!!r.connected;
  dot.classList.toggle("ok",connected);
  dot.classList.toggle("warn",configured&&!connected);
  text.textContent=!configured?"Evolution API sin configurar":connected?"WhatsApp conectado · listo para enviar":`WhatsApp sin conexión${r.error?" · "+r.error:""} · vinculá antes de enviar`;
}
async function requestConnect(payload,button){
  if(button.disabled)return null;
  const original=button.textContent;
  button.disabled=true;button.textContent="Generando...";
  try{
    let r=await request("/api/connect",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload||{})});
    if(r.needsCreate){
      if(!await askConfirm(r.error||"La instancia no existe. ¿Crearla?",{title:"Crear instancia",acceptLabel:"Crear"}))return null;
      r=await request("/api/connect",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...(payload||{}),create:true})});
    }
    if(!r.ok)throw new Error(r.error||"No se pudo generar la vinculación.");
    return r;
  }finally{button.disabled=false;button.textContent=original}
}
$("#refresh-connection").onclick=()=>loadConnection();
$("#disconnect-button").onclick=async()=>{if(!await askConfirm("¿Desvincular este número de WhatsApp? Vas a tener que volver a vincularlo para enviar mensajes.",{title:"Desvincular WhatsApp",acceptLabel:"Desvincular",danger:true}))return;const b=$("#disconnect-button");b.disabled=true;b.textContent="Desvinculando...";try{await request("/api/disconnect",{method:"POST"});toast("Número desvinculado");hideLinkBoxes();stopConnectionWatch();await loadConnection()}catch(e){toast(e.message)}finally{b.disabled=false;b.textContent="Desvincular"}};
$("#connect-button").onclick=async()=>{try{const r=await requestConnect({},$("#connect-button"));if(!r)return;if(!r.qr){hideLinkBoxes();toast("Evolution API no devolvió un QR. Revisá la instancia y su estado.");return}hideLinkBoxes();$("#qr-image").src=r.qr;const dl=$("#qr-download");if(dl){dl.href=r.qr;dl.download="whatsapp-qr."+(r.qrMime==="image/svg+xml"?"svg":"png");dl.removeAttribute("aria-disabled");dl.removeAttribute("tabindex")}linkKind="qr";linkExpiresAt=Date.now()+linkTtlMs;$("#qr-box").classList.remove("hidden");updateLinkCountdown();startConnectionWatch()}catch(e){toast(e.message)}};
function formatPairing(code){const c=String(code||"").replace(/\s/g,"");return c.length===8?c.slice(0,4)+"-"+c.slice(4):c}
$("#pairing-button").onclick=async()=>{const input=$("#connect-phone"),number=input.value.trim();if(!number){toast("Escribí el número de WhatsApp con código de país.");return}try{const r=await requestConnect({number},$("#pairing-button"));if(!r)return;if(!r.pairingCode){hideLinkBoxes();toast("Evolution no devolvió un código. Puede que la instancia ya esté en modo QR: probá de nuevo en unos segundos o usá el QR.");return}hideLinkBoxes();$("#pairing-code").textContent=formatPairing(r.pairingCode);linkKind="pairing";linkExpiresAt=Date.now()+linkTtlMs;$("#pairing-box").classList.remove("hidden");updateLinkCountdown();startConnectionWatch();toast("Código generado. Ingresalo en WhatsApp.")}catch(e){toast(e.message)}};
collapseHomeNotice();
loadSummary();
loadConnection({silent:true});
// Si la página se recargó durante un envío, retomamos el seguimiento guardado.
(async function restoreLastJob(){
  const saved=loadLastJob();
  if(!saved||!saved.jobId)return;
  activeJob=saved;
  $("#track-job").classList.remove("hidden");
  try{
    const j=await request("/api/jobs/"+encodeURIComponent(saved.jobId));
    if(j.status!=="running"&&j.status!=="queued"){activeJob.last=j;showJobResult(j);return}
  }catch{}
  monitorJob(saved.jobId,saved.total,saved.estimatedMs);
})();
