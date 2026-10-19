# Dossier utilisateur

Version 0.7.0 - 19/10/2026.

1. Se connecter avec le compte contribuable propriétaire. Ouvrir NACEF et saisir les paramètres officiels de l'installation ; valider les familles et taxes.
2. Activer en préproduction. Cliquer Actualiser l'état. À l'état initial, les ventes sont bloquées : obtenir le certificat électronique.
3. Demander le certificat. Saisir pairing, IMDF, OTP et PIN uniquement dans les fenêtres S-MDF. En tests, suivre la génération sur l'espace éditeur ; le manuel précise que le certificat de tests ne nécessite pas le déplacement physique prévu en production.
4. Synchroniser. Le ticket zéro retourné est envoyé à l'imprimante sur le poste Desktop. Si l'état reste en synchronisation, actualiser et attendre ; aucune vente n'est autorisée avant SYNCHRONIZED.
5. Saisir une vente et valider. Le paiement choisi doit être réellement effectué ; le ticket signé est mis en file d'impression. La vente ne doit pas être ressaisie après un problème de réponse : consulter l'historique / NACEF.
6. Pour une formation fictive : utiliser le bouton FORMATION réservé à l'administrateur. Pour un proforma : bouton dédié. Ils ne modifient pas la caisse ni le stock. Le bandeau test ne constitue pas à lui seul un mode Formation : c'est bien context TRAINING qui le matérialise.
7. Pour rembourser une vente fiscale : Historique, Annuler/rembourser et motif. Un REFUND distinct est signé. Pour obtenir une copie : utiliser la réimpression après original terminé, ou Créer une COPIE dans les documents NACEF.
8. Hors ligne, rester sous le quota et respecter l'état du S-MDF. Dès que la synchronisation est requise, synchroniser avant une nouvelle vente. Une suspension, révocation, maintenance ou expiration ne peut pas être contournée par la perte de réseau.
9. Clôturer les sessions caissiers, puis effectuer les clôtures fiscales de journée/mois/année. Contrôler montants et cumul perpétuel avant confirmation.
10. Exporter chaque année depuis NACEF et conserver les sauvegardes sur des supports distincts avec les clés et preuves nécessaires.

En cas de résultat UNKNOWN/SENDING, ne pas changer d'identifiant de demande pour forcer un nouveau ticket. Le bouton Reprendre n'envoie jamais à nouveau ces états : il sert aux préparations non envoyées ou résultats signés localement non encore appliqués. Un rapprochement NACEF est requis pour l'incertitude distante.
