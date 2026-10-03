# Mobilités Erasmus+ — widget Grist

Widget personnalisé Grist : tuiles des mobilités (apprenants, personnel, collectives),
carte des pays et tableau croisé. Aucune donnée dans ce dépôt : tout est lu dans le
document Grist, avec les droits de la personne connectée.

## Déploiement

1. Pousser ce dossier dans un dépôt GitHub, puis activer GitHub Pages
   (Settings > Pages > branche `main`, dossier `/root`).
2. Dans le document Grist : Ajouter une vue > Widget personnalisé > URL personnalisée,
   coller l'URL GitHub Pages.
3. Accorder l'accès complet quand Grist le demande (le widget lit six tables).

## Réglages

Tout est dans `static/js/config.js` : numéros de démarche, colonnes, palette, réglages de carte.

## Test en local

`python -m http.server 8000` dans ce dossier, puis utiliser `http://localhost:8000`
comme URL du widget dans Grist (même navigateur).
