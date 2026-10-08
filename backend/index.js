/* =====================================================
   AFRILOVA - Backend (Appwrite Function)
   Fichier : backend/index.js
   ===================================================== */

import { Client, Databases, ID, Query } from "node-appwrite";

/* ---------- Connexion Appwrite (clé API côté serveur) ---------- */
const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);

/* ---------- Identifiants des tables ---------- */
const DATABASE_ID =
  process.env.APPWRITE_DATABASE_ID || "6aac2a200000e6be5877";

const TABLE_PROFILS = "6aac2b35002a0debbb85";
const TABLE_POINTS = "points";
const TABLE_DEMANDES = "demandes";
const TABLE_CONVERSATIONS = "conversations";
const TABLE_MESSAGES = "messages";

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
   POINT D'ENTRÉE DE LA FONCTION
   ===================================================== */

export default async ({ req, res, log, error }) => {
  try {
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
