# Dossier de maintenance

Version 0.7.0 - 19/10/2026.

Toute modification des parcours d'encaissement, signature, conservation, correction, taxes ou clôture est considérée comme affectant potentiellement l'homologation. Cette version 0.7.0 doit être présentée avec ses sources, paramètres et résultats de tests ; l'application ne crée aucun certificat de conformité.

Avant intervention : sauvegarder SQLite, clé et ancre d'intégrité ; conserver l'archive annuelle ; relever logiciel/OS/S-MDF/Agent, série, IMDF et incident. Déclarer l'intervention requise sur la plateforme NACEF et conserver son compte rendu. Ne jamais déplacer les dossiers S-MDF officiels ni manipuler leurs clés.

Après intervention : contrôler l'intégrité, vérifier le manifeste, suivre les demandes de synchronisation/PIN du S-MDF et vérifier le ticket zéro si renvoyé. Le remplacement d'IMDF requiert un motif et produit une trace avec ancienne/nouvelle configuration.

Signature inconnue : relever référence, identifiant de document, heure et erreur. Ne pas recréer le même encaissement avec un autre requestId. Contacter le support NACEF pour rapprocher la transaction ; aucun endpoint de recherche n'étant fourni, cette version ne propose pas de déblocage arbitraire. Une signature confirmée localement mais non appliquée peut être reprise via l'action dédiée.

Panne d'impression : tâche error connue, relancer l'impression existante ; résultat incertain ou original terminé, produire une nouvelle transaction COPIE. Panne du tiroir : ne pas recréer la vente. Une sauvegarde corrompue ou une clé perdue exige une procédure de récupération contrôlée avant remise en service.

Gestion des vulnérabilités : versions verrouillées dans package-lock, revue des dépendances, tests de non-régression avant diffusion, journal de version et registre clients/version à tenir par le fournisseur. Les coordonnées SAV, horaires, responsables, contrats et délais d'intervention restent à compléter par SoluMove dans le dossier d'accréditation.
