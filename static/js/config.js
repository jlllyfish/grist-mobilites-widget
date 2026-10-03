// Réglages du widget : tables Grist, colonnes, couleurs et carte
window.CONFIG = {
  DN_URL: "https://demarche.numerique.gouv.fr/procedures/",
  WORLD_URL: "static/geo/world.topo.json",

  // Colonnes communes aux trois démarches
  COLONNES_COMMUNES: [
    "dossier_number", "pays_nom", "pays_code", "date_depart", "date_retour",
    "Etablissement", "statut_etablissement",
  ],
  TYPES: {
    apprenants: {
      demarche: 70018,
      colonnes: ["nom_apprenant", "prenom_apprenant", "mobilite_consortium_erasmus",
        "demande_d_aide_a_la_mobilite_dger_prevue"],
    },
    personnel: { demarche: 72259, colonnes: ["nom", "prenom", "objet_de_la_mobilite"] },
    collectives: { demarche: 70020, colonnes: ["niveau_de_formation", "effectif_total"] },
  },
  ETATS_EXCLUS: ["sans_suite", "refuse"],

  // Couleurs des badges pays (contraste suffisant avec du texte blanc)
  PALETTE: [
    "#4F46E5", "#0F766E", "#BE185D", "#B45309", "#7C3AED", "#0369A1", "#15803D", "#C2410C",
    "#A21CAF", "#1D4ED8", "#0E7490", "#4D7C0F", "#B91C1C", "#9333EA", "#475569", "#854D0E",
  ],

  // Carte
  GRIS_CLAIR: "#c9c7d1", // pays avec le moins de mobilités
  GRIS_FONCE: "#17151f", // pays avec le plus de mobilités
  ZOOM_MAX: 30, // zoom manuel maximum
  ZOOM_AUTO_MAX: 8, // plafond du recadrage automatique
  MARGE_AUTO: 0.4, // part de la carte occupée par la sélection
  RAYON_CADRAGE_DEG: 8, // territoire principal : îles à moins de 8° gardées
};
