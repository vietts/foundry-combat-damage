/**
 * Combat Damage: danni e cure dal Combat Tracker per il GM che tira i dadi veri al tavolo.
 * Sotto ogni combattente (carosello di Carolingian UI o tracker in barra laterale) c'è una barra-pulsante;
 * un clic apre il riquadro dove si scrive il numero. In Daggerheart il danno grezzo diventa PF segnati con le soglie,
 * in D&D 5e si scalano prima i PF temporanei. Tutto scrive sulla scheda dell'attore, quindi telefono e scheda restano in pari.
 */

const ID = "combat-damage";
const SEVERITY = ["nessun PF", "Minore", "Maggiore", "Grave", "Massiccio"];

let panel = null;
let lastAction = null;

const isDH = () => game.system.id === "daggerheart";
const isDnD = () => game.system.id === "dnd5e";

function findCombatant(id) {
  for ( const combat of game.combats ) {
    const combatant = combat.combatants.get(id);
    if ( combatant ) return combatant;
  }
  return null;
}

/* -------------------------------------------- */
/*  Lettura risorse                             */
/* -------------------------------------------- */

/** Risorse in forma comune: per ogni barra quante ne restano su quante. */
function readStats(actor) {
  if ( isDH() ) {
    const r = actor.system.resources ?? {};
    const hp = r.hitPoints;
    const stats = {
      hp: hp ? { left: hp.max - hp.value, max: hp.max } : null,
      stress: r.stress ? { left: r.stress.max - r.stress.value, max: r.stress.max } : null,
      armor: null
    };
    if ( (actor.type === "character") && r.armor?.max ) stats.armor = { left: r.armor.max - r.armor.value, max: r.armor.max };
    return stats;
  }
  if ( isDnD() ) {
    const hp = actor.system.attributes?.hp;
    if ( !hp ) return { hp: null };
    const max = hp.effectiveMax ?? hp.max;
    return { hp: { left: hp.value, max }, temp: hp.temp || 0 };
  }
  return { hp: null };
}

/** Anteprima Daggerheart: quanti PF segna un danno grezzo, con o senza uno slot di armatura. */
function previewDH(actor, amount, useArmor) {
  const damage = actor.calculateDamage ? actor.calculateDamage(amount, []) : amount;
  const raw = actor.convertDamageToThreshold(damage);
  const armor = (actor.type === "character") ? actor.system.resources.armor : null;
  const armorUsed = !!(useArmor && armor && (armor.value < armor.max) && (raw > 0));
  return { raw, marks: armorUsed ? raw - 1 : raw, armorUsed };
}

/* -------------------------------------------- */
/*  Scrittura                                   */
/* -------------------------------------------- */

function snapshot(actor) {
  if ( isDH() ) {
    const r = actor.system.resources;
    return { hp: r.hitPoints?.value, stress: r.stress?.value, armor: r.armor?.value ?? null };
  }
  const hp = actor.system.attributes.hp;
  return { hp: hp.value, temp: hp.temp || 0 };
}

function remember(actor, text) {
  lastAction = { uuid: actor.uuid, name: actor.name, text, before: snapshot(actor) };
}

async function undo() {
  if ( !lastAction ) return;
  const { uuid, before, name, text } = lastAction;
  lastAction = null;
  const actor = await fromUuid(uuid);
  if ( !actor ) return;
  if ( isDH() ) {
    const update = {};
    if ( before.hp !== undefined ) update["system.resources.hitPoints.value"] = before.hp;
    if ( before.stress !== undefined ) update["system.resources.stress.value"] = before.stress;
    await actor.update(update);
    // L'armatura vive sull'oggetto equipaggiato: si rimette la differenza con la funzione del sistema.
    const now = actor.system.resources.armor?.value;
    if ( (before.armor !== null) && (now !== undefined) && (now !== before.armor) ) {
      await actor.system.updateArmorValue({ value: before.armor - now });
    }
  } else {
    await actor.update({ "system.attributes.hp.value": before.hp, "system.attributes.hp.temp": before.temp });
  }
  ui.notifications.info(`Annullato: ${name}, ${text}`);
}

async function damage(actor, amount, useArmor) {
  if ( !(amount > 0) ) return;
  if ( isDH() ) {
    const { raw, marks, armorUsed } = previewDH(actor, amount, useArmor);
    remember(actor, `${amount} danni → ${marks} PF${armorUsed ? " (armatura)" : ""}`);
    if ( actor.type === "character" ) {
      // Per i PG niente takeDamage: chiederebbe l'armatura al giocatore collegato (al suo telefono) e dopo 30 s
      // senza risposta il danno si perde. La scelta dell'armatura la fa il GM qui.
      const updates = [];
      if ( marks > 0 ) updates.push({ key: "hitPoints", value: marks });
      if ( armorUsed ) updates.push({ key: "armor", value: 1 });
      await actor.modifyResource(updates);
    }
    else await actor.takeDamage({ total: amount }, { isDirect: true });
    return raw;
  }
  const hp = actor.system.attributes.hp;
  remember(actor, `${amount} danni`);
  const fromTemp = Math.min(hp.temp || 0, amount);
  await actor.update({
    "system.attributes.hp.temp": (hp.temp || 0) - fromTemp,
    "system.attributes.hp.value": Math.max(hp.value - (amount - fromTemp), 0)
  });
}

async function heal(actor, amount) {
  if ( !(amount > 0) ) return;
  if ( isDH() ) {
    remember(actor, `cura ${amount} PF`);
    await actor.modifyResource([{ key: "hitPoints", value: -amount }]);
    return;
  }
  const hp = actor.system.attributes.hp;
  remember(actor, `cura ${amount}`);
  await actor.update({ "system.attributes.hp.value": Math.min(hp.value + amount, hp.effectiveMax ?? hp.max) });
}

async function shift(actor, key, delta) {
  const label = key === "stress" ? "Stress" : "armatura";
  remember(actor, `${delta > 0 ? "+" : ""}${delta} ${label}`);
  if ( key === "armor" ) await actor.system.updateArmorValue({ value: delta });
  else await actor.modifyResource([{ key, value: delta }]);
}

/* -------------------------------------------- */
/*  Barra sotto il combattente                  */
/* -------------------------------------------- */

function meter(cls, res) {
  if ( !res?.max ) return "";
  const pct = Math.max(0, Math.min(100, (res.left / res.max) * 100));
  return `<span class="cdmg-meter ${cls}"><i style="width:${pct}%"></i></span>`;
}

function barContent(actor) {
  const s = readStats(actor);
  if ( !s.hp ) return "";
  const temp = s.temp ? ` +${s.temp}` : "";
  const meters = `${meter("cdmg-hp", s.hp)}<span class="cdmg-num">${s.hp.left}/${s.hp.max}${temp}</span>`
    + meter("cdmg-stress", s.stress) + meter("cdmg-armor", s.armor);
  return `<span class="cdmg-meters">${meters}</span><span class="cdmg-badge"><i class="fa-solid fa-plus-minus"></i></span>`;
}

function stop(event) {
  event.stopPropagation();
}

function makeBar(li) {
  const combatant = findCombatant(li.dataset.combatantId);
  const actor = combatant?.actor;
  if ( !actor ) return null;
  const bar = document.createElement("button");
  bar.type = "button";
  bar.className = "cdmg-bar";
  bar.dataset.tooltip = "Danni e cure";
  bar.innerHTML = barContent(actor);
  return bar;
}

/** Aggiunge la barra ai combattenti che non ce l'hanno (anche ai cloni del carosello infinito). */
function inject() {
  for ( const li of document.querySelectorAll("#combat-popout li.combatant[data-combatant-id], #combat li.combatant[data-combatant-id]") ) {
    if ( li.querySelector(":scope .cdmg-bar") ) continue;
    const bar = makeBar(li);
    if ( !bar ) continue;
    const inCarousel = !!li.closest("#combat-popout") && document.body.classList.contains("crlngn-combat-tracker");
    (inCarousel ? li : (li.querySelector(".token-name") ?? li)).append(bar);
  }
}

function refreshBars() {
  for ( const bar of document.querySelectorAll(".cdmg-bar") ) {
    const li = bar.closest("li.combatant[data-combatant-id]");
    const actor = li && findCombatant(li.dataset.combatantId)?.actor;
    if ( actor ) bar.innerHTML = barContent(actor);
  }
  if ( panel ) renderPanel();
}

let scheduled = false;
function scheduleInject() {
  if ( scheduled ) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    inject();
  });
}

/* -------------------------------------------- */
/*  Riquadro danni                              */
/* -------------------------------------------- */

function closePanel() {
  panel?.el.remove();
  panel = null;
}

function openPanel(combatantId, anchor) {
  if ( panel?.combatantId === combatantId ) return closePanel();
  closePanel();
  const el = document.createElement("div");
  el.id = "cdmg-panel";
  document.body.append(el);
  panel = { el, combatantId, amount: "", useArmor: true };
  el.addEventListener("pointerdown", stop);
  el.addEventListener("click", onPanelClick);
  el.addEventListener("input", onPanelInput);
  el.addEventListener("keydown", onPanelKey);
  renderPanel();
  place(anchor);
  el.querySelector("input.cdmg-amount")?.focus();
}

function place(anchor) {
  const r = anchor.getBoundingClientRect();
  const el = panel.el;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = Math.min(Math.max(8, r.left + (r.width / 2) - (w / 2)), window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if ( top + h > window.innerHeight - 8 ) top = Math.max(8, r.top - h - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function panelActor() {
  return findCombatant(panel.combatantId)?.actor ?? null;
}

function renderPanel() {
  const actor = panelActor();
  if ( !actor ) return closePanel();
  const amount = Number(panel.amount);
  const s = readStats(actor);
  let info = "";
  let preview = "";
  let extra = "";

  if ( isDH() ) {
    const t = actor.system.damageThresholds ?? {};
    info = `PF ${s.hp?.left ?? "?"}/${s.hp?.max ?? "?"} · Soglie ${t.major ?? "–"} / ${t.severe ?? "–"}`;
    if ( amount > 0 ) {
      const p = previewDH(actor, amount, panel.useArmor);
      preview = `${amount} → ${SEVERITY[p.raw] ?? p.raw}: <b>${p.marks} PF</b>${p.armorUsed ? " (−1 con armatura)" : ""}`;
    }
    const rows = [];
    if ( s.stress ) rows.push(`<span class="cdmg-lab">Stress ${s.stress.max - s.stress.left}/${s.stress.max}</span>
      <button type="button" data-cdmg="stress" data-delta="-1">−</button><button type="button" data-cdmg="stress" data-delta="1">+</button>`);
    if ( s.armor ) rows.push(`<span class="cdmg-lab">Armatura ${s.armor.max - s.armor.left}/${s.armor.max}</span>
      <button type="button" data-cdmg="armor" data-delta="-1">−</button><button type="button" data-cdmg="armor" data-delta="1">+</button>`);
    extra = rows.map(r => `<div class="cdmg-row">${r}</div>`).join("");
    if ( s.armor ) extra += `<label class="cdmg-check"><input type="checkbox" class="cdmg-use-armor" ${panel.useArmor ? "checked" : ""}> Usa uno slot di armatura</label>`;
  } else {
    info = `PF ${s.hp?.left ?? "?"}/${s.hp?.max ?? "?"}${s.temp ? ` · temporanei ${s.temp}` : ""}`;
  }

  const healHint = isDH() ? "Cura = PF da liberare" : "";
  const undoRow = lastAction
    ? `<div class="cdmg-last"><span>${lastAction.name}: ${lastAction.text}</span><button type="button" data-cdmg="undo">Annulla</button></div>`
    : "";

  panel.el.innerHTML = `
    <div class="cdmg-head"><b>${actor.name}</b><span>${info}</span></div>
    <div class="cdmg-row">
      <input type="number" class="cdmg-amount" min="0" inputmode="numeric" value="${panel.amount}" placeholder="0">
      <button type="button" class="cdmg-damage" data-cdmg="damage">Danno</button>
      <button type="button" class="cdmg-heal" data-cdmg="heal" data-tooltip="${healHint}">Cura</button>
    </div>
    <div class="cdmg-preview">${preview}</div>
    ${extra}
    ${undoRow}`;
  const input = panel.el.querySelector("input.cdmg-amount");
  if ( input && (document.activeElement === document.body) ) input.focus();
}

function onPanelInput(event) {
  if ( event.target.classList.contains("cdmg-amount") ) {
    panel.amount = event.target.value;
    // Si aggiorna solo l'anteprima, così il campo non perde il cursore.
    const actor = panelActor();
    const amount = Number(panel.amount);
    const box = panel.el.querySelector(".cdmg-preview");
    if ( !actor || !box ) return;
    if ( isDH() && (amount > 0) ) {
      const p = previewDH(actor, amount, panel.useArmor);
      box.innerHTML = `${amount} → ${SEVERITY[p.raw] ?? p.raw}: <b>${p.marks} PF</b>${p.armorUsed ? " (−1 con armatura)" : ""}`;
    } else box.innerHTML = "";
  }
  else if ( event.target.classList.contains("cdmg-use-armor") ) {
    panel.useArmor = event.target.checked;
    renderPanel();
  }
}

async function run(action, delta) {
  const actor = panelActor();
  if ( !actor ) return;
  const amount = Math.floor(Number(panel.amount));
  try {
    if ( action === "damage" ) await damage(actor, amount, panel.useArmor);
    else if ( action === "heal" ) await heal(actor, amount);
    else if ( action === "undo" ) await undo();
    else await shift(actor, action, delta);
  } catch(err) {
    console.error(`${ID} |`, err);
    ui.notifications.error(`Combat Damage: ${err.message}`);
  }
  if ( (action === "damage") || (action === "heal") ) panel.amount = "";
  // modifyResource di Daggerheart aggiorna senza aspettare: si ridisegna dopo un attimo.
  setTimeout(() => panel && renderPanel(), 150);
  if ( panel ) renderPanel();
  panel?.el.querySelector("input.cdmg-amount")?.focus();
}

function onPanelClick(event) {
  stop(event);
  const button = event.target.closest("button[data-cdmg]");
  if ( !button ) return;
  run(button.dataset.cdmg, Number(button.dataset.delta));
}

function onPanelKey(event) {
  if ( event.key === "Escape" ) return closePanel();
  if ( (event.key === "Enter") && event.target.classList.contains("cdmg-amount") ) {
    event.preventDefault();
    run(event.shiftKey ? "heal" : "damage");
  }
}

/* -------------------------------------------- */
/*  Hook                                        */
/* -------------------------------------------- */

function start() {
  if ( document.body.classList.contains("cdmg-gm") ) return;
  if ( !game.user.isGM || !(isDH() || isDnD()) ) return;
  document.body.classList.add("cdmg-gm");

  new MutationObserver(scheduleInject).observe(document.body, { childList: true, subtree: true });
  inject();

  for ( const hook of ["updateActor", "updateItem", "createItem", "deleteItem", "updateCombatant"] ) {
    Hooks.on(hook, () => requestAnimationFrame(refreshBars));
  }
  Hooks.on("deleteCombat", closePanel);

  // Ascolto in cattura sul document: arriva prima del tracker di Foundry e del carosello (selezione, trascinamento)
  // e vale anche per i cloni del carosello infinito, che copiano il DOM ma non i listener.
  for ( const type of ["pointerdown", "mousedown", "dblclick", "contextmenu"] ) {
    document.addEventListener(type, event => {
      if ( event.target.closest?.(".cdmg-bar") ) stop(event);
    }, true);
  }
  document.addEventListener("click", event => {
    const bar = event.target.closest?.(".cdmg-bar");
    if ( !bar ) return;
    stop(event);
    event.preventDefault();
    openPanel(bar.closest("li.combatant[data-combatant-id]").dataset.combatantId, bar);
  }, true);
  document.addEventListener("pointerdown", event => {
    if ( panel && !event.target.closest?.("#cdmg-panel, .cdmg-bar") ) closePanel();
  });
}

// Caricato a mano a partita avviata (prova senza riavvio) il ready è già passato.
if ( game.ready ) start();
else Hooks.once("ready", start);
