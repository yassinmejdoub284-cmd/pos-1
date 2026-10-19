# Manuel à destination de l'administration fiscale

Version 0.7.0 - 19/10/2026. Documents de préparation à l'évaluation.

Avec le contribuable habilité, ouvrir NACEF. Contrôler série, IMDF, logiciel et environnement. Actualiser le manifeste et lire quota, certificat et état. Les fonctions de configuration et d'export nécessitent les privilèges contribuable.

Exporter une année via la section Clôture fiscale et export. Le format est JSON ouvert, lisible sans POS. `documents` conserve les payloads 1.1.4, réponses S-MDF, références, natures et états ; les incertitudes/rejets ne sont pas masqués. `periods` conserve les cumuls ; `integrity` contient la chaîne de preuves de l'année avec son prédécesseur ; `legacyAudit` conserve les événements ; `auditText` contient la piste ASCII séparée par deux-points et message JSON échappé.

Enregistrer le fichier téléchargé sur un support USB connecté au poste. La clé SHA-256 permet de détecter une altération accidentelle par comparaison ; une vérification HMAC authentifiée demande la clé sous le contrôle de l'installation. Les exports ne contiennent ni PIN ni OTP ni clé privée. Utiliser l'outil fourni `scripts/verify-fiscal-archive.mjs` pour vérifier la structure et le checksum ; le mode avec clé doit être utilisé par une personne habilitée et ne doit jamais publier la clé.

La piste est exportable séparément par cet outil avec `--audit-out`. La convention de nom du fichier de piste doit être MF_IMDF_MAC.txt, la MAC étant celle de l'équipement déclaré, normalisée sans deux-points sous Windows. Les informations du poste déclaré doivent être contrôlées par l'opérateur ; cette version ne déduit pas une MAC officielle d'un UUID logiciel.

Le parcours de restauration n'est pas ouvert à l'utilisateur. Toute purge est désactivée après activation NACEF. La portée des archives, leur scellement et les moyens de contrôle restent soumis à l'évaluation officielle et aux durées réglementaires applicables.
