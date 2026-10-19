# Dossier d'architecture technique

Version 0.7.0 - 19/10/2026.

## Stockage et transaction externe

Tables `fiscal_documents`, `fiscal_applied_documents`, `fiscal_integrity`, `fiscal_periods`, `fiscal_print_jobs`, `fiscal_log_outbox`. Les snapshots du document, son identité et sa signature sont immuables après enregistrement. Les écritures de vente sont atomiques avec stock, outbox et marque d'application. La préparation est un essai transactionnel annulé, puis un document durable contenant le snapshot validé.

États : PREPARED -> SENDING -> SIGNED ou REJECTED/UNKNOWN. SENDING est écrit avant le réseau. Après redémarrage, SENDING/UNKNOWN ne sont jamais automatiquement renvoyés. Un SIGNED non appliqué est repris sans nouvelle signature. Les échecs explicitement rejetés restent conservés et leur référence n'est pas réutilisée.

## API S-MDF

Base locale `http://localhost:10006/sic/external`, GET manifest, POST certificate/request, sync/request, sign/request et log/. Appels POST JSON, ticket JSON UTF-8 encodé base64. TotalHT et TotalTax proviennent du même payload validé en millimes. Les codes HTTP et errorCode sont contrôlés ; pas de retry automatique d'une signature. Les OTP/PIN sont gérés par le S-MDF, sans champ ni stockage dans POS.

## Intégrité

Journal canonique, HMAC SHA-256 avec lien au digest précédent et séquence contiguë. La vérification compare aussi les snapshots de documents signés, ventes appliquées, traces audit et empreintes de reprise des données antérieures. Les triggers refusent UPDATE/DELETE des données protégées via les fonctions ordinaires.

La clé est séparée du SQLite ; Electron la protège avec safeStorage Windows. L'ancre signée est séparée dans `.integrity-head`, mise à jour après COMMIT. Un journal qui prolonge une ancienne ancre valide après coupure peut être scellé ; un journal tronqué avant l'ancre est rejeté, même si sa tête SQLite est modifiée. Chaque transaction vérifie les preuves avant de les prolonger.

Ce modèle détecte les modifications du fichier SQLite sans contrôle simultané de la clé et de l'ancre. Il ne prétend pas résister à une compromission totale de l'OS/compte ou à un rollback complet de tous les supports et ancres. Faire évaluer le procédé par l'unité d'homologation.

## Impression / export

Le ticket client est rendu depuis le payload signé, pas le catalogue courant. Le QR est fourni par le S-MDF, avec validation de format image ; la caisse ne fabrique pas de QR fiscal. Une tâche en impression lors d'une coupure devient incertaine. Les documents de copie/remboursement ont leur propre tâche. Export annuel JSON ouvert, SHA-256 et HMAC, avec preuves chaînées et piste ASCII échappée. La vérification d'authenticité exige la clé contrôlée ; le SHA seul est un contrôle d'intégrité non authentifié.
