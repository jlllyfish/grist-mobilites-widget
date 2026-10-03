// Lecture et normalisation des mobilités via l'API widget Grist.
// Portage fidèle de service/mobilites.py (version Flask) : mêmes règles, mêmes résultats.
window.MobilitesData = (function () {
  "use strict";
  const C = window.CONFIG;
  const EXCLUS = new Set(C.ETATS_EXCLUS);

  // --- Conversions ---

  const txt = (v) => (v === null || v === undefined ? "" : String(v).trim());

  // 12345, 12345.0 et "12345" donnent "12345"
  const num = (v) => txt(typeof v === "number" && Number.isInteger(v) ? Math.trunc(v) : v);

  function entier(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }

  // Case à cocher Grist (true/false) ou texte (Oui, true, 1...)
  function vrai(v) {
    if (typeof v === "boolean") return v;
    return ["true", "oui", "1", "yes", "vrai"].includes(txt(v).toLowerCase());
  }

  // Colonne Date Grist = timestamp Unix (secondes) ; colonne Texte = chaîne telle quelle
  function date(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") {
      const d = new Date(v * 1000);
      return Number.isNaN(d.getTime()) ? `invalide (${v})` : d.toISOString().slice(0, 10);
    }
    return txt(v);
  }

  const sansAccents = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  // Cherche "public" ou "prive" n'importe où dans la valeur
  function statut(v) {
    const t = sansAccents(v);
    if (t.includes("public")) return "public";
    if (t.includes("prive")) return "prive";
    return "autre";
  }

  // Nom d'abord : ALAYRAC Eloi -> AE
  const initiales = (nom, prenom) => (nom.slice(0, 1) + prenom.slice(0, 1)).toUpperCase() || "?";

  const numInt = (n) => (/^\d+$/.test(n) ? parseInt(n, 10) : -1);

  // Comparaison identique au tri Python (ordre des caractères, pas localeCompare)
  function cmpTuples(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  }

  // --- Accès Grist ---

  // fetchTable renvoie {col: [valeurs]} : on reconstruit des lignes
  async function lignes(table) {
    const t = await grist.docApi.fetchTable(table);
    const cols = Object.keys(t);
    const n = (t.id || []).length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const r = {};
      cols.forEach((c) => (r[c] = t[c][i]));
      out.push(r);
    }
    return out;
  }

  function verifierColonnes(rows, colonnes, table) {
    if (!rows.length) return;
    const manquantes = colonnes.filter((c) => !(c in rows[0]));
    if (manquantes.length) throw new Error(`Colonnes absentes de ${table} : ${manquantes.join(", ")}`);
  }

  function specifique(type, r) {
    if (type === "apprenants") {
      const nom = txt(r.nom_apprenant);
      const prenom = txt(r.prenom_apprenant);
      return {
        nom, prenom, initiales: initiales(nom, prenom),
        consortium: vrai(r.mobilite_consortium_erasmus),
        aide_dger: vrai(r.demande_d_aide_a_la_mobilite_dger_prevue),
      };
    }
    if (type === "personnel") {
      const nom = txt(r.nom);
      const prenom = txt(r.prenom);
      return { nom, prenom, initiales: initiales(nom, prenom), objet: txt(r.objet_de_la_mobilite) };
    }
    return { niveau: txt(r.niveau_de_formation), effectif: entier(r.effectif_total) };
  }

  // Même mobilité = même personne (ou même groupe), même pays, mêmes dates
  function cleDoublon(m) {
    const qui = m.type === "collectives"
      ? [m.etablissement.toLowerCase(), m.niveau.toLowerCase()]
      : [m.nom.toLowerCase(), m.prenom.toLowerCase()];
    return JSON.stringify([m.type, ...qui, m.pays_code, m.date_depart, m.date_retour]);
  }

  async function lireType(type, conf, tablesDoc) {
    const tableChamps = `Demarche_${conf.demarche}_champs`;
    // Table des dossiers : pluriel ou singulier selon le document
    const tableDossiers = [`Demarche_${conf.demarche}_dossiers`, `Demarche_${conf.demarche}_dossier`]
      .find((t) => tablesDoc.includes(t));
    if (!tablesDoc.includes(tableChamps)) throw new Error(`Table Grist introuvable : ${tableChamps}`);
    if (!tableDossiers) throw new Error(`Table Grist introuvable : Demarche_${conf.demarche}_dossiers`);

    const [champs, dossiers] = await Promise.all([lignes(tableChamps), lignes(tableDossiers)]);
    verifierColonnes(champs, C.COLONNES_COMMUNES.concat(conf.colonnes), tableChamps);
    verifierColonnes(dossiers, ["dossier_number", "state"], tableDossiers);

    const etats = new Map(dossiers.map((d) => [num(d.dossier_number), txt(d.state)]));
    const exclus = { sans_suite: 0, refuse: 0, doublons: 0 };
    const sansEtat = [];
    const retenues = new Map();

    champs.forEach((r) => {
      const n = num(r.dossier_number);
      const state = etats.has(n) ? etats.get(n) : null;
      if (EXCLUS.has(state)) {
        exclus[state] += 1;
        return;
      }
      if (state === null) sansEtat.push(n);

      const m = {
        type,
        demarche: conf.demarche,
        id: `${type}-${r.id}`,
        dossier_number: n,
        state: state || "inconnu",
        pays_nom: txt(r.pays_nom),
        pays_code: txt(r.pays_code).toUpperCase(),
        date_depart: date(r.date_depart),
        date_retour: date(r.date_retour),
        etablissement: txt(r.Etablissement),
        statut: statut(txt(r.statut_etablissement)),
        ...specifique(type, r),
      };
      const cle = cleDoublon(m);
      if (retenues.has(cle)) {
        exclus.doublons += 1;
        // on garde le dossier le plus récent (numéro le plus grand)
        if (numInt(n) < numInt(retenues.get(cle).dossier_number)) return;
      }
      retenues.set(cle, m);
    });
    return { liste: [...retenues.values()], exclus, sansEtat };
  }

  function listePays(mobilites) {
    const pays = new Map();
    mobilites.forEach((m) => m.pays_code && pays.set(m.pays_code, m.pays_nom));
    return [...pays.entries()]
      .sort((a, b) => cmpTuples([a[1]], [b[1]]))
      .map(([code, nom], i) => ({ code, nom, couleur: C.PALETTE[i % C.PALETTE.length] }));
  }

  function listeEtablissements(mobilites) {
    const s = new Set(mobilites.map((m) => m.etablissement).filter(Boolean));
    return [...s].sort((a, b) => cmpTuples([a.toLowerCase()], [b.toLowerCase()]));
  }

  // Même structure que la réponse de /api/mobilites dans la version Flask
  async function charger() {
    if (window.top === window.self) {
      throw new Error("Ce widget doit être ouvert dans Grist (widget personnalisé, accès complet).");
    }
    const tablesDoc = await grist.docApi.listTables();
    let mobilites = [];
    const exclus = {};
    const sans_etat = {};
    for (const [type, conf] of Object.entries(C.TYPES)) {
      const r = await lireType(type, conf, tablesDoc);
      mobilites = mobilites.concat(r.liste);
      exclus[type] = r.exclus;
      sans_etat[type] = r.sansEtat;
    }
    const tri = (m) => (m.type === "collectives"
      ? [m.type, m.etablissement.toLowerCase(), m.date_depart || ""]
      : [m.type, m.nom.toLowerCase(), m.prenom.toLowerCase()]);
    mobilites.sort((a, b) => cmpTuples(tri(a), tri(b)));

    const total = {};
    Object.keys(C.TYPES).forEach((t) => (total[t] = mobilites.filter((m) => m.type === t).length));
    return {
      total, exclus, sans_etat, mobilites,
      pays: listePays(mobilites),
      etablissements: listeEtablissements(mobilites),
    };
  }

  return { charger };
})();
