(function () {
  "use strict";

  const C = window.CONFIG;
  const DN_URL = C.DN_URL;
  const VUES_TUILES = {
    apprenants: { titre: "Mobilités apprenants", recherche: "Nom" },
    personnel: { titre: "Mobilités du personnel", recherche: "Nom" },
    collectives: { titre: "Mobilités collectives", recherche: "Niveau de formation" },
  };
  const ETATS = {
    en_construction: "En construction",
    en_instruction: "En instruction",
    accepte: "Accepté",
    inconnu: "État inconnu",
  };
  const STATUTS = { public: "Public", prive: "Privé" };
  const GROUPES = [
    ["public", "Public"],
    ["prive", "Privé"],
    ["autre", "Statut non renseigné"],
  ];

  let all = [];
  let visibles = [];
  let couleurs = {};
  let listePays = [];
  let listeEtabs = [];
  let filtreStatut = "tous";
  // Filtres oui/non propres aux apprenants
  const filtresBool = { consortium: "tous", aide_dger: "tous" };
  let vue = "apprenants";
  let typeCarte = "tous";
  let reglages = null; // tables choisies dans la configuration du widget (null = défaut)
  let charge = false;
  const carte = { paths: null, codes: new Set(), counts: {}, cle: null, fit: null };

  const el = {
    cards: document.getElementById("cards"),
    search: document.getElementById("search-nom"),
    pays: document.getElementById("filter-pays"),
    annee: document.getElementById("filter-annee"),
    etab: document.getElementById("filter-etab"),
    statutBtns: document.querySelectorAll('[data-filter="statut"]'),
    typeBtns: document.querySelectorAll('[data-filter="type"]'),
    blocsApprenants: document.querySelectorAll(".filtre-apprenants"),
    searchLabel: document.getElementById("search-label"),
    titreTuiles: document.getElementById("titre-tuiles"),
    du: document.getElementById("filter-du"),
    au: document.getElementById("filter-au"),
    btnReset: document.getElementById("btn-reset"),
    btnRefresh: document.getElementById("btn-refresh"),
    countVisible: document.getElementById("count-visible"),
    countTotal: document.getElementById("count-total"),
    tableWrap: document.getElementById("table-wrap"),
    railLinks: document.querySelectorAll(".rail-icon[data-view]"),
    modal: document.getElementById("modal"),
    modalTitle: document.getElementById("modal-title"),
    modalList: document.getElementById("modal-list"),
    modalClose: document.getElementById("modal-close"),
  };

  // --- Utilitaires ---

  // Les données viennent de Grist : on échappe tout ce qui est injecté dans le HTML
  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  // Recherche insensible aux accents et à la casse
  function norm(value) {
    return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  }

  function frDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || "?";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  }

  function duree(m) {
    if (!m.date_depart || !m.date_retour) return "";
    const jours = Math.round((new Date(m.date_retour) - new Date(m.date_depart)) / 86400000) + 1;
    return Number.isFinite(jours) && jours > 0 ? `${jours} j` : "";
  }

  function showModal(title, lines) {
    el.modalTitle.textContent = title;
    el.modalList.innerHTML = lines.map((l) => `<li>${esc(l)}</li>`).join("");
    el.modal.classList.add("modal--error");
    el.modal.hidden = false;
  }

  // --- Filtres ---

  // ignore = nom du filtre à ne pas appliquer (sert aux filtres croisés)
  function typeActif() {
    return vue === "carte" ? typeCarte : vue;
  }

  function matches(m, ignore) {
    const t = typeActif();
    if (t !== "tous" && m.type !== t) return false;

    // Nom (début) pour les personnes, niveau de formation (contient) pour les collectives
    const q = norm(el.search.value);
    if (q) {
      const ok = m.type === "collectives" ? norm(m.niveau).includes(q) : norm(m.nom).startsWith(q);
      if (!ok) return false;
    }

    if (ignore !== "etab" && el.etab.value && m.etablissement !== el.etab.value) return false;
    if (ignore !== "statut" && filtreStatut !== "tous" && m.statut !== filtreStatut) return false;

    // Consortium / aide DGER : actifs seulement quand on n'affiche que des apprenants
    if (t === "apprenants") {
      for (const [cle, val] of Object.entries(filtresBool)) {
        if (ignore !== cle && val !== "tous" && Boolean(m[cle]) !== (val === "oui")) return false;
      }
    }
    if (ignore !== "pays" && el.pays.value && m.pays_code !== el.pays.value) return false;
    if (ignore !== "annee" && el.annee.value && (m.date_depart || "").slice(0, 4) !== el.annee.value) return false;

    // Chevauchement de période : la mobilité touche l'intervalle [du, au]
    const du = el.du.value;
    const au = el.au.value;
    if (du && (!m.date_retour || m.date_retour < du)) return false;
    if (au && (!m.date_depart || m.date_depart > au)) return false;
    return true;
  }

  // Reconstruit une liste en gardant la valeur choisie, même si elle n'a plus de résultat
  function fillSelect(sel, labelTous, options) {
    const current = sel.value;
    sel.innerHTML = `<option value="">${labelTous}</option>` +
      options.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
    sel.value = options.some(([v]) => v === current) ? current : "";
    sel.classList.toggle("has-value", sel.value !== "");
  }

  // Filtres croisés : chaque liste ne propose que les valeurs compatibles avec les autres filtres
  function updateFacets() {
    // Années présentes (date de départ), les plus récentes d'abord
    const annees = new Set(all.filter((m) => matches(m, "annee"))
      .map((m) => (m.date_depart || "").slice(0, 4)).filter((a) => /^\d{4}$/.test(a)));
    if (el.annee.value) annees.add(el.annee.value);
    fillSelect(el.annee, "Toutes les années", [...annees].sort().reverse().map((a) => [a, a]));

    const paysDispo = new Set(all.filter((m) => matches(m, "pays")).map((m) => m.pays_code));
    fillSelect(el.pays, "Tous les pays",
      listePays.filter((p) => paysDispo.has(p.code) || p.code === el.pays.value).map((p) => [p.code, p.nom]));

    const etabsDispo = new Set(all.filter((m) => matches(m, "etab")).map((m) => m.etablissement));
    fillSelect(el.etab, "Tous les établissements",
      listeEtabs.filter((e) => etabsDispo.has(e) || e === el.etab.value).map((e) => [e, e]));

    Object.keys(filtresBool).forEach((cle) => {
      const dispo = new Set(all.filter((m) => matches(m, cle)).map((m) => (m[cle] ? "oui" : "non")));
      document.querySelectorAll(`[data-filter="${cle}"]`).forEach((b) => {
        const v = b.dataset.value;
        b.disabled = v !== "tous" && v !== filtresBool[cle] && !dispo.has(v);
      });
    });

    const statutsDispo = new Set(all.filter((m) => matches(m, "statut")).map((m) => m.statut));
    el.statutBtns.forEach((b) => {
      const v = b.dataset.value;
      b.disabled = v !== "tous" && v !== filtreStatut && !statutsDispo.has(v);
    });
  }

  function setBool(cle, value) {
    filtresBool[cle] = value;
    document.querySelectorAll(`[data-filter="${cle}"]`).forEach((b) => {
      const on = b.dataset.value === value;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }

  function setStatut(value) {
    filtreStatut = value;
    el.statutBtns.forEach((b) => {
      const on = b.dataset.value === value;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }

  function resetFilters() {
    el.search.value = "";
    el.pays.value = "";
    el.annee.value = "";
    el.etab.value = "";
    setStatut("tous");
    Object.keys(filtresBool).forEach((cle) => setBool(cle, "tous"));
    el.du.value = "";
    el.au.value = "";
    render();
  }

  // --- Vue apprenants : tuiles ---

  const etabIcon = `<svg class="etab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
  const calendarIcon = `<svg class="date-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v3"/><path d="M16 2v3"/><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>`;

  const objetIcon = `<svg class="etab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/></svg>`;
  const groupeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;

  const consortiumIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/></svg>`;
  const argentIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg>`;

  // Indicateur toujours présent : en couleur si vrai, grisé sinon
  function indicateur(actif, icone, texte, classe) {
    return `<span class="flag ${actif ? `flag--on ${classe}` : ""}" title="${texte} : ${actif ? "oui" : "non"}">
              ${icone}<span>${texte}</span><span class="sr-only"> : ${actif ? "oui" : "non"}</span>
            </span>`;
  }

  function blocCommun(m) {
    const d = duree(m);
    return `
          <a class="card-sub card-dossier-link" href="${DN_URL}${m.demarche}/dossiers/${encodeURIComponent(m.dossier_number)}"
             target="_blank" rel="noopener noreferrer">Dossier ${esc(m.dossier_number)}</a>
          ${m.etablissement ? `<p class="card-etab">${etabIcon}<span>${esc(m.etablissement)}${STATUTS[m.statut] ? `<span class="card-etab-statut">${STATUTS[m.statut]}</span>` : ""}</span></p>` : ""}
          <p class="card-dates">${calendarIcon}${frDate(m.date_depart)} → ${frDate(m.date_retour)}${d ? ` <span class="card-duree">(${d})</span>` : ""}</p>`;
  }

  function badgePays(m) {
    return `<span class="pill-pays-wrap" data-full="${esc(m.pays_nom)}">
              <span class="pill-pays" style="background:${couleurs[m.pays_code] || "var(--ink)"}">${esc(m.pays_nom || "Pays ?")}</span>
            </span>`;
  }

  function cardTemplate(m) {
    let avatar, titre, extra = "";
    if (m.type === "collectives") {
      avatar = `<div class="card-avatar card-avatar--groupe" aria-hidden="true">${groupeIcon}</div>`;
      titre = esc(m.niveau || "Niveau non renseigné");
      extra = `<p class="card-effectif"><strong>${m.effectif ?? "?"}</strong> participant${m.effectif > 1 ? "s" : ""}</p>`;
    } else {
      avatar = `<div class="card-avatar">${esc(m.initiales)}</div>`;
      titre = m.nom || m.prenom ? `${esc(m.nom)}<br>${esc(m.prenom)}` : "Nom inconnu";
      if (m.type === "apprenants") {
        extra = `<div class="card-flags">
            ${indicateur(m.consortium, consortiumIcon, "Consortium", "flag--consortium")}
            ${indicateur(m.aide_dger, argentIcon, "Aide DGER", "flag--dger")}
          </div>`;
      }
      if (m.type === "personnel" && m.objet) {
        extra = `<p class="card-objet" title="${esc(m.objet)}">${objetIcon}<span>${esc(m.objet)}</span></p>`;
      }
    }
    return `
      <article class="card">
        ${avatar}
        <div class="card-body">
          <div class="card-header-row">
            <h3 class="card-title">${titre}</h3>
            ${badgePays(m)}
          </div>
          <hr class="card-divider">
          ${extra}
          ${blocCommun(m)}
        </div>
        <p class="card-state card-state--${esc(m.state)}">${esc(ETATS[m.state] || m.state)}</p>
      </article>`;
  }

  function renderCards() {
    el.cards.innerHTML = visibles.length
      ? visibles.map(cardTemplate).join("")
      : '<p class="empty-state">Aucune mobilité ne correspond à ces filtres. Élargissez la période ou effacez les filtres.</p>';
  }

  // --- Vue carte : carte + tableau ---

  const GRIS_CLAIR = C.GRIS_CLAIR;
  const GRIS_FONCE = C.GRIS_FONCE;
  const MAP_W = 960;
  // Sur écran étroit (portrait), carte plus haute pour rester lisible
  const MAP_H = window.innerWidth <= 820 ? 720 : 440;
  // Réglages du cadrage automatique
  const ZOOM_MAX = C.ZOOM_MAX;
  const ZOOM_AUTO_MAX = C.ZOOM_AUTO_MAX;
  const MARGE_AUTO = C.MARGE_AUTO;
  const RAYON_CADRAGE = (C.RAYON_CADRAGE_DEG * Math.PI) / 180;

  // Pour le cadrage, on ne garde que le territoire principal d'un pays et ce qui est
  // proche (Corse, Baléares, Crète...). On écarte l'outre-mer lointain (Guyane, Réunion, Svalbard,
  // Açores, Canaries, Alaska) et les morceaux coupés par l'antiméridien (Russie).
  function territoirePrincipal(f) {
    if (f.geometry.type !== "MultiPolygon") return f;
    const polys = f.geometry.coordinates.map((c) => {
      const g = { type: "Polygon", coordinates: c };
      return { c, aire: d3.geoArea(g), centre: d3.geoCentroid(g) };
    });
    const principal = polys.reduce((a, b) => (b.aire > a.aire ? b : a));
    const gardes = polys.filter((p) => d3.geoDistance(p.centre, principal.centre) < RAYON_CADRAGE);
    return { type: "Feature", geometry: { type: "MultiPolygon", coordinates: gardes.map((p) => p.c) } };
  }

  function dureeAnim() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 750;
  }

  async function initMap() {
    try {
      const topo = await (await fetch(C.WORLD_URL)).json();
      const monde = topojson.feature(topo, topo.objects.countries);
      const projection = d3.geoNaturalEarth1().fitSize([MAP_W, MAP_H], monde);
      const path = d3.geoPath(projection);
      const tooltip = document.getElementById("map-tooltip");
      const svg = d3.select("#map").attr("viewBox", `0 0 ${MAP_W} ${MAP_H}`);
      const g = svg.append("g");

      // Zoom : boutons, double-clic, glisser ; molette seulement avec Ctrl pour ne pas
      // bloquer le défilement de la page
      const zoom = d3.zoom()
        .scaleExtent([1, ZOOM_MAX])
        .translateExtent([[0, 0], [MAP_W, MAP_H]])
        .filter((e) => (e.type === "wheel" ? e.ctrlKey : !e.button))
        .on("zoom", (e) => g.attr("transform", e.transform));
      svg.call(zoom);

      // Emprise projetée du territoire principal de chaque pays, calculée une fois
      monde.features.forEach((f) => (f.cadre = path.bounds(territoirePrincipal(f))));

      carte.fit = (features) => {
        let t = d3.zoomIdentity;
        if (features.length) {
          const x0 = d3.min(features, (f) => f.cadre[0][0]);
          const y0 = d3.min(features, (f) => f.cadre[0][1]);
          const x1 = d3.max(features, (f) => f.cadre[1][0]);
          const y1 = d3.max(features, (f) => f.cadre[1][1]);
          const k = Math.max(1, Math.min(ZOOM_AUTO_MAX,
            MARGE_AUTO / Math.max((x1 - x0) / MAP_W, (y1 - y0) / MAP_H)));
          t = d3.zoomIdentity
            .translate(MAP_W / 2 - k * (x0 + x1) / 2, MAP_H / 2 - k * (y0 + y1) / 2)
            .scale(k);
        }
        svg.transition().duration(dureeAnim()).call(zoom.transform, t);
      };

      document.getElementById("zoom-in").addEventListener("click", () =>
        svg.transition().duration(dureeAnim() / 2).call(zoom.scaleBy, 2));
      document.getElementById("zoom-out").addEventListener("click", () =>
        svg.transition().duration(dureeAnim() / 2).call(zoom.scaleBy, 0.5));
      document.getElementById("zoom-fit").addEventListener("click", () => {
        carte.cle = null;
        updateMap();
      });

      carte.codes = new Set(monde.features.map((f) => f.properties.iso2));
      carte.paths = g
        .selectAll("path")
        .data(monde.features)
        .join("path")
        .attr("class", "country")
        .attr("d", path)
        .on("mousemove", afficherInfobulle)
        .on("mouseleave", () => (tooltip.hidden = true))
        // Sur écran tactile, pas de survol : un appui affiche l'infobulle quelques secondes
        .on("click", (event, f) => {
          afficherInfobulle(event, f);
          clearTimeout(carte.minuteur);
          carte.minuteur = setTimeout(() => (tooltip.hidden = true), 2500);
        });

      function afficherInfobulle(event, f) {
        const n = carte.counts[f.properties.iso2] || 0;
        tooltip.textContent = n
          ? `${f.properties.nom} : ${n} mobilité${n > 1 ? "s" : ""}`
          : f.properties.nom;
        const box = tooltip.parentElement.getBoundingClientRect();
        // Infobulle gardée dans le cadre de la carte sur écran étroit
        const x = Math.min(event.clientX - box.left + 12, box.width - tooltip.offsetWidth - 8);
        tooltip.style.left = `${Math.max(8, x)}px`;
        tooltip.style.top = `${event.clientY - box.top + 12}px`;
        tooltip.hidden = false;
      }
      if (vue === "carte") updateMap();
    } catch (err) {
      showModal("Carte indisponible", [err.message]);
    }
  }

  function updateMap() {
    if (!carte.paths) return;
    const counts = {};
    visibles.forEach((m) => (counts[m.pays_code] = (counts[m.pays_code] || 0) + 1));
    carte.counts = counts;
    // Niveaux de gris proportionnels (racine carrée : une grosse destination n'écrase pas les autres).
    // L'échelle ignore le filtre pays : un pays sélectionné garde la nuance qu'il a parmi
    // tous les pays, au lieu de devenir le plus foncé.
    const ref = {};
    all.filter((m) => matches(m, "pays"))
      .forEach((m) => (ref[m.pays_code] = (ref[m.pays_code] || 0) + 1));
    const valeursRef = Object.values(ref);
    const max = Math.max(1, ...valeursRef);
    const min = Math.min(max, ...valeursRef);
    const t = d3.scaleSqrt().domain(min === max ? [0, max] : [min, max]).range([0, 1]);
    const gris = (n) => d3.interpolateRgb(GRIS_CLAIR, GRIS_FONCE)(t(n));
    carte.paths
      .classed("is-active", (f) => !!counts[f.properties.iso2])
      .style("fill", (f) => (counts[f.properties.iso2] ? gris(counts[f.properties.iso2]) : null));

    // Légende : du plus clair (moins de mobilités) au plus foncé (le plus)
    const legende = document.getElementById("map-legend");
    legende.hidden = Object.keys(counts).length === 0;
    document.getElementById("legend-min").textContent = valeursRef.length ? min : "";
    document.getElementById("legend-max").textContent = valeursRef.length ? max : "";

    // Recadrage uniquement si l'ensemble des pays colorés a changé
    const cle = Object.keys(counts).sort().join(",");
    if (cle !== carte.cle) {
      carte.cle = cle;
      carte.fit(carte.paths.data().filter((f) => counts[f.properties.iso2]));
    }

    // Codes Grist introuvables sur la carte (ex : faute de frappe, code non ISO)
    const absents = Object.keys(counts).filter((c) => c && !carte.codes.has(c));
    const note = document.getElementById("map-note");
    note.hidden = absents.length === 0;
    note.textContent = absents.length ? `Pays non localisés sur la carte : ${absents.join(", ")}` : "";
  }

  // Tableau croisé : lignes = pays, colonnes = établissements regroupés par statut
  function renderTable() {
    if (!visibles.length) {
      el.tableWrap.innerHTML = '<p class="empty-state">Aucune mobilité ne correspond à ces filtres.</p>';
      return;
    }
    const cellule = {}; // cellule[pays][etab] = nb
    const totPays = {};
    const totEtab = {};
    const totGroupe = {}; // totGroupe[pays][statut]
    const participants = {}; // somme des effectifs des mobilités collectives, par pays
    let totalParticipants = 0;
    const etabsParGroupe = { public: new Set(), prive: new Set(), autre: new Set() };

    visibles.forEach((m) => {
      const p = m.pays_code;
      const e = m.etablissement || "Établissement non renseigné";
      const g = etabsParGroupe[m.statut] ? m.statut : "autre";
      etabsParGroupe[g].add(e);
      cellule[p] ??= {};
      cellule[p][e] = (cellule[p][e] || 0) + 1;
      totGroupe[p] ??= {};
      totGroupe[p][g] = (totGroupe[p][g] || 0) + 1;
      totPays[p] = (totPays[p] || 0) + 1;
      totEtab[e] = (totEtab[e] || 0) + 1;
      if (m.type === "collectives") {
        participants[p] = (participants[p] || 0) + (m.effectif || 0);
        totalParticipants += m.effectif || 0;
      }
    });

    // Colonne participants : seulement s'il y a des mobilités collectives affichées
    const avecParticipants = visibles.some((m) => m.type === "collectives");
    const labelParticipants = typeActif() === "collectives" ? "Participants" : "Participants (collectives)";

    const groupes = GROUPES
      .filter(([g]) => etabsParGroupe[g].size)
      .map(([g, label]) => [g, label, [...etabsParGroupe[g]].sort((a, b) => a.localeCompare(b, "fr"))]);
    const pays = listePays.filter((p) => totPays[p.code]);
    const nomsPays = Object.fromEntries(listePays.map((p) => [p.code, p.nom]));
    // Pays présents dans les données mais sans nom (sécurité)
    Object.keys(totPays).forEach((c) => {
      if (!nomsPays[c]) pays.push({ code: c, nom: c || "Pays non renseigné" });
    });

    const v = (n) => (n ? n : "");
    const totalGroupe = (g) => visibles.filter((m) => (etabsParGroupe[m.statut] ? m.statut : "autre") === g).length;

    const head1 = `<tr>
        <th rowspan="2" scope="col" class="col-first">Pays</th>
        <th rowspan="2" scope="col">Total</th>
        ${avecParticipants ? `<th rowspan="2" scope="col" class="col-participants">${labelParticipants}</th>` : ""}
        ${groupes.map(([, label, etabs]) => `<th colspan="${etabs.length + 1}" scope="colgroup">${label}</th>`).join("")}
      </tr>`;
    const head2 = `<tr>
        ${groupes.map(([, label, etabs]) =>
          etabs.map((e) => `<th scope="col" class="col-etab">${esc(e)}</th>`).join("") +
          `<th scope="col" class="col-sous-total">Total ${label.toLowerCase()}</th>`).join("")}
      </tr>`;
    const body = pays.map((p) => `<tr>
        <th scope="row" class="col-first">
          <span class="table-dot" style="background:${couleurs[p.code] || "var(--ink)"}"></span>${esc(p.nom)}
        </th>
        <td>${totPays[p.code]}</td>
        ${avecParticipants ? `<td class="col-participants">${v(participants[p.code])}</td>` : ""}
        ${groupes.map(([g, , etabs]) =>
          etabs.map((e) => `<td>${v(cellule[p.code][e])}</td>`).join("") +
          `<td class="col-sous-total">${v(totGroupe[p.code][g])}</td>`).join("")}
      </tr>`).join("");
    const foot = `<tr>
        <th scope="row" class="col-first">Totaux</th>
        <td>${visibles.length}</td>
        ${avecParticipants ? `<td class="col-participants">${totalParticipants}</td>` : ""}
        ${groupes.map(([g, , etabs]) =>
          etabs.map((e) => `<td>${totEtab[e]}</td>`).join("") +
          `<td class="col-sous-total">${totalGroupe(g)}</td>`).join("")}
      </tr>`;

    el.tableWrap.innerHTML = `
      <table class="dsfr-table">
        <caption>Mobilités par pays et par établissement</caption>
        <thead>${head1}${head2}</thead>
        <tbody>${body}</tbody>
        <tfoot>${foot}</tfoot>
      </table>`;
  }

  // --- Rendu et navigation ---

  function render() {
    updateFacets();
    visibles = all.filter((m) => matches(m));
    const t = typeActif();
    el.countVisible.textContent = visibles.length;
    majBarreMobile();
    // Total = mobilités du type affiché, limitées à l'année choisie s'il y en a une
    const annee = el.annee.value;
    const total = all.filter((m) =>
      (t === "tous" || m.type === t) && (!annee || (m.date_depart || "").slice(0, 4) === annee)).length;
    el.countTotal.textContent = total;
    // Part des mobilités affichées, ex : 72,8 %
    document.getElementById("count-pct").textContent = total
      ? `${(visibles.length / total * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`
      : "";
    if (vue !== "carte") {
      renderCards();
    } else {
      updateMap();
      renderTable();
    }
  }

  // --- Mobile : panneau de filtres par-dessus le contenu ---

  function nbFiltresActifs() {
    let n = [el.annee, el.search, el.pays, el.etab, el.du, el.au].filter((x) => x.value).length;
    if (filtreStatut !== "tous") n += 1;
    if (typeActif() === "apprenants") n += Object.values(filtresBool).filter((v) => v !== "tous").length;
    return n;
  }

  function majBarreMobile() {
    const n = nbFiltresActifs();
    const badge = document.getElementById("nb-filtres");
    badge.hidden = n === 0;
    badge.textContent = n;
    document.getElementById("mobile-count").textContent = visibles.length;
    document.getElementById("nb-resultats").textContent = visibles.length;
  }

  function ouvrirFiltres(ouvert) {
    document.body.classList.toggle("filtres-ouverts", ouvert);
    document.getElementById("btn-filtres").setAttribute("aria-expanded", String(ouvert));
    if (ouvert) document.getElementById("filtres").scrollTop = 0;
  }

  document.getElementById("btn-filtres").addEventListener("click", () => ouvrirFiltres(true));
  document.getElementById("btn-voir-resultats").addEventListener("click", () => ouvrirFiltres(false));

  function setVue() {
    ouvrirFiltres(false);
    const h = location.hash.slice(1);
    vue = h === "carte" || VUES_TUILES[h] ? h : "apprenants";
    document.getElementById("view-tuiles").hidden = vue === "carte";
    document.getElementById("view-carte").hidden = vue !== "carte";
    if (VUES_TUILES[vue]) el.titreTuiles.textContent = VUES_TUILES[vue].titre;
    el.searchLabel.textContent =
      vue === "carte" ? "Nom ou niveau de formation" : VUES_TUILES[vue].recherche;
    majBlocsApprenants();
    el.search.placeholder = vue === "collectives" ? "Contient…" : "Commence par…";
    el.railLinks.forEach((a) => {
      const on = a.dataset.view === vue;
      a.classList.toggle("rail-icon--active", on);
      if (on) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    if (all.length) render();
  }

  // Switchs consortium / aide DGER visibles seulement quand on n'affiche que des apprenants
  function majBlocsApprenants() {
    el.blocsApprenants.forEach((b) => (b.hidden = typeActif() !== "apprenants"));
  }

  function setTypeCarte(value) {
    typeCarte = value;
    majBlocsApprenants();
    el.typeBtns.forEach((b) => {
      const on = b.dataset.value === value;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }

  async function load(refresh) {
    el.btnRefresh.disabled = true;
    const label = el.btnRefresh.textContent;
    if (refresh) el.btnRefresh.textContent = "Rafraîchissement…";
    try {
      const data = await window.MobilitesData.charger(reglages);
      charge = true;
      all = data.mobilites;
      listePays = data.pays;
      listeEtabs = data.etablissements;
      couleurs = Object.fromEntries(listePays.map((p) => [p.code, p.couleur]));
      render();
    } catch (err) {
      el.cards.innerHTML = '<p class="empty-state">Chargement impossible depuis Grist.</p>';
      el.tableWrap.innerHTML = "";
      showModal("Erreur de chargement", [err.message]);
    } finally {
      el.btnRefresh.disabled = false;
      el.btnRefresh.textContent = label;
    }
  }

  el.search.addEventListener("input", render);
  el.pays.addEventListener("change", render);
  el.annee.addEventListener("change", render);
  el.etab.addEventListener("change", render);
  el.du.addEventListener("change", render);
  el.au.addEventListener("change", render);
  el.statutBtns.forEach((b) =>
    b.addEventListener("click", () => {
      setStatut(b.dataset.value);
      render();
    }),
  );
  el.typeBtns.forEach((b) =>
    b.addEventListener("click", () => {
      setTypeCarte(b.dataset.value);
      render();
    }),
  );
  Object.keys(filtresBool).forEach((cle) =>
    document.querySelectorAll(`[data-filter="${cle}"]`).forEach((b) =>
      b.addEventListener("click", () => {
        setBool(cle, b.dataset.value);
        render();
      }),
    ),
  );
  el.btnReset.addEventListener("click", resetFilters);
  el.btnRefresh.addEventListener("click", () => load(true));
  el.modalClose.addEventListener("click", () => (el.modal.hidden = true));
  el.modal.addEventListener("click", (e) => {
    if (e.target === el.modal) el.modal.hidden = true;
  });
  window.addEventListener("hashchange", setVue);

  // --- Configuration des tables (options du widget, enregistrées dans la vue Grist) ---

  const TYPES_CONFIG = ["apprenants", "personnel", "collectives"];
  const NOMS_TYPES = { apprenants: "Apprenants", personnel: "Personnel", collectives: "Mobilités collectives" };
  const cfg = {
    panneau: document.getElementById("config"),
    erreur: document.getElementById("config-erreur"),
    champ: (type, role) => document.querySelector(`.config-type[data-type="${type}"] [data-role="${role}"]`),
  };

  function remplirListe(sel, tables, valeur, avecNonUtilise) {
    sel.innerHTML = (avecNonUtilise ? '<option value="">Non utilisé</option>' : "") +
      tables.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
    sel.value = valeur && tables.includes(valeur) ? valeur : avecNonUtilise ? "" : tables[0] || "";
  }

  async function ouvrirConfig(depuisDefaut) {
    const tables = (await grist.docApi.listTables()).filter((t) => !t.startsWith("_"));
    const base = depuisDefaut || !reglages ? window.MobilitesData.reglagesParDefaut(tables) : reglages;
    TYPES_CONFIG.forEach((type) => {
      const r = base[type];
      remplirListe(cfg.champ(type, "champs"), tables, r && r.champs, true);
      remplirListe(cfg.champ(type, "dossiers"), tables, r && r.dossiers, false);
      cfg.champ(type, "demarche").value = r ? r.demarche : "";
    });
    cfg.erreur.hidden = true;
    cfg.panneau.hidden = false;
  }

  // Choisir Demarche_72259_champs pré-remplit le n° de démarche et la table des dossiers
  TYPES_CONFIG.forEach((type) =>
    cfg.champ(type, "champs").addEventListener("change", (e) => {
      const m = e.target.value.match(/^Demarche_(\d+)_/);
      if (!m) return;
      cfg.champ(type, "demarche").value = m[1];
      const dossiers = cfg.champ(type, "dossiers");
      const cible = [...dossiers.options].map((o) => o.value)
        .find((v) => v === `Demarche_${m[1]}_dossiers` || v === `Demarche_${m[1]}_dossier`);
      if (cible) dossiers.value = cible;
    }),
  );

  function erreurConfig(message) {
    cfg.erreur.textContent = message;
    cfg.erreur.hidden = false;
  }

  async function enregistrerConfig() {
    const nouveau = {};
    for (const type of TYPES_CONFIG) {
      const champs = cfg.champ(type, "champs").value;
      if (!champs) {
        nouveau[type] = null;
        continue;
      }
      const dossiers = cfg.champ(type, "dossiers").value;
      const demarche = parseInt(cfg.champ(type, "demarche").value, 10);
      if (!dossiers || !demarche) {
        erreurConfig(`${NOMS_TYPES[type]} : choisissez la table des dossiers et le n° de démarche.`);
        return;
      }
      nouveau[type] = { champs, dossiers, demarche };
    }
    if (TYPES_CONFIG.every((t) => !nouveau[t])) {
      erreurConfig("Au moins un type de mobilité doit être utilisé.");
      return;
    }
    try {
      await grist.setOption("tables", nouveau); // déclenche onOptions, donc le rechargement
      cfg.panneau.hidden = true;
    } catch (err) {
      erreurConfig(`Enregistrement impossible (droits d'édition requis) : ${err.message}`);
    }
  }

  // Masque les pages et boutons des types non utilisés
  function appliquerTypesActifs() {
    TYPES_CONFIG.forEach((type) => {
      const actif = !reglages || !!reglages[type];
      document.querySelector(`.rail-icon[data-view="${type}"]`).closest(".rail-icon-wrap").hidden = !actif;
      document.querySelector(`[data-filter="type"][data-value="${type}"]`).hidden = !actif;
      if (!actif && typeCarte === type) setTypeCarte("tous");
    });
    const h = location.hash.slice(1) || "apprenants";
    if (reglages && TYPES_CONFIG.includes(h) && !reglages[h]) {
      history.replaceState(null, "", `#${TYPES_CONFIG.find((t) => reglages[t]) || "carte"}`);
    }
  }

  document.getElementById("btn-config").addEventListener("click", () => ouvrirConfig(false));
  document.getElementById("config-defaut").addEventListener("click", () => ouvrirConfig(true));
  document.getElementById("config-save").addEventListener("click", enregistrerConfig);
  document.getElementById("config-close").addEventListener("click", () => (cfg.panneau.hidden = true));

  // Accès complet requis : le widget lit plusieurs tables du document.
  // onEditOptions ajoute le bouton « Ouvrir la configuration » dans le panneau Grist.
  grist.ready({ requiredAccess: "full", allowSelectBy: false, onEditOptions: () => ouvrirConfig(false) });
  grist.onOptions((options) => {
    reglages = (options && options.tables) || null;
    appliquerTypesActifs();
    setVue();
    load(false);
  });
  // Filet de sécurité si Grist n'envoie pas d'options au démarrage
  setTimeout(() => {
    if (!charge) load(false);
  }, 1500);

  setVue();
  initMap();
})();
