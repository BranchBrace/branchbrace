# Activer la signature Windows (Azure Artifact Signing)

Guide pas à pas pour activer la signature de l'installateur Windows décidée dans
[l'ADR 0004](adr/0004-windows-code-signing.md). Le code est déjà prêt : une fois ces étapes
terminées, la release suivante sur `rc` sort signée sans autre changement.

Ce qu'il faut avoir sous la main :

- le SIREN et l'adresse officielle de l'entité (telle qu'elle figure au registre) ;
- un **site web** de l'entité et **deux adresses e-mail sur un domaine qu'elle possède**
  (`contact@mondomaine.fr`, pas une adresse Gmail ou Outlook) ;
- une pièce d'identité officielle de la personne qui représente l'entité, et un smartphone ;
- un moyen de paiement pour l'abonnement Azure.

Durée : ~1 h de clics, puis **1 à 20 jours ouvrés** d'instruction par Microsoft pour la
validation d'identité (étape 4). Les étapes 6 et 7 peuvent se faire pendant cette attente.

---

## 1. Abonnement Azure

1. Se connecter au [portail Azure](https://portal.azure.com/) (créer un compte si besoin).
2. Avoir un abonnement **payant** (Pay-As-You-Go). Rechercher **Subscriptions** pour le vérifier.

## 2. Enregistrer le fournisseur `Microsoft.CodeSigning`

1. **Subscriptions** → choisir l'abonnement → menu **Settings** → **Resource providers**.
2. Sélectionner **Microsoft.CodeSigning** → **…** → **Register**.
3. Attendre que le statut passe à **Registered**.

## 3. Créer le compte Artifact Signing

1. Rechercher **Artifact Signing Accounts** → **Create**.
2. Remplir :

   | Champ | Valeur |
   |---|---|
   | Subscription | l'abonnement de l'étape 1 |
   | Resource group | **Create new** → `branchbrace-signing` |
   | Account name | ex. `branchbrace` (3 à 24 caractères, commence par une lettre, unique au monde) |
   | Region | **North Europe** (sinon **Poland Central**) |
   | Pricing | **Basic** (~9,99 $/mois, 5 000 signatures) |

3. **Review + Create** → **Create** → **Go to resource**.

Noter le nom du compte et la région : ils servent à l'étape 8.

La région n'a d'effet ni sur le certificat ni sur la validation d'identité. West Europe refuse les
nouveaux clients (`RequestDisallowedByAzure` : « The selected region is currently not accepting
new customers ») : dans ce cas, prendre une autre région européenne.

| Région | Endpoint (étape 8) |
|---|---|
| North Europe | `neu.codesigning.azure.net` |
| Poland Central | `plc.codesigning.azure.net` |
| Switzerland North | `swn.codesigning.azure.net` |
| West Europe | `weu.codesigning.azure.net` |

## 4. Validation d'identité de l'entité

### 4a. Se donner le rôle de vérificateur

Sans ce rôle, le bouton **New identity** reste grisé.

1. Dans le compte Artifact Signing → **Access control (IAM)** → **Add** → **Add role assignment**.
2. Rôle **Artifact Signing Identity Verifier** → **Next** → **Select members** → soi-même →
   **Review + assign**.

### 4b. Créer la demande

1. Dans le compte → **Objects** → **Identity validations**.
2. **Organization** → **New Identity** → **Public**.
3. Remplir **exactement** comme au registre des entreprises — une erreur oblige à refaire
   une demande complète :

   | Champ | Valeur |
   |---|---|
   | Organization Name | dénomination légale de l'entité |
   | Website url | site de l'entité |
   | Primary Email | adresse sur le domaine de l'entité, surveillée (les liens expirent en 7 jours) |
   | Secondary Email | autre adresse, même domaine |
   | Business Identifier | le SIREN |
   | Seller ID | laisser vide (Microsoft Store uniquement) |
   | Adresse | adresse officielle de l'entité |
   | First Name / Last Name | du représentant, exactement comme sur sa pièce d'identité |

4. Vérifier **Certificate subject preview** : c'est le nom que verront les utilisateurs.
   **Le noter mot pour mot** (ligne `CN=`), il sert à l'étape 8.
5. **Create**. Le statut passe à **In Progress**.

### 4c. Suivre la demande

- Valider le lien reçu sur l'adresse principale.
- Quand le statut passe à **Action Required** : cliquer sur le nom dans la liste → lien
  « Please complete your verification here » (aussi envoyé par e-mail). Le représentant fait la
  vérification d'identité sur smartphone (pièce d'identité, puis ajout d'un « Verified ID » dans
  l'application Microsoft Authenticator).
- Si Microsoft demande des documents (Kbis de moins de 12 mois, facture du nom de domaine…),
  les déposer dans le portail. Trois tentatives maximum.
- Attendre le statut **Completed** (e-mail de confirmation). En cas de **Failed**, il faut créer
  une nouvelle demande.

## 5. Créer le profil de certificat

À faire une fois la validation **Completed**.

1. Dans le compte → **Objects** → **Certificate profiles** → **Create** → **Public Trust**.
2. **Certificate Profile Name** : ex. `branchbrace-release` (5 caractères minimum).
3. **Verified CN and O** : la validation de l'étape 4. Laisser **Program Type** sur *None* et
   décocher l'adresse et le code postal.
4. **Create**.

Noter le nom du profil : il sert à l'étape 8.

## 6. Créer l'application qui signe depuis GitHub

GitHub Actions se connecte à Azure par OIDC : aucun mot de passe ni secret n'est stocké.

1. Ouvrir le [centre d'administration Microsoft Entra](https://entra.microsoft.com) →
   **App registrations** → **New registration**.
2. Nom `branchbrace-github-signing`, type de compte *single tenant*, pas d'URI de redirection →
   **Register**.
3. Sur la page **Overview**, noter :
   - **Application (client) ID** → `AZURE_CLIENT_ID` ;
   - **Directory (tenant) ID** → `AZURE_TENANT_ID`.
4. **Certificates & secrets** → onglet **Federated credentials** → **Add credential**, **deux
   fois** :

   | Champ | 1ʳᵉ fois | 2ᵉ fois |
   |---|---|---|
   | Federated credential scenario | GitHub actions deploying Azure resources | idem |
   | Organization | `BranchBrace` | `BranchBrace` |
   | Repository | `branchbrace` | `branchbrace` |
   | Entity type | **Branch** | **Branch** |
   | GitHub branch name | `rc` | `main` |
   | Name | `github-rc` | `github-main` |

   Vérifier que **Subject identifier** vaut bien
   `repo:BranchBrace/branchbrace:ref:refs/heads/rc` (puis `…/main`). Une faute ici ne
   produit aucune erreur à la création : la connexion échouera seulement au moment de la release.

## 7. Autoriser l'application à signer

Une fois le profil de l'étape 5 créé :

1. Portail Azure → compte Artifact Signing → **Certificate profiles** → ouvrir le profil.
2. **Access control (IAM)** → **Add role assignment**.
3. Rôle **Artifact Signing Certificate Profile Signer** → **Select members** → rechercher
   `branchbrace-github-signing` → **Review + assign**.

## 8. Variables du dépôt GitHub

Sur GitHub : dépôt `BranchBrace/branchbrace` → **Settings** → **Secrets and variables** →
**Actions** → onglet **Variables** → **New repository variable**. Ce ne sont pas des secrets.

| Variable | Valeur |
|---|---|
| `WINDOWS_SIGNING_ENDPOINT` | endpoint de la région de l'étape 3, ex. `neu.codesigning.azure.net` |
| `WINDOWS_SIGNING_ALIAS` | `<nom du compte>/<nom du profil>`, ex. `branchbrace/branchbrace-release` |
| `WINDOWS_SIGNING_PUBLISHER` | le CN noté à l'étape 4b, sans `CN=` |
| `AZURE_TENANT_ID` | noté à l'étape 6 |
| `AZURE_CLIENT_ID` | noté à l'étape 6 |

**Ajouter `WINDOWS_SIGNING_ENDPOINT` en dernier.** C'est elle qui active la signature : dès
qu'elle existe, une release non signée fait échouer la CI.

Les variables peuvent aussi être créées en ligne de commande :

```bash
gh variable set WINDOWS_SIGNING_ENDPOINT -R BranchBrace/branchbrace --body "neu.codesigning.azure.net"
```

## 9. Vérifier

1. Fusionner une PR dans `rc` avec un commit `feat` ou `fix` pour déclencher une release.
2. Dans le log du job `release`, l'étape « Azure login for Artifact Signing (OIDC) » doit
   réussir, et le packaging doit afficher `signing with jsign (TRUSTEDSIGNING)` pour chaque
   binaire.
3. Sur un poste Windows, télécharger l'installateur → clic droit → **Propriétés** → onglet
   **Signatures numériques** : l'éditeur doit être celui de l'étape 4b.

L'écran SmartScreen peut encore s'afficher sur les premières versions signées, avec le nom de
l'éditeur ; il disparaît à mesure que le certificat gagne en réputation.

## En cas d'échec

| Symptôme dans la CI | Cause probable |
|---|---|
| `AADSTS700213` / « no matching federated identity record » | Subject de l'étape 6 mal saisi, ou release lancée depuis une autre branche |
| `403` pendant la signature | Rôle de l'étape 7 manquant ou attribué à une autre application — ou propagation pas encore faite (attendre quelques minutes) |
| `WRONG PUBLISHER` | `WINDOWS_SIGNING_PUBLISHER` différent du CN réel du certificat |
| `404` / profil introuvable | `WINDOWS_SIGNING_ALIAS` ou région de l'endpoint incorrects |

## Sources

- https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles
- https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust
