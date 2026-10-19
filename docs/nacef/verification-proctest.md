# Procédure de vérification - démonstration réelle

Source fournie : manuel NACEF-PROCTEST, version interne 1.2, 10/11/2025, annexe pages 12-15. La procédure est provisoire et ne remplace pas l'homologation. Ne pas présenter les résultats de mocks comme une réussite officielle.

Préparer un poste neuf, accès au téléphone/email du représentant, environnement accepté, S-MDF/Agent officiels et imprimante réelle. Ne pas simuler une révocation de certificat de production. Les durées et quotas viennent du manifeste ; ne pas coder « 10 tickets » comme une règle globale parce que la démonstration comporte 3 puis 7 tickets hors ligne.

| Étapes | Contrôle | Couverture locale | Preuve réelle à joindre |
|---|---|---|---|
| 1-2 | Privilèges, IMDF et familles/TVA | API et interface, tests de droits | Captures et comptes utilisés |
| 3-4 | État initial / 401 et vente refusée | Client 401, gate certificat | Manifest et refus sur poste neuf |
| 5-8 | Demande, attente, certificat généré sans sync | États et blocages simulés | Pairing/OTP via S-MDF et suivi plateforme |
| 9 | Première sync et ticket zéro | QR conservé + impression native branchée | Ticket zéro physique |
| 10 | Deux transactions online | Tickets validés, enveloppe cohérente | Arrivée effective sur NACEF et tickets |
| 11-13 | Trois offline, retour online, nouvelle vente | Quota et contrôle frais simulés | Coupure réseau réelle et manifeste |
| 14-17 | Sept offline, refus, nouvelle sync | Quota / NOT_SYNCHRONIZED simulés | Contrôle réel dans l'ordre prescrit |
| 18-19 | Suspension et refus online/offline | Simulé | Suspension depuis plateforme de tests |
| 20-21 | Révocation et refus online/offline | Simulé | Révocation depuis plateforme de tests |

Compléments locaux : résultat de signature perdu, reprise après redémarrage sans double signature, copies distinctes, remboursement, proforma/formation sans recette, périodes clôturées, altération du journal, troncature avec tête SQLite réécrite et absence de clé. Valider séparément les structures réelles QR/réponses, arrondis, topologie réseau et comportement imprimante.
