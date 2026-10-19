# Dossier de spécifications fonctionnelles

Version 0.7.0 - 19/10/2026.

## Rôles

Propriétaire administrateur : configuration, certificat, synchronisation, formation, contrôles et clôtures fiscales. Compte explicitement habilité `fiscal` : opérations contribuable autorisées, en complément des permissions POS. Compte de vente sans `fiscal` : refus du parcours de vente fiscal. Le prestataire utilise un compte sans privilèges contribuable ; aucun compte fournisseur ne doit être administrateur.

## Cycle de vente

Le panier est validé côté moteur à partir des produits actifs. Une tentative est identifiée par requestId et empreinte de contenu. L'état du S-MDF et sa correspondance IMDF sont contrôlés. Sans certificat généré/valide, pendant maintenance/suspension, sans synchronisation ou avec quota hors ligne épuisé, l'émission est refusée.

Le ticket 1.1.4 contient les données commerçant, site, utilisateur, logiciel, caisse, IMDF, lignes HT, taxes et paiement. Aucun coût matière ou commentaire cuisine n'est transmis. Une référence est réservée durablement avant l'appel de signature. Un résultat confirmé est enregistré et appliqué une seule fois, puis imprimé. Après erreur réseau ambiguë, aucun renvoi automatique du même document n'est possible.

## Documents

TICKET/SALE : chiffre d'affaires et stock. TICKET/TRAINING : fictif et marqué FORMATION. PROFORMA : document distinct sans recette. DUPLICATE : nouvelle référence et référence d'origine, sans deuxième recette. REFUND : document correctif positif, nature remboursement, impact négatif dans les cumuls et mouvement de restitution.

## Périodes et conservation

Clôtures journalière, mensuelle et annuelle ; refus d'une transaction sur une période clôturée ; montant de période et cumul perpétuel net conservés. Les compteurs ne sont pas réinitialisés par une mise à jour. Export annuel ouvert JSON et piste ASCII dans l'objet d'archive ; aucune purge financière après activation.

Les options métier non couvertes et points dépendant du binaire réel sont recensés dans README.md ; ils ne doivent pas être annoncés comme validés.
