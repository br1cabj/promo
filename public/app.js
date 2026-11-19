const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let contacts = [];
let toastTimer;
let selectedRecipients = new Set();
let authorizedCount = 0;
let focusBeforeModal = null;
let focusBeforeConfirm = null;
let confirmResolver = null;
const MAX_TEXT = 4096, MAX_CAPTION = 1024;
let maxSendFiles = 10;
let activeJob = null;          // último job enviado, para poder reanudar el seguimiento
let monitoringJob = false;
let pendingSendKey = null;     // idempotencia: reutilizar si se pierde la respuesta
let linkTtlMs = 5 * 60 * 1000; // lo ajusta /api/summary
let connectionWatch = null;
let connectionPollTick = 0;
let linkKind = null;           // "qr" | "pairing"
let linkExpiresAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function toast(msg,action){const el=$("#toast");el.innerHTML="";const span=document.createElement("span");span.textContent=msg;el.appendChild(span);if(action){const btn=document.createElement("button");btn.type="button";btn.className="toast-action";btn.textContent=action.label;btn.onclick=()=>{clearTimeout(toastTimer);el.classList.remove("show");action.onClick()};el.appendChild(btn)}el.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),action?7000:2800)}
async function request(url, options={}){const r=await fetch(url,options);let data={};try{data=await r.json()}catch{}if(r.status===401){window.location.href="/login";throw new Error("Sesión expirada")}if(!r.ok)throw new Error(data.error||"Ocurrió un error");return data}
// Busca el botón que dispara el submit aunque el HTML no lleve type="submit".
function submitButton(form){return form.querySelector('button[type="submit"]')||form.querySelector('button:not([type])')||form.querySelector('button')}
function showPage(name){$$(".page").forEach(p=>p.classList.add("hidden"));$("#page-"+name).classList.remove("hidden");$$(".nav").forEach(b=>b.classList.toggle("active",b.dataset.page===name));$("#page-title").textContent=({home:"Inicio",contacts:"Clientes",send:"Enviar mensaje",status:"Estados",history:"Historial",connection:"WhatsApp"})[name];if(name==="contacts")refreshContacts();if(name==="send")renderRecipients();if(name==="history")loadHistory();if(name==="connection")loadConnection();else stopConnectionWatch()}
$$(".nav").forEach(b=>b.addEventListener("click",()=>showPage(b.dataset.page)));
$$(".quick").forEach(b=>b.addEventListener("click",()=>showPage(b.dataset.go)));
async function loadSummary(){try{const s=await request("/api/summary");$("#stat-total").textContent=s.total;$("#stat-optin").textContent=s.optedIn;$("#stat-history").textContent=s.history;if(Number(s.maxSendFiles)>0)maxSendFiles=Number(s.maxSendFiles);if(Number(s.linkTtlMs)>0)linkTtlMs=Number(s.linkTtlMs)}catch(e){toast(e.message)}}
async function loadContacts(){contacts=await request("/api/contacts");pruneSelected();return contacts}
// Quita de la selección los contactos que ya no existen o perdieron la
// autorización: así el contador y el confirm coinciden con lo que envía el API.
function pruneSelected(){const valid=new Set(contacts.filter(c=>c.optIn).map(c=>c.id));for(const id of [...selectedRecipients])if(!valid.has(id))selectedRecipients.delete(id)}
async function refreshContacts(){try{await loadContacts();renderContacts();updateSelected()}catch(e){toast(e.message)}}
function renderContacts(){const q=($("#contact-search").value||"").toLowerCase();const rows=contacts.filter(c=>(c.name+" "+c.phone+" "+(c.dni||"")).toLowerCase().includes(q));$("#contacts-body").innerHTML=rows.map(c=>`<tr><td data-label="Nombre">${esc(c.name||"Sin nombre")}</td><td data-label="Teléfono">${esc(c.phone)}</td><td data-label="DNI">${esc(c.dni||"—")}</td><td data-label="Autorizado"><span class="pill ${c.optIn?"yes":"no"}">${c.optIn?"Sí":"No"}</span></td><td data-label="Acciones"><button class="small-btn" data-edit="${c.id}">Editar</button><button class="small-btn" data-toggle="${c.id}">${c.optIn?"Quitar permiso":"Marcar autorizado"}</button><button class="small-btn" data-delete="${c.id}">Eliminar</button></td></tr>`).join("")||'<tr><td colspan="5">No hay clientes para mostrar.</td></tr>';$("#contacts-body").querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>openEdit(b.dataset.edit));$("#contacts-body").querySelectorAll("[data-toggle]").forEach(b=>b.onclick=async()=>{const c=contacts.find(x=>x.id===b.dataset.toggle);try{await request("/api/contacts/"+c.id,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({optIn:!c.optIn})});refreshContacts();loadSummary()}catch(e){toast(e.message)}});$("#contacts-body").querySelectorAll("[data-delete]").forEach(b=>b.onclick=async()=>{const c=contacts.find(x=>x.id===b.dataset.delete);if(!c)return;try{await request("/api/contacts/"+c.id,{method:"DELETE"});selectedRecipients.delete(c.id);refreshContacts();loadSummary();toast("Cliente eliminado",{label:"Deshacer",onClick:()=>restoreContact(c)})}catch(e){toast(e.message)}})}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
let searchTimer;$("#contact-search").addEventListener("input",()=>{clearTimeout(searchTimer);searchTimer=setTimeout(renderContacts,200)});
function csvCell(v){const s=String(v??"");return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}
async function exportContacts(){try{if(!contacts.length)await loadContacts();if(!contacts.length)return toast("No hay clientes para exportar.");const rows=[["nombre","telefono","dni","optin"]];for(const c of contacts)rows.push([c.name||"",c.phone||"",c.dni||"",c.optIn?"si":"no"]);const csv="\uFEFF"+rows.map(r=>r.map(csvCell).join(",")).join("\r\n")+"\r\n";const blob=new Blob([csv],{type:"text/csv;charset=utf-8"});const url=URL.createObjectURL(blob);const d=new Date();const stamp=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");const a=document.createElement("a");a.href=url;a.download="clientes-"+stamp+".csv";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);toast("Exportados "+contacts.length+" clientes.")}catch(e){toast(e.message)}}
$("#export-contacts").onclick=exportContacts;
function openEdit(id){const c=contacts.find(x=>x.id===id);if(!c)return;focusBeforeModal=document.activeElement;const f=$("#edit-contact");f.elements.id.value=c.id;f.elements.name.value=c.name||"";f.elements.phone.value=c.phone||"";f.elements.dni.value=c.dni||"";f.elements.optIn.checked=!!c.optIn;$("#edit-modal").classList.remove("hidden");f.elements.name.focus()}
function closeEdit(){const modal=$("#edit-modal");if(modal.classList.contains("hidden"))return;modal.classList.add("hidden");if(focusBeforeModal&&typeof focusBeforeModal.focus==="function")focusBeforeModal.focus();focusBeforeModal=null}
// Confirmaciones accesibles, en reemplazo del diálogo nativo.
function askConfirm(message,{title="Confirmar acción",acceptLabel="Confirmar",danger=false}={}){
  if(confirmResolver)return Promise.resolve(false);
  const modal=$("#confirm-modal");
  $("#confirm-modal-title").textContent=title;
  $("#confirm-modal-message").textContent=message;
  const accept=$("#confirm-accept");
  accept.textContent=acceptLabel;
  accept.classList.toggle("danger",!!danger);
  focusBeforeConfirm=document.activeElement;
  modal.classList.remove("hidden");
  accept.focus();
  return new Promise(resolve=>{confirmResolver=resolve});
}
function closeConfirm(result){
  const modal=$("#confirm-modal");
  if(modal.classList.contains("hidden"))return;
  modal.classList.add("hidden");
  const resolve=confirmResolver;confirmResolver=null;
  if(focusBeforeConfirm&&typeof focusBeforeConfirm.focus==="function")focusBeforeConfirm.focus();
  focusBeforeConfirm=null;
  if(resolve)resolve(!!result);
}
// Mantiene el foco dentro del modal mientras está abierto.
function trapModalFocus(ev){
  if(ev.key!=="Tab")return;
  const confirm=$("#confirm-modal"),edit=$("#edit-modal");
  const modal=!confirm.classList.contains("hidden")?confirm:!edit.classList.contains("hidden")?edit:null;
  if(!modal)return;
  const items=[...modal.querySelectorAll("button, input, select, textarea, a[href]")].filter(el=>!el.disabled&&el.offsetParent!==null);
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
function attachFormatting(){$$(".format-toolbar").forEach(tb=>{const ta=document.getElementById(tb.dataset.formatTarget);if(!ta)return;const preview=document.querySelector('[data-preview-for="'+tb.dataset.formatTarget+'"]');const counter=document.querySelector('[data-count-for="'+tb.dataset.formatTarget+'"]');const typeSel=document.getElementById(tb.dataset.formatTarget==="send-text"?"send-type":"status-type");const update=()=>{if(preview)preview.innerHTML=ta.value.trim()?renderWhatsApp(ta.value):'<span class="muted">La vista previa aparecerá acá a medida que escribas.</span>';if(counter){const n=ta.value.length;const isText=!!(typeSel&&typeSel.value==="text");const max=isText?MAX_TEXT:MAX_CAPTION;counter.textContent=n+" / "+max+" caracteres"+(n>max?" · supera el límite para "+(isText?"mensajes de texto":"imágenes y videos"):"");counter.classList.toggle("warn",n>max)}};tb.querySelectorAll("button[data-fmt]").forEach(btn=>{btn.setAttribute("aria-label",btn.title||btn.textContent);btn.onclick=()=>{applyFormat(ta,btn.dataset.fmt);ta.dispatchEvent(new Event("input"));update()}});const wrap=document.createElement("span");wrap.className="emoji-wrap";const ebtn=document.createElement("button");ebtn.type="button";ebtn.className="emoji-btn";ebtn.title="Insertar emoji";ebtn.setAttribute("aria-label","Insertar emoji");ebtn.textContent="😀";const panel=document.createElement("div");panel.className="emoji-panel hidden";EMOJI_GROUPS.forEach(g=>{const t=document.createElement("div");t.className="emoji-group-title";t.textContent=g.name;panel.appendChild(t);const grid=document.createElement("div");grid.className="emoji-grid";g.items.forEach(e=>{const b=document.createElement("button");b.type="button";b.className="emoji-item";b.textContent=e;b.setAttribute("aria-label","Emoji "+e);b.onclick=()=>{insertAtCursor(ta,e);ta.dispatchEvent(new Event("input"));update();if(window.matchMedia("(max-width:650px)").matches)closeEmojiPanels()};grid.appendChild(b)});panel.appendChild(grid)});ebtn.onclick=ev=>{ev.stopPropagation();const open=!panel.classList.contains("hidden");closeEmojiPanels();if(!open)panel.classList.remove("hidden")};document.addEventListener("click",ev=>{if(!wrap.contains(ev.target))panel.classList.add("hidden")});wrap.appendChild(ebtn);wrap.appendChild(panel);tb.appendChild(wrap);ta.addEventListener("input",update);update()})}
document.addEventListener("keydown",ev=>{if(ev.key==="Escape"){closeEmojiPanels();closeEdit();closeConfirm(false)}trapModalFocus(ev)});
attachFormatting();
// --- Borradores de redacción (se guardan en el servidor) --------------------
// El borrador vive en el servidor (SQLite), así está disponible desde la PC y
// el celular. Guardamos texto, tipo y destinatarios; nunca imágenes ni videos.
const DRAFT_FIELDS={send:{text:"#send-text",type:"#send-type"},status:{text:"#status-text",type:"#status-type"}};
const draftTimers={};
let applyingDraft=false;
function setDraftStatus(section,text,saved){const el=document.querySelector('[data-draft-status="'+section+'"]');if(!el)return;el.textContent=text;el.classList.toggle("saved",!!saved)}
function draftPayload(section){const f=DRAFT_FIELDS[section];return{text:$(f.text)?.value||"",type:$(f.type)?.value||"text",recipientIds:section==="send"?[...selectedRecipients]:[]}}
async function saveDraftNow(section){if(applyingDraft)return;clearTimeout(draftTimers[section]);delete draftTimers[section];try{const r=await request("/api/drafts/"+section,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(draftPayload(section))});setDraftStatus(section,r.cleared?"Sin borrador":"Borrador guardado",!r.cleared)}catch(e){setDraftStatus(section,"No se pudo guardar el borrador")}}
function scheduleDraftSave(section){if(applyingDraft)return;setDraftStatus(section,"Guardando…");clearTimeout(draftTimers[section]);draftTimers[section]=setTimeout(()=>saveDraftNow(section),800)}
function flushDrafts(){for(const section of Object.keys(draftTimers)){clearTimeout(draftTimers[section]);delete draftTimers[section];try{fetch("/api/drafts/"+section,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(draftPayload(section)),keepalive:true})}catch{}}}
function applyDraft(section,draft){const f=DRAFT_FIELDS[section];if(!f)return;clearTimeout(draftTimers[section]);delete draftTimers[section];applyingDraft=true;try{const ta=$(f.text);if(ta){ta.value=draft.text||"";ta.dispatchEvent(new Event("input"))}const sel=$(f.type);if(sel){sel.value=["text","image","video"].includes(draft.type)?draft.type:"text";sel.dispatchEvent(new Event("change"))}if(section==="send"){selectedRecipients=new Set(Array.isArray(draft.recipientIds)?draft.recipientIds:[]);if(contacts.length)renderRecipientList()}const has=!!(draft.text||(draft.recipientIds&&draft.recipientIds.length));setDraftStatus(section,has?"Borrador restaurado":"Sin borrador",has)}finally{applyingDraft=false}}
async function loadDrafts(){try{const list=await request("/api/drafts");list.forEach(d=>applyDraft(d.section,d))}catch{}}
async function clearDraft(section){const f=DRAFT_FIELDS[section];if(!f)return;clearTimeout(draftTimers[section]);delete draftTimers[section];applyingDraft=true;try{const ta=$(f.text);if(ta){ta.value="";ta.dispatchEvent(new Event("input"))}const sel=$(f.type);if(sel){sel.value="text";sel.dispatchEvent(new Event("change"))}if(section==="send"){selectedRecipients.clear();if(contacts.length)renderRecipientList()}await request("/api/drafts/"+section,{method:"DELETE"});setDraftStatus(section,"Borrador vaciado");toast("Borrador vaciado")}catch(e){toast(e.message)}finally{applyingDraft=false}}
["send","status"].forEach(section=>{const f=DRAFT_FIELDS[section];const ta=$(f.text);if(ta)ta.addEventListener("input",()=>scheduleDraftSave(section));const sel=$(f.type);if(sel)sel.addEventListener("change",()=>scheduleDraftSave(section))});
$$("[data-draft-clear]").forEach(b=>b.onclick=()=>clearDraft(b.dataset.draftClear));
window.addEventListener("pagehide",flushDrafts);
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="hidden")flushDrafts()});
loadDrafts();
// --- Plantillas de texto (mensajes ya escritos, preseleccionables) ----------
const templateCache={send:[],status:[]};
const selectedTemplate={send:"",status:""};
function updateTemplateButtons(sec){const has=!!selectedTemplate[sec];const save=document.querySelector('[data-template-save="'+sec+'"]');const del=document.querySelector('[data-template-delete="'+sec+'"]');if(save)save.textContent=has?"Actualizar plantilla":"Guardar como plantilla";if(del)del.classList.toggle("hidden",!has)}
function fillTemplateSelect(sec){const sel=document.querySelector('[data-template-for="'+sec+'"]');if(!sel)return;const cur=selectedTemplate[sec];sel.innerHTML='<option value="">Plantilla…</option>'+templateCache[sec].map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join("");const valid=cur&&templateCache[sec].some(t=>t.id===cur);sel.value=valid?cur:"";if(!valid)selectedTemplate[sec]="";updateTemplateButtons(sec)}
async function loadTemplates(){try{const list=await request("/api/templates");["send","status"].forEach(sec=>{templateCache[sec]=list;fillTemplateSelect(sec)})}catch{}}
$$("[data-template-for]").forEach(sel=>{sel.onchange=()=>{const sec=sel.dataset.templateFor;const id=sel.value;selectedTemplate[sec]=id;if(id){const t=templateCache[sec].find(x=>x.id===id);if(t){const ta=$(DRAFT_FIELDS[sec].text);ta.value=t.text;ta.dispatchEvent(new Event("input"));scheduleDraftSave(sec)}}updateTemplateButtons(sec)}});
$$("[data-template-save]").forEach(b=>b.onclick=async()=>{const sec=b.dataset.templateSave;const ta=$(DRAFT_FIELDS[sec].text);const text=ta.value.trim();if(!text)return toast("Escribí el texto antes de guardarlo como plantilla.");const cur=selectedTemplate[sec];const existing=cur?templateCache[sec].find(t=>t.id===cur):null;const name=prompt("Nombre de la plantilla:",existing?existing.name:"");if(name==null)return;try{if(existing){await request("/api/templates/"+existing.id,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name.trim()||existing.name,text})});toast("Plantilla actualizada")}else{const created=await request("/api/templates",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name.trim(),text})});selectedTemplate[sec]=created.id;toast("Plantilla guardada")}await loadTemplates()}catch(e){toast(e.message)}});
$$("[data-template-delete]").forEach(b=>b.onclick=async()=>{const sec=b.dataset.templateDelete;const id=selectedTemplate[sec];if(!id)return;const t=templateCache[sec].find(x=>x.id===id);if(!await askConfirm(`¿Eliminar la plantilla "${t?t.name:""}"?`,{title:"Eliminar plantilla",acceptLabel:"Eliminar",danger:true}))return;try{await request("/api/templates/"+id,{method:"DELETE"});selectedTemplate[sec]="";toast("Plantilla eliminada");await loadTemplates()}catch(e){toast(e.message)}});
loadTemplates();
$("#add-contact").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.target);const btn=submitButton(e.target);btn.disabled=true;try{await request("/api/contacts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:f.get("name"),phone:f.get("phone"),dni:f.get("dni"),optIn:f.has("optIn")})});e.target.reset();toast("Cliente guardado");refreshContacts();loadSummary()}catch(err){toast(err.message)}finally{btn.disabled=false}});
$("#import-form").addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.target);const btn=submitButton(e.target);btn.disabled=true;try{const r=await request("/api/import",{method:"POST",body:f});toast(`Importados: ${r.added}. Duplicados: ${r.duplicates}. Inválidos: ${r.invalid}.`);e.target.reset();refreshContacts();loadSummary()}catch(err){toast(err.message)}finally{btn.disabled=false}});
function renderRecipients(){loadContacts().then(renderRecipientList).catch(e=>toast(e.message))}
function renderRecipientList(){const q=($("#recipient-search").value||"").toLowerCase();const eligible=contacts.filter(c=>c.optIn);authorizedCount=eligible.length;const visible=eligible.filter(c=>(c.name+" "+c.phone+" "+(c.dni||"")).toLowerCase().includes(q));$("#send-recipients").innerHTML=visible.map(c=>`<label class="recipient"><input type="checkbox" class="recipient-check" value="${c.id}"${selectedRecipients.has(c.id)?" checked":""}><span>${esc(c.name||"Sin nombre")}<small>${esc(c.phone)}</small></span></label>`).join("")||(eligible.length?'<div class="recipient">Ningún cliente autorizado coincide con la búsqueda.</div>':'<div class="recipient">No hay clientes autorizados. Importá contactos y marcá su autorización.</div>');$$(".recipient-check").forEach(c=>c.onchange=()=>{c.checked?selectedRecipients.add(c.value):selectedRecipients.delete(c.value);updateSelected();scheduleDraftSave("send")});updateSelected()}
function updateSelected(){$("#selected-count").textContent=selectedRecipients.size;$("#recipient-summary").textContent="Seleccionados de "+authorizedCount+" autorizados"}
$("#recipient-search").addEventListener("input",renderRecipientList);
$("#select-all").onclick=()=>{$$(".recipient-check").forEach(c=>{c.checked=true;selectedRecipients.add(c.value)});updateSelected();scheduleDraftSave("send")};
$("#select-none").onclick=()=>{selectedRecipients.clear();$$(".recipient-check").forEach(c=>c.checked=false);updateSelected();scheduleDraftSave("send")};
$("#send-type").onchange=()=>{const isText=$("#send-type").value==="text";$("#send-file-wrap").classList.toggle("hidden",isText);$("#send-file").accept=$("#send-type").value==="video"?"video/mp4":"image/*";if(isText)$("#send-file").value="";$("#send-text").dispatchEvent(new Event("input"))};
function showJobResult(j){
  const box=$("#send-result");
  box.classList.remove("hidden");
  if(j.status==="error"){
    box.classList.add("error");
    box.textContent=`No se pudo completar el envío: ${j.error||"error desconocido"}`;
  }else{
    box.classList.remove("error");
    box.textContent=`Proceso finalizado. Enviados: ${j.sent}. Fallidos: ${j.failed}.`;
  }
}
async function resetSendComposer(){
  applyingDraft=true;
  try{
    const ta=$("#send-text");
    if(ta){ta.value="";ta.dispatchEvent(new Event("input"))}
    $("#send-file").value="";
    selectedRecipients.clear();
    if(contacts.length)renderRecipientList();else updateSelected();
    selectedTemplate.send="";
    fillTemplateSelect("send");
    await request("/api/drafts/send",{method:"DELETE"});
    setDraftStatus("send","Sin borrador");
  }catch(e){
    // El resultado del envío no debe fallar porque no se pudo limpiar el borrador.
  }finally{pendingSendKey=null;applyingDraft=false}
}
async function monitorJob(jobId,total,estimatedMs=0){
  if(monitoringJob)return null;
  monitoringJob=true;
  activeJob={jobId,total,estimatedMs,last:null};
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
    if(j.status==="running"){
      box.classList.remove("error");
      box.textContent=`Procesando ${j.processed}/${j.total} · Enviados: ${j.sent} · Fallidos: ${j.failed}`;
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
  if(!await askConfirm(`Vas a enviar ${messages} mensaje${messages===1?"":"s"} a ${ids.length} cliente${ids.length===1?"":"s"}${files.length>1?" ("+files.length+" archivos por cliente)":""}. ¿Continuar?`,{title:"Confirmar envío",acceptLabel:"Enviar"}))return;
  const fd=new FormData();
  fd.append("type",type);
  fd.append("text",$("#send-text").value);
  fd.append("ids",JSON.stringify(ids));
  files.forEach(f=>fd.append("files",f));
  const b=$("#send-button"),box=$("#send-result");
  const key=pendingSendKey||(typeof crypto!=="undefined"&&crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random());
  pendingSendKey=key;
  b.disabled=true;b.textContent="Enviando...";
  box.classList.remove("hidden","error");box.textContent="Preparando el envío...";
  try{
    const start=await request("/api/send",{method:"POST",body:fd,headers:{"Idempotency-Key":key}});
    box.textContent=start.reused?`Reanudando envío anterior (${start.total} mensajes)...`:`Procesando 0/${start.total}...`;
    await monitorJob(start.jobId,start.total,start.estimatedMs);
  }catch(e){
    box.classList.remove("hidden");box.classList.add("error");box.textContent=e.message;
  }finally{b.disabled=false;b.textContent="Enviar promoción"}
};
$("#track-job").onclick=async()=>{
  if(monitoringJob)return toast("El envío ya se está siguiendo.");
  if(!activeJob)return toast("No hay un envío reciente para consultar.");
  if(activeJob.last&&activeJob.last.status!=="running")return showJobResult(activeJob.last);
  $("#send-result").classList.remove("hidden");
  await monitorJob(activeJob.jobId,activeJob.total,activeJob.estimatedMs);
};
$("#status-type").onchange=()=>{$("#status-file-wrap").classList.toggle("hidden",$("#status-type").value==="text");$("#status-file").accept=$("#status-type").value==="video"?"video/mp4":"image/*";$("#status-text").dispatchEvent(new Event("input"))};
$("#status-button").onclick=async()=>{const type=$("#status-type").value;const fd=new FormData();fd.append("type",type);fd.append("text",$("#status-text").value);if($("#status-file").files[0])fd.append("file",$("#status-file").files[0]);if(!await askConfirm("¿Publicar este contenido en el Estado de WhatsApp del número conectado?",{title:"Publicar estado",acceptLabel:"Publicar"}))return;const b=$("#status-button");b.disabled=true;b.textContent="Publicando...";try{await request("/api/status",{method:"POST",body:fd});$("#status-file").value="";$("#status-result").classList.remove("hidden","error");$("#status-result").textContent="Solicitud de publicación enviada a WhatsApp.";toast("Estado enviado")}catch(e){$("#status-result").classList.remove("hidden");$("#status-result").classList.add("error");$("#status-result").textContent=e.message}finally{b.disabled=false;b.textContent="Publicar estado"}};
async function loadHistory(){try{const h=await request("/api/history");$("#history-body").innerHTML=h.map(x=>`<tr><td data-label="Fecha">${new Date(x.at).toLocaleString()}</td><td data-label="Acción">${x.kind==="status"?"Estado":x.kind==="connection"?"Conexión":"Mensaje"} · ${esc(x.type||"")}</td><td data-label="Cliente / resultado">${esc(x.name||x.phone||"Publicación de estado")}</td><td data-label="Estado"><span class="pill ${x.ok?"yes":"no"}">${x.ok?"Procesado":"Error"}</span></td></tr>`).join("")||'<tr><td colspan="4">Todavía no hay actividad.</td></tr>'}catch(e){toast(e.message)}}
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
  try{return applyConnection(await request("/api/connection"),{silent})}
  catch(e){
    $("#connection-title").textContent="No se pudo consultar";
    $("#connection-detail").textContent=e.message;
    $("#connection-account").classList.add("hidden");
    $("#disconnect-button").classList.add("hidden");
    return false;
  }
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
loadSummary();
