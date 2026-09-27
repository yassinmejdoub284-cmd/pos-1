# Déployer le suivi en ligne sur Vercel

Le PC Windows garde les ventes dans sa base locale. Vercel reçoit les synchronisations et affiche les rapports, clôtures, clients, fournisseurs, charges, règlements et dernières réceptions par poste. Le tableau de bord consulte les données reçues ; il ne remplace pas la caisse Windows.

## 1. Connecter le dépôt

Dans Vercel, importer `yassinmejdoub284-cmd/pos-1`, branche `main` et dossier racine du dépôt. Choisir **Other** comme framework. La configuration `vercel.json` fournit :

- Installation : `npm ci --omit=dev`
- Construction : `npm run build:web`
- Dossier de sortie : `public`

Supprimer les anciennes surcharges de Build Command et Output Directory dans les réglages du projet. Vercel doit construire le tableau de bord web. Le fichier Windows se construit séparément sur un PC Windows avec `npm run build`.

## 2. Créer la base en ligne

Dans le projet Vercel, ouvrir **Storage → Create Database**, choisir l’intégration **Neon / PostgreSQL**, puis connecter cette base au projet. Choisir la région la plus proche de celle des fonctions. Vérifier les conditions du plan choisi avant de valider la création.

Récupérer la chaîne de connexion PostgreSQL fournie par l’intégration. Si elle ajoute `POSTGRES_URL`, le serveur l’utilise directement. Sinon ajouter la chaîne de connexion dans **Settings → Environment Variables → DATABASE_URL**. Conserver la connexion chiffrée et les paramètres SSL fournis par Neon. Ne pas mettre cette adresse dans le code ou GitHub.

Les tables `pos_*` sont créées automatiquement lors du premier accès. Aucune base SQLite locale ne doit être téléversée sur Vercel.

## 3. Ajouter les secrets

Dans **Settings → Environment Variables**, pour l’environnement **Production** :

| Nom | Valeur à définir vous-même |
|---|---|
| `DATABASE_URL` ou `POSTGRES_URL` | Connexion PostgreSQL fournie par la base |
| `SYNC_TOKEN` | Clé aléatoire privée d’au moins 24 caractères |
| `ADMIN_PASSWORD` | Mot de passe privé du suivi en ligne, au moins 12 caractères |

Générer une clé de synchronisation dans PowerShell si nécessaire :

```powershell
$posSyncBytes = New-Object byte[] 32
$posRandom = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$posRandom.GetBytes($posSyncBytes)
$posRandom.Dispose()
[Convert]::ToBase64String($posSyncBytes)
```

Conserver cette valeur dans un gestionnaire de mots de passe. Elle doit être identique sur Vercel et dans la caisse. Le mot de passe du tableau de bord est distinct du code du caissier. Ne pas utiliser une base de production pour les Preview Deployments.

## 4. Redéployer et vérifier

Lancer **Redeploy** après la configuration des variables. Ouvrir `https://votre-projet.vercel.app/health` : il doit afficher `ok: true`, `configured: true`, `storage: postgresql`. Si des variables manquent, leurs noms sont indiqués. La page d’accueil affiche la connexion au tableau de bord.

Se connecter avec `ADMIN_PASSWORD`. Un tableau de bord vide est normal avant le premier envoi de la caisse. Les sessions de connexion expirent après une heure.

## 5. Relier la caisse Windows

Dans la caisse : **Paramètres → Synchronisation** :

1. Activer la synchronisation.
2. Adresse du serveur : `https://votre-projet.vercel.app` (sans `/sync` à la fin).
3. Clé : la valeur privée de `SYNC_TOKEN`.
4. Enregistrer, puis ouvrir **Synchronisation → Synchroniser** pour le premier envoi.

Le logiciel reste utilisable hors ligne. Tant qu’il est ouvert, il envoie toutes les 5 heures après la dernière réussite ; après une panne, les opérations restent en attente et les essais reprennent après 5 minutes. L’envoi manuel permet de transmettre immédiatement une clôture. Il n’est pas nécessaire de créer un cron Vercel : le PC déclenche les envois.

Actualiser le suivi en ligne. Vérifier le nombre de tickets, les soldes clients et fournisseurs, une clôture, puis la date de réception dans **Synchronisations**. Les filtres famille/produit/paiement/service concernent les ventes ; les soldes portent sur tout l’historique reçu.

Si la caisse reçoit 401 ou une page HTML Vercel, vérifier sa clé et les réglages de **Deployment Protection** : `/sync` doit être accessible au logiciel avec la clé applicative. Ne pas exposer les données administrateur sans connexion.

## État de validation

Construction web et tests locaux disponibles dans le dépôt. Le déploiement réel et les échanges sur votre domaine Vercel restent à vérifier après création de la base et configuration des trois variables.
