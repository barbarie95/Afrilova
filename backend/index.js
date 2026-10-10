/* =====================================================
   AFRILOVA - Backend (Appwrite Function)
   Fichier : backend/index.js
   ===================================================== */

import { Client, Databases, Users, Teams, Storage, ID, Query } from "node-appwrite";

/* ---------- Connexion Appwrite ---------- */
// Adresse et projet fournis automatiquement par Appwrite à la fonction.
// La clé API est ajoutée plus bas, à chaque exécution (voir le point d'entrée).
const client = new Client()
  .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
  .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID);

const databases = new Databases(client);
const users = new Users(client);
const teams = new Teams(client);
const storage = new Storage(client);

/* ---------- Identifiants des tables ---------- */
const DATABASE_ID =
  process.env.APPWRITE_DATABASE_ID || "6aac2a200000e6be5877";

const TABLE_PROFILS = "6aac2b35002a0debbb85";
const TABLE_POINTS = "points";
const TABLE_DEMANDES = "demandes";
const TABLE_CONVERSATIONS = "conversations";
const TABLE_MESSAGES = "messages";
const TABLE_SIGNALEMENTS = "signalements";
const TABLE_BLOCAGES = "blocages";
const TABLE_JOURNAL = "journal_admin";
const TABLE_PAYS = "pays";

// Équipe Appwrite des administrateurs
const ADMIN_TEAM_ID = "6aacffe749b1978e61bf";

// Dossier des photos (profils et messagerie)
const BUCKET_PHOTOS = "6aad2a754e0e095d6a9a";

/* ---------- Configuration Gemini (IA) ---------- */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

/* ---------- Utilitaires ---------- */

// Récupère l'identifiant de l'utilisateur connecté (envoyé par Appwrite)
function getUserId(req) {
  return (
    req.headers?.["x-appwrite-user-id"] ||
    req.headers?.["X-Appwrite-User-Id"] ||
    null
  );
}

// Nettoie un texte : le convertit en chaîne, retire les espaces, limite la longueur
function cleanText(value, max = 5000) {
  return String(value ?? "").trim().slice(0, max);
}

// Appelle Gemini avec le modèle configuré et renvoie la réponse
async function appelerGemini(corps) {
  return fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" +
      GEMINI_MODEL +
      ":generateContent?key=" +
      encodeURIComponent(GEMINI_API_KEY),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(corps),
    }
  );
}

/* =====================================================
   POINTS
   ===================================================== */

// Lit le compte de points d'un utilisateur (ou null s'il n'existe pas)
async function getPoints(userId) {
  const result = await databases.listDocuments(
    DATABASE_ID,
    TABLE_POINTS,
    [
      Query.equal("userId", userId),
      Query.limit(1),
    ]
  );

  return result.documents[0] || null;
}

// Ajoute des points (crée le compte s'il n'existe pas encore)
async function addPoints(userId, amount) {
  amount = Number(amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Nombre de points invalide.");
  }

  const points = await getPoints(userId);

  if (!points) {
    try {
      return await databases.createDocument(
        DATABASE_ID,
        TABLE_POINTS,
        ID.unique(),
        {
          userId,
          solde: amount,
          dateModification: new Date().toISOString(),
        }
      );
    } catch (error) {
      // Si un autre appel a créé le compte entre-temps, on ajoute dessus
      const nouveau = await getPoints(userId);

      if (!nouveau) {
        throw error;
      }

      return databases.updateDocument(
        DATABASE_ID,
        TABLE_POINTS,
        nouveau.$id,
        {
          solde: Number(nouveau.solde || 0) + amount,
          dateModification: new Date().toISOString(),
        }
      );
    }
  }

  return databases.updateDocument(
    DATABASE_ID,
    TABLE_POINTS,
    points.$id,
    {
      solde: Number(points.solde || 0) + amount,
      dateModification: new Date().toISOString(),
    }
  );
}

// Retire des points (refuse si le solde est insuffisant)
async function removePoints(userId, amount) {
  const points = await getPoints(userId);

  if (!points) {
    throw new Error("Compte de points introuvable.");
  }

  const solde = Number(points.solde || 0);

  if (solde < amount) {
    throw new Error("Solde de points insuffisant.");
  }

  return databases.updateDocument(
    DATABASE_ID,
    TABLE_POINTS,
    points.$id,
    {
      solde: solde - amount,
      dateModification: new Date().toISOString(),
    }
  );
}

/* =====================================================
   CONVERSATIONS ET MESSAGES
   ===================================================== */

// Crée une conversation entre deux utilisateurs (ou renvoie l'existante)
async function creerConversation(userId, peerId) {
  const existantes = await databases.listDocuments(
    DATABASE_ID,
    TABLE_CONVERSATIONS,
    [
      Query.equal("utilisateur1Id", userId),
      Query.equal("utilisateur2Id", peerId),
      Query.limit(1),
    ]
  );

  if (existantes.documents.length) {
    return existantes.documents[0];
  }

  const inverses = await databases.listDocuments(
    DATABASE_ID,
    TABLE_CONVERSATIONS,
    [
      Query.equal("utilisateur1Id", peerId),
      Query.equal("utilisateur2Id", userId),
      Query.limit(1),
    ]
  );

  if (inverses.documents.length) {
    return inverses.documents[0];
  }

  return databases.createDocument(
    DATABASE_ID,
    TABLE_CONVERSATIONS,
    ID.unique(),
    {
      utilisateur1Id: userId,
      utilisateur2Id: peerId,
      dateCreation: new Date().toISOString(),
      statut: "active",
    }
  );
}

// Enregistre un message (texte et/ou photo) dans une conversation
async function envoyerMessage(userId, data) {
  const {
    conversationId,
    peerId,
    contenu = "",
    photoId = null,
  } = data;

  if (!conversationId || !peerId) {
    throw new Error("Conversation invalide.");
  }

  // cleanText évite une erreur si "contenu" n'est pas un texte
  const texte = cleanText(contenu);

  if (!texte && !photoId) {
    throw new Error("Message vide.");
  }

  return databases.createDocument(
    DATABASE_ID,
    TABLE_MESSAGES,
    ID.unique(),
    {
      conversationId,
      expediteurId: userId,
      contenu: texte,
      photoId,
      dateEnvoi: new Date().toISOString(),
    }
  );
}

/* =====================================================
   DEMANDES DE DISCUSSION
   ===================================================== */

// Envoie une demande de discussion (coûte 1 point à l'expéditeur)
async function envoyerDemande(userId, data) {
  const destinataireId = data.destinataireId;

  if (!destinataireId) {
    throw new Error("Destinataire manquant.");
  }

  if (destinataireId === userId) {
    throw new Error("Impossible de s'envoyer une demande à soi-même.");
  }

  const demandesExistantes = await databases.listDocuments(
    DATABASE_ID,
    TABLE_DEMANDES,
    [
      Query.equal("expediteurId", userId),
      Query.equal("destinataireId", destinataireId),
      Query.equal("statut", "en_attente"),
      Query.limit(1),
    ]
  );

  if (demandesExistantes.documents.length) {
    throw new Error("Une demande est déjà en attente.");
  }

  const COUT_DEMANDE = 1;

  await removePoints(userId, COUT_DEMANDE);

  try {
    const demande = await databases.createDocument(
      DATABASE_ID,
      TABLE_DEMANDES,
      ID.unique(),
      {
        expediteurId: userId,
        destinataireId,
        statut: "en_attente",
        pointsDepenses: COUT_DEMANDE,
        dateCreation: new Date().toISOString(),
        prioritaire: Boolean(data.prioritaire || false),
      }
    );

    return demande;
  } catch (error) {
    // Remboursement si la création de la demande échoue
    await addPoints(userId, COUT_DEMANDE);
    throw error;
  }
}

// Refuse une demande (le point est rendu à l'expéditeur)
async function refuserDemande(userId, data) {
  const demandeId = data.demandeId;

  if (!demandeId) {
    throw new Error("Demande introuvable.");
  }

  const demande = await databases.getDocument(
    DATABASE_ID,
    TABLE_DEMANDES,
    demandeId
  );

  if (demande.destinataireId !== userId) {
    throw new Error("Action non autorisée.");
  }

  if (demande.statut !== "en_attente") {
    throw new Error("Cette demande n'est plus en attente.");
  }

  const demandeMiseAJour = await databases.updateDocument(
    DATABASE_ID,
    TABLE_DEMANDES,
    demandeId,
    {
      statut: "refusee",
      dateReponse: new Date().toISOString(),
    }
  );

  if (Number(demande.pointsDepenses || 0) > 0) {
    await addPoints(
      demande.expediteurId,
      Number(demande.pointsDepenses)
    );
  }

  return demandeMiseAJour;
}

// Expire les demandes en attente depuis 7 jours (le point est rendu)
async function expirerDemandes() {
  const demandes = await databases.listDocuments(
    DATABASE_ID,
    TABLE_DEMANDES,
    [
      Query.equal("statut", "en_attente"),
      Query.limit(100),
    ]
  );

  let expirees = 0;

  for (const demande of demandes.documents) {
    const dateCreation = new Date(demande.dateCreation);
    const maintenant = new Date();

    const difference =
      maintenant.getTime() - dateCreation.getTime();

    // Règle : expiration après 7 jours
    const SEPT_JOURS = 7 * 24 * 60 * 60 * 1000;

    if (difference >= SEPT_JOURS) {
      await databases.updateDocument(
        DATABASE_ID,
        TABLE_DEMANDES,
        demande.$id,
        {
          statut: "expiree",
          dateReponse: maintenant.toISOString(),
        }
      );

      if (Number(demande.pointsDepenses || 0) > 0) {
        await addPoints(
          demande.expediteurId,
          Number(demande.pointsDepenses)
        );
      }

      expirees++;
    }
  }

  return { expirees };
}

/* =====================================================
   POINT OFFERT À LA CRÉATION DU PROFIL
   ===================================================== */

// Offre 1 point (une seule fois : si le compte existe, rien n'est ajouté)
async function creditPointInscription(userId) {
  const pointsExistants = await getPoints(userId);

  if (pointsExistants) {
    return pointsExistants;
  }

  return databases.createDocument(
    DATABASE_ID,
    TABLE_POINTS,
    ID.unique(),
    {
      userId,
      solde: 1,
      dateModification: new Date().toISOString(),
    }
  );
}

/* =====================================================
   IA (GEMINI)
   ===================================================== */

// Aide à la discussion : 3 suggestions de réponses (coûte 1 point)
async function aideDiscussion(userId, data) {
  const question = cleanText(data.question);

  if (!question) {
    throw new Error("Question manquante.");
  }

  const COUT_AIDE = 1;

  // Le point est retiré AVANT l'appel à l'IA
  await removePoints(userId, COUT_AIDE);

  try {
    if (!GEMINI_API_KEY) {
      throw new Error("Clé Gemini absente.");
    }

    const prompt = `
Tu aides un utilisateur d'une plateforme de rencontre
sérieuse à poursuivre naturellement une conversation.

Donne exactement 3 suggestions de réponses.
Elles doivent être naturelles, respectueuses et adaptées
à une conversation amoureuse.

Question/contexte de l'utilisateur :
${question}

Retourne uniquement un JSON valide sous cette forme :
{
  "suggestions": [
    "Suggestion 1",
    "Suggestion 2",
    "Suggestion 3"
  ]
}
`;

    const response = await appelerGemini({
      contents: [
        {
          parts: [
            {
              text: prompt,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.8,
      },
    });

    if (!response.ok) {
      throw new Error("Gemini indisponible.");
    }

    const resultat = await response.json();

    const texte =
      resultat?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    const propre = texte
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    const jsonGemini = JSON.parse(propre);

    if (
      !Array.isArray(jsonGemini.suggestions) ||
      !jsonGemini.suggestions.length
    ) {
      throw new Error("Aucune suggestion générée.");
    }

    return {
      suggestions: jsonGemini.suggestions.slice(0, 3),
    };
  } catch (error) {
    // Remboursement si Gemini échoue
    await addPoints(userId, COUT_AIDE);

    throw error;
  }
}

// Analyse de compatibilité entre deux profils (coûte 1 point)
async function analyserCompatibilite(userId, data) {
  const profilId = data.profilId;

  if (!profilId) {
    throw new Error("Profil manquant.");
  }

  const COUT_ANALYSE = 1;

  await removePoints(userId, COUT_ANALYSE);

  try {
    if (!GEMINI_API_KEY) {
      throw new Error("Clé Gemini absente.");
    }

    const profil = await databases.getDocument(
      DATABASE_ID,
      TABLE_PROFILS,
      profilId
    );

    const profilUtilisateur = await databases.listDocuments(
      DATABASE_ID,
      TABLE_PROFILS,
      [
        Query.equal("userId", userId),
        Query.limit(1),
      ]
    );

    if (!profilUtilisateur.documents.length) {
      throw new Error("Votre profil est introuvable.");
    }

    const mien = profilUtilisateur.documents[0];

    const prompt = `
Analyse la compatibilité amoureuse entre deux profils
d'une plateforme de rencontre sérieuse.

Profil A :
Nom : ${mien.nom || ""}
Âge : ${mien.age || ""}
Recherche : ${mien.recherche || ""}
Description : ${mien.description || ""}
Enfants : ${mien.aDesEnfants}
Polygamie : ${mien.polygamie || ""}
Type de relation : ${mien.typeRelation || ""}

Profil B :
Nom : ${profil.nom || ""}
Âge : ${profil.age || ""}
Recherche : ${profil.recherche || ""}
Description : ${profil.description || ""}
Enfants : ${profil.aDesEnfants}
Polygamie : ${profil.polygamie || ""}
Type de relation : ${profil.typeRelation || ""}

Donne une analyse courte, respectueuse et réaliste.
Ne présente jamais la compatibilité comme une certitude.
`;

    const response = await appelerGemini({
      contents: [
        {
          parts: [
            {
              text: prompt,
            },
          ],
        },
      ],
    });

    if (!response.ok) {
      throw new Error("Analyse indisponible.");
    }

    const resultat = await response.json();

    const analyse =
      resultat?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!analyse.trim()) {
      throw new Error("Analyse vide.");
    }

    return {
      analyse: analyse.trim(),
    };
  } catch (error) {
    // Remboursement si l'analyse échoue
    await addPoints(userId, COUT_ANALYSE);
    throw error;
  }
}

/* =====================================================
   ESPACE ADMINISTRATEUR (lecture seule)
   ===================================================== */

// Vérifie que l'utilisateur est membre confirmé de l'équipe "Administrateurs"
// Renvoie "super" (rôle owner) ou "associe" (autres membres)
async function verifierAdmin(userId) {
  const adhesions = await teams.listMemberships(
    ADMIN_TEAM_ID,
    [
      Query.equal("userId", userId),
      Query.limit(1),
    ]
  );

  const adhesion = adhesions.memberships?.[0];

  if (!adhesion || !adhesion.confirm) {
    throw new Error("Accès réservé aux administrateurs.");
  }

  return adhesion.roles.includes("owner") ? "super" : "associe";
}

// Renvoie le total d'une requête, ou null si elle échoue
// (une statistique indisponible ne bloque pas les autres)
async function totalOuNull(requete) {
  try {
    const resultat = await requete;
    return resultat.total;
  } catch (e) {
    return null;
  }
}

// Compte les documents d'une table (on ne lit qu'un document, seul le total compte)
function compterDocs(table, requetes = []) {
  return databases.listDocuments(
    DATABASE_ID,
    table,
    [...requetes, Query.limit(1)]
  );
}

// Compte les utilisateurs Appwrite
function compterUsers(requetes = []) {
  return users.list([...requetes, Query.limit(1)]);
}

// Statistiques du tableau de bord (réservé aux administrateurs)
async function adminStats(userId) {
  const role = await verifierAdmin(userId);

  const JOUR = 24 * 60 * 60 * 1000;
  const maintenant = Date.now();

  // Date d'il y a "nb" jours, au format ISO
  const depuis = (nb) =>
    new Date(maintenant - nb * JOUR).toISOString();

  // Début de la journée en cours
  const debutJour = new Date();
  debutJour.setUTCHours(0, 0, 0, 0);
  const aujourdhui = debutJour.toISOString();

  // Toutes les requêtes partent en même temps pour aller vite
  const taches = {
    utilisateursTotal: totalOuNull(compterUsers()),
    utilisateursActifs24h: totalOuNull(
      compterUsers([Query.greaterThan("accessedAt", depuis(1))])
    ),
    nouveauxAujourdhui: totalOuNull(
      compterUsers([Query.greaterThan("registration", aujourdhui)])
    ),
    nouveaux7j: totalOuNull(
      compterUsers([Query.greaterThan("registration", depuis(7))])
    ),
    nouveaux7jPrecedents: totalOuNull(
      compterUsers([
        Query.greaterThan("registration", depuis(14)),
        Query.lessThanEqual("registration", depuis(7)),
      ])
    ),
    nouveaux30j: totalOuNull(
      compterUsers([Query.greaterThan("registration", depuis(30))])
    ),

    profilsTotal: totalOuNull(compterDocs(TABLE_PROFILS)),
    profilsEnAttente: totalOuNull(
      compterDocs(TABLE_PROFILS, [Query.equal("statut", "en_attente")])
    ),
    profilsApprouves: totalOuNull(
      compterDocs(TABLE_PROFILS, [Query.equal("statut", "approuve")])
    ),
    profilsRefuses: totalOuNull(
      compterDocs(TABLE_PROFILS, [Query.equal("statut", "refuse")])
    ),

    demandesTotal: totalOuNull(compterDocs(TABLE_DEMANDES)),
    demandes7j: totalOuNull(
      compterDocs(TABLE_DEMANDES, [
        Query.greaterThan("$createdAt", depuis(7)),
      ])
    ),
    demandes7jPrecedents: totalOuNull(
      compterDocs(TABLE_DEMANDES, [
        Query.greaterThan("$createdAt", depuis(14)),
        Query.lessThanEqual("$createdAt", depuis(7)),
      ])
    ),

    conversationsTotal: totalOuNull(compterDocs(TABLE_CONVERSATIONS)),
    conversations7j: totalOuNull(
      compterDocs(TABLE_CONVERSATIONS, [
        Query.greaterThan("$createdAt", depuis(7)),
      ])
    ),
    conversations7jPrecedentes: totalOuNull(
      compterDocs(TABLE_CONVERSATIONS, [
        Query.greaterThan("$createdAt", depuis(14)),
        Query.lessThanEqual("$createdAt", depuis(7)),
      ])
    ),

    messagesTotal: totalOuNull(compterDocs(TABLE_MESSAGES)),
    messages7j: totalOuNull(
      compterDocs(TABLE_MESSAGES, [
        Query.greaterThan("$createdAt", depuis(7)),
      ])
    ),
    messages7jPrecedents: totalOuNull(
      compterDocs(TABLE_MESSAGES, [
        Query.greaterThan("$createdAt", depuis(14)),
        Query.lessThanEqual("$createdAt", depuis(7)),
      ])
    ),

    signalementsEnAttente: totalOuNull(
      compterDocs(TABLE_SIGNALEMENTS, [Query.equal("statut", "en_attente")])
    ),
    blocagesTotal: totalOuNull(compterDocs(TABLE_BLOCAGES)),
  };

  // On attend toutes les réponses puis on reconstruit l'objet
  const cles = Object.keys(taches);
  const valeurs = await Promise.all(Object.values(taches));

  const stats = {};
  cles.forEach((cle, i) => {
    stats[cle] = valeurs[i];
  });

  return { role, stats };
                            }
/* =====================================================
   ESPACE ADMINISTRATEUR : POUVOIRS DU SUPER ADMIN,
   JOURNAL ET DIAGRAMMES
   ===================================================== */

// Réservé au super administrateur (rôle owner)
async function verifierSuper(userId) {
  const role = await verifierAdmin(userId);

  if (role !== "super") {
    throw new Error("Action réservée au super administrateur.");
  }

  return role;
}

// Enregistre une action dans le journal (adresse email de l'admin incluse)
async function ecrireJournal(userId, action, cibleId, details) {
  const admin = await users.get(userId);

  return databases.createDocument(
    DATABASE_ID,
    TABLE_JOURNAL,
    ID.unique(),
    {
      adminId: userId,
      adminEmail: admin.email,
      action: cleanText(action, 50),
      cibleId: cibleId || null,
      details: cleanText(details, 500),
      date: new Date().toISOString(),
    }
  );
}

// Ajoute des points à n'importe quel utilisateur (super admin seulement)
// "cibleId" = identifiant de l'utilisateur (userId du profil)
async function adminAjouterPoints(userId, data) {
  await verifierSuper(userId);

  const cibleId = cleanText(data.cibleId, 36);
  const montant = Number(data.montant);

  if (!cibleId) {
    throw new Error("Profil manquant.");
  }

  // Limite de sécurité : entier entre 1 et 1000 par opération
  if (!Number.isInteger(montant) || montant < 1 || montant > 1000) {
    throw new Error("Le nombre de points doit être entre 1 et 1000.");
  }

  // Vérifie que l'utilisateur existe
  await users.get(cibleId);

  const points = await addPoints(cibleId, montant);

  // Pas de trace = pas d'ajout : si le journal échoue, on annule
  try {
    await ecrireJournal(
      userId,
      "points_ajoutes",
      cibleId,
      "+" + montant + " point(s)"
    );
  } catch (e) {
    await removePoints(cibleId, montant);
    throw new Error("Journal indisponible : ajout annulé.");
  }

  return { points };
}

// Lit le journal (super admin seulement, du plus récent au plus ancien)
async function adminJournal(userId, data) {
  await verifierSuper(userId);

  const limite = Math.min(Number(data.limite) || 50, 100);
  const decalage = Math.max(Number(data.decalage) || 0, 0);

  const resultat = await databases.listDocuments(
    DATABASE_ID,
    TABLE_JOURNAL,
    [
      Query.orderDesc("$createdAt"),
      Query.limit(limite),
      Query.offset(decalage),
    ]
  );

  return {
    total: resultat.total,
    journal: resultat.documents.map((d) => ({
      id: d.$id,
      adminEmail: d.adminEmail,
      action: d.action,
      cibleId: d.cibleId,
      details: d.details,
      date: d.date,
    })),
  };
}

// Données des diagrammes : inscriptions des 6 derniers mois + pays
async function adminGraphiques(userId) {
  await verifierAdmin(userId);

  // Inscriptions : 6 mois, du plus ancien au mois en cours
  const mois = [];
  const maintenant = new Date();

  for (let i = 5; i >= 0; i--) {
    const debut = new Date(
      Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth() - i, 1)
    );
    const fin = new Date(
      Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth() - i + 1, 1)
    );

    mois.push({
      mois: debut.toISOString().slice(0, 7),
      total: await totalOuNull(
        compterUsers([
          Query.greaterThanEqual("registration", debut.toISOString()),
          Query.lessThan("registration", fin.toISOString()),
        ])
      ),
    });
  }

  // Répartition des profils par pays
  let pays = [];

  try {
    const liste = await databases.listDocuments(
      DATABASE_ID,
      TABLE_PAYS,
      [Query.limit(50)]
    );

    pays = await Promise.all(
      liste.documents.map(async (p) => ({
        nom: p.nom,
        total: await totalOuNull(
          compterDocs(TABLE_PROFILS, [Query.equal("paysId", p.$id)])
        ),
      }))
    );
  } catch (e) {
    pays = [];
  }

  return { inscriptionsParMois: mois, profilsParPays: pays };
}

/* =====================================================
   MODÉRATION : SIGNALEMENTS, BLOCAGES, SUSPENSION,
   SUPPRESSION (tous les administrateurs)
   ===================================================== */

// Lit le profil d'un utilisateur (ou null s'il n'existe pas)
async function getProfilParUserId(userId) {
  const resultat = await databases.listDocuments(
    DATABASE_ID,
    TABLE_PROFILS,
    [
      Query.equal("userId", userId),
      Query.limit(1),
    ]
  );

  return resultat.documents[0] || null;
}

// Lit une table par pages de 100 (jusqu'à "max" lignes), du plus récent au plus ancien
async function listerTout(table, max = 500) {
  const lignes = [];

  while (lignes.length < max) {
    const page = await databases.listDocuments(
      DATABASE_ID,
      table,
      [
        Query.orderDesc("$createdAt"),
        Query.limit(100),
        Query.offset(lignes.length),
      ]
    );

    lignes.push(...page.documents);

    if (page.documents.length < 100) {
      break;
    }
  }

  return lignes;
}

// Refuse de viser soi-même ou un membre de l'équipe des administrateurs
async function verifierCibleModerable(userId, cibleId) {
  if (!cibleId) {
    throw new Error("Profil manquant.");
  }

  if (cibleId === userId) {
    throw new Error("Impossible de viser son propre compte.");
  }

  const adhesions = await teams.listMemberships(
    ADMIN_TEAM_ID,
    [
      Query.equal("userId", cibleId),
      Query.limit(1),
    ]
  );

  if (adhesions.memberships?.length) {
    throw new Error("Impossible de viser un administrateur.");
  }
}

// Profils classés par signalements puis par blocages reçus
async function adminModeration(userId) {
  await verifierAdmin(userId);

  const [signalements, blocages] = await Promise.all([
    listerTout(TABLE_SIGNALEMENTS),
    listerTout(TABLE_BLOCAGES),
  ]);

  const parProfil = {};

  const entree = (id) => {
    if (!parProfil[id]) {
      parProfil[id] = { userId: id, signalements: 0, blocages: 0, motifs: {} };
    }
    return parProfil[id];
  };

  signalements.forEach((s) => {
    if (!s.signaleId) return;
    const e = entree(s.signaleId);
    e.signalements++;
    e.motifs[s.motif] = (e.motifs[s.motif] || 0) + 1;
  });

  blocages.forEach((b) => {
    if (!b.bloqueId) return;
    entree(b.bloqueId).blocages++;
  });

  // Les 50 profils les plus signalés (puis les plus bloqués)
  const classes = Object.values(parProfil)
    .sort((a, b) => b.signalements - a.signalements || b.blocages - a.blocages)
    .slice(0, 50);

  let profils = [];

  if (classes.length) {
    const lecture = await databases.listDocuments(
      DATABASE_ID,
      TABLE_PROFILS,
      [
        Query.equal("userId", classes.map((c) => c.userId)),
        Query.limit(100),
      ]
    );
    profils = lecture.documents;
  }

  return {
    totaux: {
      signalements: signalements.length,
      blocages: blocages.length,
    },
    profils: classes.map((c) => {
      const p = profils.find((x) => x.userId === c.userId);
      return {
        ...c,
        nom: p ? p.nom : null,
        age: p ? p.age : null,
        statut: p ? p.statut : null,
      };
    }),
  };
}

// Suspend un compte : connexion impossible + profil "suspendu" (réversible)
async function adminSuspendre(userId, data) {
  await verifierAdmin(userId);

  const cibleId = cleanText(data.cibleId, 36);
  const motif = cleanText(data.motif, 200);

  await verifierCibleModerable(userId, cibleId);

  if (motif.length < 3) {
    throw new Error("Un motif est obligatoire.");
  }

  const profil = await getProfilParUserId(cibleId);
  const statutAvant = profil ? profil.statut : null;

  await users.updateStatus(cibleId, false);

  if (profil) {
    try {
      await databases.updateDocument(
        DATABASE_ID,
        TABLE_PROFILS,
        profil.$id,
        { statut: "suspendu" }
      );
    } catch (e) {
      await users.updateStatus(cibleId, true);
      throw e;
    }
  }

  // Pas de trace = pas de suspension : si le journal échoue, on annule
  try {
    await ecrireJournal(
      userId,
      "compte_suspendu",
      cibleId,
      "nom: " + (profil ? profil.nom : "?") + " | motif: " + motif
    );
  } catch (e) {
    await users.updateStatus(cibleId, true);

    if (profil) {
      await databases.updateDocument(
        DATABASE_ID,
        TABLE_PROFILS,
        profil.$id,
        { statut: statutAvant }
      );
    }

    throw new Error("Journal indisponible : suspension annulée.");
  }

  // Ferme les sessions déjà ouvertes (sans bloquer si ça échoue)
  try {
    await users.deleteSessions(cibleId);
  } catch (e) {}

  return { suspendu: true };
}

// Réactive un compte suspendu : connexion rétablie, profil remis à "approuve"
async function adminReactiver(userId, data) {
  await verifierAdmin(userId);

  const cibleId = cleanText(data.cibleId, 36);

  await verifierCibleModerable(userId, cibleId);

  const profil = await getProfilParUserId(cibleId);
  const etaitSuspendu = Boolean(profil && profil.statut === "suspendu");

  await users.updateStatus(cibleId, true);

  if (etaitSuspendu) {
    try {
      await databases.updateDocument(
        DATABASE_ID,
        TABLE_PROFILS,
        profil.$id,
        { statut: "approuve" }
      );
    } catch (e) {
      await users.updateStatus(cibleId, false);
      throw e;
    }
  }

  try {
    await ecrireJournal(
      userId,
      "compte_reactive",
      cibleId,
      "nom: " + (profil ? profil.nom : "?")
    );
  } catch (e) {
    await users.updateStatus(cibleId, false);

    if (etaitSuspendu) {
      await databases.updateDocument(
        DATABASE_ID,
        TABLE_PROFILS,
        profil.$id,
        { statut: "suspendu" }
      );
    }

    throw new Error("Journal indisponible : réactivation annulée.");
  }

  return { reactive: true };
}

// Supprime définitivement un compte (seulement s'il est déjà suspendu)
async function adminSupprimer(userId, data) {
  await verifierAdmin(userId);

  const cibleId = cleanText(data.cibleId, 36);
  const motif = cleanText(data.motif, 200);

  await verifierCibleModerable(userId, cibleId);

  if (motif.length < 3) {
    throw new Error("Un motif est obligatoire.");
  }

  const compte = await users.get(cibleId);
  const profil = await getProfilParUserId(cibleId);

  // Garde-fou : on ne supprime qu'après une suspension
  if (compte.status !== false || (profil && profil.statut !== "suspendu")) {
    throw new Error("Suspends d'abord ce compte avant de le supprimer.");
  }

  // La trace est écrite AVANT : la suppression est irréversible
  try {
    await ecrireJournal(
      userId,
      "compte_supprime",
      cibleId,
      "nom: " + (profil ? profil.nom : "?") + " | motif: " + motif
    );
  } catch (e) {
    throw new Error("Journal indisponible : suppression annulée.");
  }

  // Photos du profil (une photo déjà absente ne bloque pas)
  const photos = [
    profil ? profil.photoPrincipale : null,
    profil ? profil.photoOriginaleId : null,
  ];

  for (const fichierId of photos) {
    if (!fichierId) continue;

    try {
      await storage.deleteFile(BUCKET_PHOTOS, fichierId);
    } catch (e) {}
  }

  // Points
  const points = await getPoints(cibleId);

  if (points) {
    await databases.deleteDocument(DATABASE_ID, TABLE_POINTS, points.$id);
  }

  // Profil puis compte
  if (profil) {
    await databases.deleteDocument(DATABASE_ID, TABLE_PROFILS, profil.$id);
  }

  await users.delete(cibleId);

  return { supprime: true };
}

// Appareils actuellement connectés sur les comptes administrateurs (super admin seulement)
async function adminConnexions(userId) {
  await verifierSuper(userId);

  const adhesions = await teams.listMemberships(
    ADMIN_TEAM_ID,
    [Query.limit(25)]
  );

  const connexions = [];

  for (const adhesion of adhesions.memberships || []) {
    try {
      const resultat = await users.listSessions(adhesion.userId);

      (resultat.sessions || []).forEach((s) => {
        connexions.push({
          adminEmail: adhesion.userEmail,
          date: s.$createdAt,
          ip: s.ip || "",
          pays: s.countryName || "",
          appareil: [s.osName, s.clientName].filter(Boolean).join(" · "),
        });
      });
    } catch (e) {}
  }

  connexions.sort((a, b) => new Date(b.date) - new Date(a.date));

  return { connexions: connexions.slice(0, 30) };
}

/* =====================================================
   POINT D'ENTRÉE DE LA FONCTION
   ===================================================== */

export default async ({ req, res, log, error }) => {
  try {
    // Clé dynamique fournie par Appwrite pour cette exécution
    // (elle n'expire pas et suit les droits de la fonction)
    const cleDynamique = req.headers?.["x-appwrite-key"];

    if (!cleDynamique) {
      throw new Error("Clé de la fonction absente.");
    }

    client.setKey(cleDynamique);

    const userId = getUserId(req);

    const donnees =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body || {};

    const action = donnees.action;

    if (!action) {
      return res.json(
        {
          ok: false,
          message: "Action manquante.",
        },
        400
      );
    }

    let resultat;

    switch (action) {
      case "test":
        resultat = {
          message: "Backend Afrilova opérationnel.",
        };
        break;

      case "creerConversation":
        if (!userId) {
          throw new Error("Utilisateur non connecté.");
        }

        resultat = {
          conversation: await creerConversation(
            userId,
            donnees.peerId
          ),
        };
        break;

      case "envoyerMessage":
        if (!userId) {
          throw new Error("Utilisateur non connecté.");
        }

        resultat = {
          message: await envoyerMessage(
            userId,
            donnees
          ),
        };
        break;

      case "envoyerDemande":
        if (!userId) {
          throw new Error("Utilisateur non connecté.");
        }

        resultat = {
          demande: await envoyerDemande(
            userId,
            donnees
          ),
        };
        break;

      case "refuserDemande":
        if (!userId) {
          throw new Error("Utilisateur non connecté.");
        }

        resultat = {
          demande: await refuserDemande(
            userId,
            donnees
          ),
        };
        break;

      case "expirerDemandes":
        resultat = await expirerDemandes();
        break;

      case "creditPointInscription":
        if (!userId) {
          throw new Error("Utilisateur non connecté.");
        }

        resultat = {
          points: await creditPointInscription(userId),
        };
        break;

      case "aideDiscussion":
        if (!userId) {
          throw new Error("Utilisateur non connecté.");
        }

        resultat = await aideDiscussion(
          userId,
          donnees
        );
        break;

      case "analyserCompatibilite":
        if (!userId) {
          throw new Error("Utilisateur non connecté.");
        }

        resultat = await analyserCompatibilite(
          userId,
          donnees
        );
        break;

      case "adminStats":
        if (!userId) {
          throw new Error("Utilisateur non connecté.");
        }

        resultat = await adminStats(userId);
        break;

      case "adminAjouterPoints":
        if (!userId) {
          throw new Error("Utilisateur non connecté.");
        }

        resultat = await adminAjouterPoints(
          userId,
          donnees
        );
        break;

      case "adminJournal":
        if (!userId) {
          throw new Error("Utilisateur non connecté.");
        }

        resultat = await adminJournal(
          userId,
          donnees
        );
        break;

      case "adminGraphiques":
        if (!userId) {
          throw new Error("Utilisateur non connecté.");
        }

        resultat = await adminGraphiques(userId);
        break;

      case "adminModeration":
        if (!userId) {
          throw new Error("Utilisateur non connecté.");
        }

        resultat = await adminModeration(userId);
        break;

      case "adminSuspendre":
        if (!userId) {
          throw new Error("Utilisateur non connecté.");
        }

        resultat = await adminSuspendre(
          userId,
          donnees
        );
        break;

      case "adminReactiver":
        if (!userId) {
          throw new Error("Utilisateur non connecté.");
        }

        resultat = await adminReactiver(
          userId,
          donnees
        );
        break;

      case "adminSupprimer":
        if (!userId) {
          throw new Error("Utilisateur non connecté.");
        }

        resultat = await adminSupprimer(
          userId,
          donnees
        );
        break;

      case "adminConnexions":
        if (!userId) {
          throw new Error("Utilisateur non connecté.");
        }

        resultat = await adminConnexions(userId);
        break;

      default:
        return res.json(
          {
            ok: false,
            message: "Action inconnue.",
          },
          400
        );
    }

    return res.json({
      ok: true,
      ...resultat,
    });
  } catch (e) {
    error(e?.message || e);

    return res.json(
      {
        ok: false,
        message:
          e?.message ||
          "Une erreur est survenue.",
      },
      400
    );
  }
};
