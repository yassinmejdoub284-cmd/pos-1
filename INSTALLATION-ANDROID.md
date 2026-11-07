# Samurai POS — tablette Android hors ligne

Application Android légère (APK ≈ 3,6 Mo) pour tablettes d'entrée de gamme (3 Go de RAM), écran tactile et imprimante thermique Bluetooth. Même moteur de caisse que la version Windows : ventes, clôtures, stock, matières premières, rapports, synchronisation.

## Ce qui rend la version Android légère

- Pas de navigateur embarqué ni de framework : une seule WebView système plein écran, une interface de ~260 Ko et aucune animation, ombre ou flou.
- Base SQLite **native** (SQLite récent intégré à l'APK, identique d'Android 7 à 15), stockée dans l'espace privé de l'application. Pas de WebAssembly : moins de mémoire, données durables.
- Codes de connexion (PBKDF2) et empreintes calculés en natif : connexion immédiate même sur un processeur modeste.
- Si Android manque de mémoire et ferme l'affichage, l'application le recrée sans fermer la caisse (les ventes sont déjà enregistrées).

## Tactile

- Mise en page dédiée aux écrans 10" (1280×800) et 7–8" (1024×600) en paysage : 12 produits visibles sans défiler, recherche et familles sur une ligne, panier compact avec les deux boutons d'encaissement côte à côte.
- **Pavé numérique intégré** (grandes touches) pour les montants, quantités et codes : le clavier Android ne cache plus l'écran. La touche ⌨ revient au clavier Android si besoin.
- Grandes cibles (48 px), retour visuel immédiat, pas de zoom ni de sélection de texte accidentels, écran toujours allumé, plein écran.
- Bouton Retour : ferme la fenêtre ouverte ; deux appuis pour quitter.

## Imprimante Bluetooth (détection automatique)

1. Allumez l'imprimante ESC/POS (Xprinter, Goojprt, MTP, imprimante intégrée Sunmi/iMin…).
2. Au premier lancement, acceptez « Appareils à proximité » (Bluetooth).
3. Rien d'autre à faire si l'imprimante est déjà appairée : la caisse choisit automatiquement l'imprimante appairée (classe « imprimante » ou nom connu, sinon l'unique appareil appairé), prépare la connexion et se souvient de celle qui fonctionne.
4. Imprimante neuve : **Paramètres → Imprimantes & tickets → Détecter l'imprimante**. La caisse recherche les imprimantes proches et lance l'appairage (code souvent `0000` ou `1234`).

Réglages propres à la tablette, dans le même écran :

- **Largeur du papier** : 80 mm (48 caractères) ou 58 mm (32 caractères).
- **Mode d'impression** : *Texte rapide* (quelques Ko, instantané, accents simplifiés) ou *Graphique* (rendu identique au ticket Windows : accents, arabe, logo). Un ticket contenant de l'arabe passe automatiquement en graphique.
- **Ticket de test**, **Réglages Bluetooth**.
- Tiroir-caisse branché sur l'imprimante : impulsion envoyée après chaque ticket (broche 2 ou 5), comme sur Windows.

En cas d'échec (imprimante éteinte, hors de portée), la vente reste enregistrée et l'erreur est visible dans l'historique pour réimprimer.

## Installer

1. Téléchargez `Samurai-POS-Android-x.y.z.apk` depuis GitHub : onglet **Actions → Android APK → Artifacts**, ou la release de la version.
2. Sur la tablette, autorisez « Installer des applications inconnues » pour le navigateur ou le gestionnaire de fichiers, puis ouvrez l'APK.
3. Au premier lancement, créez l'établissement et le compte administrateur, ou restaurez une sauvegarde.
4. Recommandé : mettez à jour « Android System WebView » (ou Chrome) depuis le Play Store.

### Signature stable (à faire une fois)

Les mises à jour gardent les données uniquement si chaque APK est signé avec la même clé. Ajoutez dans GitHub → *Settings → Secrets and variables → Actions* :

| Secret | Valeur |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | fichier `.jks` encodé en base64 |
| `ANDROID_KEYSTORE_PASSWORD` | mot de passe du fichier |
| `ANDROID_KEY_ALIAS` | `samurai` |
| `ANDROID_KEY_PASSWORD` | mot de passe de la clé |

Sans ces secrets, l'APK est signé avec une clé de test qui change à chaque construction : il sert seulement à essayer, et une mise à jour demanderait de désinstaller (donc de restaurer une sauvegarde).

## Sauvegarde, restauration et passage du PC à la tablette

- **Paramètres → Sauvegarder la base** : choisissez l'emplacement (Téléchargements, Drive, clé USB…). Fichier `.sqlite` cohérent, compatible avec la version Windows.
- **Paramètres → Imprimantes & tickets → Restaurer une sauvegarde** : remplace les données de la tablette par une sauvegarde (Windows ou Android) après vérification. La base précédente est conservée dans l'application (3 dernières copies).
- Les données ne partent pas dans la sauvegarde automatique Google : utilisez la sauvegarde manuelle et la synchronisation.

## Synchronisation

Identique à Windows (**Paramètres → Synchronisation**, toutes les 20 minutes quand l'application est ouverte). Les requêtes passent par le réseau natif d'Android. La clé reste dans l'espace privé de l'application. L'afficheur client VFD (port COM) n'existe pas sur Android : le menu est masqué.

## Développement

```bash
npm ci
npm test                      # moteur + conversion ESC/POS + pont SQLite Android
npm run preview:android       # aperçu navigateur avec pont natif simulé (http://127.0.0.1:4179)
npm run build:android         # interface embarquée dans android/app/src/main/assets/www
cd android && gradle assembleRelease   # ou ouvrir le dossier android/ dans Android Studio
```

L'aperçu enregistre les tickets « imprimés » au format ESC/POS dans `data/android-prints/`. Avec `POS_ANDROID_PREVIEW_SEED=1`, il crée une démonstration (admin / 246810).

Structure : `mobile/` (démarrage, pont natif, conversion des tickets en ESC/POS, pavé tactile, CSS tablette), `android/` (application Java : WebView, SQLite embarqué, Bluetooth, fichiers), `backend/schema.mjs` (schéma partagé avec Windows).

Reste à valider sur la tablette réelle : papier imprimé avec votre modèle d'imprimante et confort tactile sur votre écran.
