# Dossier de conception générale

Version 0.7.0 - adaptation majeure NACEF, 19/10/2026.

La caisse Electron exécute un moteur Node.js 24 et conserve les données dans SQLite (WAL, synchronous FULL, foreign keys). Le renderer ne dispose pas d'accès Node direct ; les actions passent par une liste IPC autorisée et par `PosService.call` avec identité, droits et session.

La caisse CE appelle le S-MDF Agent officiel local. Le module officiel assure sa relation avec le Client et NACEF. Le cloud métier reçoit les ventes pour le reporting ; il n'est pas utilisé comme substitut de signature. La synchronisation du catalogue est différée pendant un engagement fiscal.

Modules : catalogue/recettes -> préparation du panier -> `FiscalService` -> Agent S-MDF -> résultat signé -> vente/stock -> file d'impression. Proforma et formation produisent des documents signés sans vente comptable ni consommation. Remboursement : nouveau document REFUND, lien avec la vente d'origine et mouvement de compensation.

Matériel : PC Windows, stockage durable, imprimante 80 mm, réseau et S-MDF adaptés, interface USB pour exports. Le terminal S-MDF est associé au poste ; les séries, IMDF et adresses enregistrées doivent correspondre au matériel de démonstration. Aucun prérequis de boîtier E-MDF n'est déduit pour le parcours S-MDF.

Historique : 0.6.1 gestion POS sans intégration fiscale ; 0.7.0 ajout du parcours NACEF, protections, écran et tests. Le dossier doit être complété avec références exactes de l'OS, imprimante, S-MDF, Agent et matériel soumis.
