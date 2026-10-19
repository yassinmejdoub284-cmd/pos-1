# Intégration NACEF - Samurai POS 0.7.0

Cette branche implémente le parcours S-MDF à partir du cahier NACEF v1.2 (01/08/2025), du manuel d'intégration v1.2 (10/11/2025) et des spécifications OpenAPI / ticket 1.1.4 fournis. Elle n'est ni un certificat d'homologation ni une preuve de connexion réelle à la préproduction.

## Mise en route

1. Utiliser une base de démonstration neuve. Ne pas présenter l'historique de gestion existant comme un historique fiscal signé.
2. Créer le compte éditeur sur https://homologation.nacef.tn, demander l'environnement, déclarer série/MAC, obtenir l'IMDF et le S-MDF adapté. Le manuel exige une IPv4 publique statique localisée en Tunisie pour l'environnement de tests.
3. Installer les binaires officiels S-MDF Client/Agent sur le poste cible. Les clés, PIN, pairing et OTP restent gérés par ces composants et leurs fenêtres.
4. Dans NACEF, renseigner l'identité attribuée, la référence d'homologation/test, l'IMDF et les familles/taxes réellement applicables. L'URL par défaut est http://localhost:10006/sic/external.
5. Activer en préproduction. L'activation verrouille le mode fiscal sur cette base. Vérifier l'état, demander le certificat, attendre sa génération, synchroniser et imprimer le ticket zéro.
6. Exécuter la procédure `verification-proctest.md` sur le matériel réel. Ne passer en production qu'après validation du montage, des données et de la version présentée par les services compétents.

## Livrables techniques

- `backend/nacef-client.mjs` : API réelle `/manifest`, `/certificate/request`, `/sync/request`, `/sign/request`, `/log/` sous `/sic/external`.
- `backend/nacef-schema.mjs` : transcription vérifiable du schéma ticket 1.1.4 fourni.
- `backend/fiscal-ticket.mjs` : conversion du panier TTC en ticket fiscal, validation JSON Schema et rapprochement arithmétique.
- `backend/fiscal.mjs` : configuration, états, réserve durable, signature, application, correction et périodes.
- `backend/fiscal-integrity.mjs` : journal HMAC chaîné et ancre externe au fichier SQLite.
- `frontend/fiscal.mjs` : espace contribuable. L'interface est soumise aux mêmes contrôles serveur que les appels IPC.

## Périmètre et limites à valider

- Le schéma 1.1.4 est utilisé ; les exemples Postman 1.1.3 et les montants d'enveloppe 100/119 ne sont pas repris. `operationType` reçoit TICKET/PROFORMA/REFUND/DUPLICATE et `transactionType` SALE/TRAINING, à vérifier avec le binaire officiel.
- Le code accepte une réponse directe ou l'enveloppe `object`/`objet`, les états numériques connus ou leurs noms, et le QR PNG/JPEG en base64 ou tableau d'octets. Les formes non reconnues sont bloquées.
- Paiements de caisse implémentés : espèces et carte, avec monnaie rendue en espèces. Le crédit existant n'est pas converti en un paiement NACEF fictif et reste bloqué dans le parcours fiscal. Paiements multiples, avantages fiscaux et taxe additionnelle non nulle nécessitent une spécification métier et des essais complémentaires avant activation de ces options.
- Les suppléments héritent de la famille fiscale du produit. Des suppléments soumis à une autre taxe exigent des lignes séparées / une évolution du modèle.
- Arrondi TTC : HT au millime, TVA par différence ; les restes sont répartis entre lignes/unités sans créer de fausse remise. Cette règle doit être validée sur les exemples et cas limites avec NACEF et le comptable.
- Le mode sans impression est masqué en fiscal ; chaque ticket signé est mis en file. Le succès du spooler n'est pas une preuve physique de sortie papier. Une impression incertaine exige une COPIE signée, pas une seconde signature de l'original.
- Une signature au résultat inconnu ne dispose d'aucun endpoint de recherche/réconciliation dans les API fournies : elle bloque les modifications et doit être rapprochée avec le support NACEF. Aucun bouton ne permet de fabriquer une signature ou de déclarer arbitrairement la réussite.
- Aucune purge/restauration automatique de données fiscales n'est exposée. La migration et la récupération d'une base ou clé perdue restent des interventions contrôlées.
- La version cible principale est Electron Windows Terminal. Le manuel autorise aussi des caisses dont le logiciel est en cloud ; cela ne supprime pas le déploiement du MDF/Agent requis. La topologie Server/mobile/cloud, le HTTPS, les certificats et le réseau doivent être validés séparément.
- Un administrateur est considéré comme le propriétaire/contribuable. Un prestataire ne doit pas recevoir un compte administrateur sur la caisse du contribuable. Les comptes ordinaires ont besoin de la permission explicite Contribuable NACEF ; le mode formation reste réservé à l'administrateur.

Les protections locales rendent les manipulations détectables dans le modèle de menace documenté. Elles ne constituent pas une preuve indépendante de résistance à un attaquant contrôlant le compte Windows, le stockage protégé et toutes les sauvegardes. L'évaluation officielle reste nécessaire.
