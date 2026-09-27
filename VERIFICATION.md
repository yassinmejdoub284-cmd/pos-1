# Vérifications de la version 0.3.0

Date : 26 septembre 2026. Bases de test séparées des données de production.

## Nouveaux contrôles 0.3

- Les deux boutons enregistrent directement, sans fenêtre de paiement ni aperçu du ticket. Client de passage payé en espèces ; choix du paiement requis à l’écran pour un client sélectionné.
- Impression explicite : deux tâches client/cuisine même si les automatismes sont désactivés. Sans impression : aucune tâche créée. Double clic/reprise : même vente, aucun doublon.
- Charge fournisseur à crédit obligatoire avec fournisseur, solde correct, paiements partiels et plafond de règlement, permission et caisse espèces contrôlés.
- Règlements conservés après redémarrage et synchronisés sans doublon ; une charge ne compte qu’une fois dans le rapport.
- Parcours navigateur vérifié : vente espèces 8 DT, vente client à crédit 6,5 DT sans impression, règlement client 3 DT (reste 3,5), charge fournisseur à crédit 20 DT et règlement espèces 6 DT (reste 14). Attendu de caisse : 50 + 8 + 3 − 6 = 55 DT.
- Bouton menu masqué puis affiché, toujours accessible dans la barre supérieure.

## Résultats

- 45 tests automatisés réussis, aucun échec.
- Les 25 contrôles de la version 0.1 sont conservés : calculs, permissions, tickets, idempotence, crédit, redémarrage, pagination, positions et synchronisation HTTP.
- Remise d’un ticket mixte répartie en millimes : 7 DT + 2 DT − 1 DT = 8 DT ; filtres par famille et produit donnent 6,222 DT et 1,778 DT, soit exactement 8 DT.
- Filtres de période, famille, produit, paiement, service et caissier ; remboursement imputé à sa date et noms des filtres imprimés.
- Fournisseur créé à l’écran, charge liée de 2 DT, coordonnées et snapshot conservés ; droits de création/désactivation contrôlés et échange fournisseur vers le serveur testé.
- File d’impression : deux tickets durables, cuisine traitée malgré une panne client, ventes ajoutées pendant l’impression traitées, réimpression explicite, clôture automatique et interruption marquée à vérifier.
- Historique des clôtures conservé après redémarrage, restriction aux clôtures du caissier sans permission Rapports, filtres de dates/caissier et détail avec observation.
- Parcours navigateur : chapati 7 DT + fromage 1 DT, commentaire Sans oignon en cuisine, mode Sur place, ticket client 8 DT, charge fournisseur 2 DT, clôture 56 DT (50 + 8 − 2), écart nul, ticket 80 mm et consultation depuis l’historique.
- 12 produits présents sur une page à 1280 × 720, options agrandies, vues catalogue tableau/grille et thèmes clair/sombre contrôlés visuellement.

## Installation réelle

Les demandes d’impression ont été testées avec une sortie simulée et les aperçus HTML. Aucun ticket papier n’a été imprimé pendant ces tests. Vérifier les tickets client, cuisine et clôture ainsi que la coupe sur Xprinter XP-80 avant le service réel. Le pilote Windows est utilisé, sans modification des composants OPOS.

Le serveur Internet n’est pas encore disponible. Le moteur de synchronisation toutes les cinq heures est prêt et testé localement ; l’application doit rester ouverte. Le déploiement HTTPS et la restauration d’une sauvegarde sur un poste de secours restent à valider.

Les données de démonstration et les secrets de test ne sont pas inclus dans l’exécutable. La mise à jour conserve la base existante et ajoute la table des impressions de clôture.

Exécutable portable 0.3.0 démarré et arrêté normalement dans un dossier isolé : connexion interface/moteur confirmée, premier compte requis, Xprinter XP-80 sélectionnée. Aucun travail d’impression papier envoyé.

## Afficheur VFD

Quatre tests vérifient les paramètres série, la limitation ASCII 20 × 2, le prix produit avec supplément calculé par le moteur, le total après remise, les permissions, la conservation des paramètres et les ventes malgré une panne. Parcours navigateur : Chapati chawarma + fromage = 8.000 DT, puis TOTAL A PAYER 8.000 DT après encaissement avec impression. Bouton de test vérifié en simulation. Ports Windows COM6 et COM7 détectés. Le pilote conserve sa connexion, ferme le port à la sortie, et récupère après une tentative sur COM999 inexistant. Aucun envoi sur COM6 ou COM7. La validation physique et le protocole du modèle restent à confirmer.

## Vercel et suivi en ligne

45 tests réussis. La construction Vercel produit six fichiers statiques dans public et utilise les fonctions API PostgreSQL. Tests PostgreSQL exécutés avec PGlite (moteur PostgreSQL local), sans identifiant ni base externe : synchronisation réelle du moteur caisse, replay après perte de réponse, absence de doublons, conflits de catalogue, rollback financier, rapports filtrés, soldes clients/fournisseurs, clôture et authentification reconnue par une autre instance. Parcours navigateur de démonstration : ventes 15 DT, crédit client restant 4 DT, dette fournisseur 14 DT, clôture attendue/comptée 55 DT. Aucune dépendance de production vulnérable signalée par npm audit --omit=dev lors du contrôle. La base Neon et les secrets Vercel ne sont pas encore configurés ; le déploiement réel reste à vérifier après cette étape.
