# FlexPay — Backend

API Node.js/Express + PostgreSQL (Prisma) pour l'application FlexPay.

## Documentation API

Une documentation interactive complète (Swagger UI) est servie directement par le serveur, à `/docs` — aucune installation supplémentaire nécessaire. La spécification brute (OpenAPI 3.0) est disponible à `/docs.json`, utilisable pour générer un client, une collection Postman, ou un SDK.

Cette documentation couvre l'ensemble des services FlexPay, mais la section **Payments API (Partenaires)** est celle qui intéresse un développeur externe voulant intégrer FlexPay dans sa propre application (clé API, pas de token utilisateur).

## Installation

```bash
npm install
cp .env.example .env   # puis éditer DATABASE_URL et les secrets JWT
npx prisma migrate dev --name init
node scripts/create-admin.js "Ton Nom" admin@flexpay.gn motdepasse SUPERADMIN
npm run dev
```

## Tests

```bash
npm test              # suite complète
npm run test:watch    # mode watch pendant le développement
npm run test:coverage # avec rapport de couverture
```

### Stratégie de tests

**Tests unitaires** (`tests/unit/`) — fonctions pures, aucune dépendance externe : calcul des plafonds, des frais, génération/vérification JWT et OTP, comportement réel du limiteur de débit.

**Tests de service** (`tests/service/`) — logique métier des services (`wallet.service`, `auth.service`), avec le module `src/config/db.js` entièrement mocké. On ne teste jamais contre une vraie base ici : on vérifie que la logique (plafonds respectés, partie double équilibrée, verrouillage de compte, messages d'erreur anti-énumération) se comporte correctement pour n'importe quelle réponse que la base pourrait renvoyer — rapide, déterministe, ne dépend d'aucune infrastructure.

**Tests HTTP** (`tests/http/`) — via Supertest, contre l'app Express réelle (toujours avec la base mockée) : vérifie que les routes, la validation Zod, et les middlewares (`requireAuth`, limiteurs) sont bien branchés ensemble, pas seulement que la logique métier isolée fonctionne.

**Ce qui manque volontairement à ce stade** : des tests d'intégration contre une vraie base PostgreSQL (dossier `tests/integration/`, pas encore créé). La CI est déjà configurée pour en faire tourner (voir `.github/workflows/ci.yml`, service PostgreSQL inclus) — il ne reste qu'à les écrire, once le besoin s'en fait sentir (ex: vérifier qu'une vraie migration Prisma s'applique proprement, qu'une contrainte de clé étrangère fonctionne comme prévu).

### Note sur l'environnement de développement

Si `npx prisma generate` ou `migrate` échouent avec une erreur de téléchargement de moteur (`Failed to fetch... binaries.prisma.sh`), c'est un problème réseau local (proxy, pare-feu) empêchant Prisma de télécharger son moteur natif — pas un problème avec le code. Ça n'affecte jamais `npm test`, qui ne s'appuie sur aucune connexion Prisma réelle.

## Scan antivirus (ClamAV)

Le module Files scanne chaque fichier uploadé (pièces d'identité KYC/KYB) avant tout stockage, via le binaire `clamscan` réel.

**Installation sur le serveur (Ubuntu/Debian) :**
```bash
sudo apt-get install clamav clamav-daemon
sudo freshclam   # télécharge les vraies définitions de virus - nécessite un accès internet normal
```

**En développement**, si ClamAV n'est pas installé sur ta machine, mets `VIRUS_SCAN_PROVIDER=disabled` dans `.env` — les uploads restent autorisés (`ALLOW_UNSCANNED_UPLOADS=true`), mais **jamais en production** : même avec ce flag, un scan indisponible bloque systématiquement l'upload dès que `NODE_ENV=production`.

**Note sur l'environnement où ce projet a été construit** : `database.clamav.net` y était inaccessible (réseau restreint), donc `freshclam` ne pouvait pas télécharger la vraie base de signatures. L'intégration a été testée de bout en bout avec une signature de test (EICAR, le fichier de test standard de l'industrie antivirus — voir `tests/fixtures/eicar-test.ndb` et `tests/service/clamavProvider.integration.test.js`), pas avec des mocks. Sur un vrai serveur avec accès internet normal, `freshclam` fonctionne sans aucun changement de code.

## CI/CD

Chaque push et pull request sur `main`/`develop` déclenche automatiquement (`.github/workflows/ci.yml`) :
1. Installation des dépendances
2. Génération du client Prisma + application des migrations sur une vraie base PostgreSQL (service container)
3. Suite de tests complète avec rapport de couverture
4. Vérification syntaxique de tous les fichiers

## Scripts utilitaires

- `scripts/create-admin.js` — crée un compte admin (jamais via l'API, volontairement)
- `scripts/create-api-client.js` — crée un partenaire API en ligne de commande (préférer la route admin `/admin/api-clients` en usage courant)

Voir `../FlexPay_Specification.md` (à la racine du projet) pour la documentation complète des modules, plafonds, et décisions produit.
