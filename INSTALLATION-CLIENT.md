# Installer Samurai POS chez le client — Windows hors ligne

## Le fichier à remettre

Remettre **Samurai-POS-0.3.3.exe** depuis le dossier `application/release`. C’est une application portable pour Windows 10/11 64 bits : aucun installateur Node.js, Git ou Electron n’est nécessaire sur le PC du client. Le fichier peut être transmis par clé USB. Le dépôt GitHub contient le code source ; il ne contient pas l’exécutable.

Sur le poste de développement, pour reconstruire le fichier : installer Node.js, ouvrir le dossier du code puis exécuter `npm ci` et `npm run build`. Le résultat se trouve dans `release/Samurai-POS-0.3.3.exe`.

## 1. Copier et démarrer

1. Copier l’exécutable dans un dossier fixe, par exemple `C:\Samurai-POS`.
2. Créer un raccourci sur le Bureau si souhaité.
3. L’ouvrir par double clic avec le compte Windows habituel du caissier.
4. Au premier démarrage, saisir le nom de l’établissement, créer l’administrateur et choisir son code de 6 à 12 chiffres. Il n’y a pas de compte de production préinstallé.

Le fichier est actuellement non signé : Windows peut signaler un éditeur inconnu. Vérifier que le fichier provient bien de votre livraison avant toute autorisation d’exécution. Fermer une ancienne version avant de lancer une mise à jour.

Une mise à jour du fichier EXE conserve la base du même compte Windows dans AppData. Le nouveau bouton **Vider le stockage** n'efface rien pendant l'installation : seul un administrateur peut l'utiliser depuis les paramètres avec le code de sécurité, après fermeture de toutes les caisses.

## 2. Préparer les modules

- **Paramètres → Entreprise** : nom, adresse, téléphone, matricule fiscal, logo et pied de ticket.
- **Équipe & accès** : créer les caissiers et attribuer leurs droits.
- **Catalogue** : créer les familles, produits, suppléments et commentaires. Organiser les positions si nécessaire.
- **Clients / Fournisseurs** : enregistrer les fiches et plafonds de crédit.
- **Charges** : créer les catégories de dépenses.

## 3. Imprimante et afficheur

Installer le pilote Windows de l’imprimante 80 mm et vérifier une page de test dans Windows. Dans **Paramètres → Imprimantes & tickets**, choisir l’imprimante client et l’imprimante cuisine. Elles peuvent être la même imprimante. Tester un ticket client, un bon cuisine et une clôture pour vérifier la taille, la coupe et les commentaires.

Brancher le tiroir au connecteur RJ11/RJ12 de l'imprimante. Dans le même écran, activer **Ouvrir le tiroir-caisse après chaque impression**, choisir l'imprimante du tiroir, puis **Tester le tiroir**. La broche 2 est le réglage standard ; essayer la broche 5 si le câblage du tiroir le demande. Le pilote et l'imprimante doivent accepter la commande ESC/POS `ESC p` en impression Windows RAW.

Pour un afficheur : installer son pilote, repérer son port dans le Gestionnaire de périphériques, ouvrir **Afficheur VFD**, choisir COM et les paramètres du fabricant, activer, enregistrer puis tester. Le protocole du modèle doit correspondre au choix Epson DM-D ou texte brut.

## 4. Commencer le service

Ouvrir la caisse avec le fond en espèces. Ajouter les produits et leurs options. Le client de passage est encaissé en espèces ; pour un client enregistré, choisir Espèces, Carte ou Crédit.

- **Encaisser et imprimer** : enregistre et envoie les deux tickets directement.
- **Encaisser sans impression** : enregistre sans ticket.
- **Clôture** : compter les espèces, expliquer un éventuel écart et confirmer. Le justificatif est imprimé selon les paramètres.

## 5. Où sont les données ?

La base `samurai-pos.sqlite` reste dans le dossier de données de Samurai POS sous `%APPDATA%` du compte Windows utilisé. L’application crée ce dossier au premier lancement. Les données ne sont pas stockées dans le fichier `.exe` ni à côté de la clé USB.

Utiliser le même compte Windows pour retrouver la même caisse. Dans **Paramètres → Sauvegarder la base**, produire régulièrement une sauvegarde SQLite sur un autre support. Conserver aussi les codes d’accès et la clé de synchronisation dans un endroit protégé.

## 6. Activer le suivi en ligne

Après configuration de Vercel, saisir son adresse et la clé dans **Paramètres → Synchronisation**. Effectuer le premier envoi manuellement. Ensuite laisser l’application ouverte : les envois automatiques se font toutes les 20 minutes lorsqu’Internet est disponible. La caisse fonctionne toujours sans connexion.

Voir `DEPLOIEMENT-VERCEL.md` pour le serveur. Les données envoyées comprennent les rapports de ventes, clôtures, fiches clients/fournisseurs, charges et règlements.

## 7. Mettre à jour le logiciel

Sauvegarder la base, fermer l’application, remplacer uniquement l’ancien `.exe` puis lancer la nouvelle version avec le même compte Windows. Conserver le dossier de données AppData. Une mise à jour de l’exécutable ne demande pas de recréer l’établissement.

Avant le service réel, contrôler un encaissement, les tickets papier, les règlements et une clôture sur le matériel du client.
