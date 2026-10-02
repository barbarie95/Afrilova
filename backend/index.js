import {
  Client,
  TablesDB,
  Storage,
  Permission,
  Role,
  Query,
  ID
} from "node-appwrite";

const DATABASE_ID = "6aac2a200000e6be5877";
const TABLE_PROFILS = "6aac2b35002a0debbb85";
const TABLE_CONVERSATIONS = "conversations";
const TABLE_MESSAGES = "messages";
const TABLE_DEMANDES = "demandes";
const TABLE_POINTS = "points";
const BUCKET_PHOTOS = "6aad2a754e0e095d6a9a";
const ADMIN_TEAM_ID = "6aacffe749b1978e61bf";

const GEMINI_MODEL = "gemini-3.8-flash";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const COUT_AIDE = 1;
const MAX_QUESTION = 1000;
const MAX_MESSAGES = 12;
const DELAI_REPONSE_JOURS = 7;

export default async ({ req, res, log, error }) => {

  const userId = req.headers["x-appwrite-user-id"];

  if (!userId) {
    return res.json({ ok: false, message: "Non authentifié." }, 401);
  }

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers["x-appwrite-key"]);

  const tablesDB = new TablesDB(client);
  const storage = new Storage(client);

  let payload;

  try {
    payload = JSON.parse(req.bodyRaw || "{}");
  } catch {
    return res.json({
      ok: false,
      message: "Requête invalide."
    }, 400);
  }

  const action = payload.action;

  const getPoints = async (id) => {
    const r = await tablesDB.listRows({
      databaseId: DATABASE_ID,
      tableId: TABLE_POINTS,
      queries: [
        Query.equal("userId", id),
        Query.limit(1)
      ]
    });

    return r.total ? r.rows[0] : null;
  };

  const addPoints = async (id, nombre) => {
    const ligne = await getPoints(id);
    if (!ligne) return;

    await tablesDB.updateRow({
      databaseId: DATABASE_ID,
      tableId: TABLE_POINTS,
      rowId: ligne.$id,
      data: {
        solde: Number(ligne.solde || 0) + nombre,
        dateModification: new Date().toISOString()
      }
    });
  };

  const removePoints = async (id, nombre) => {
    const ligne = await getPoints(id);

    if (!ligne || Number(ligne.solde || 0) < nombre) {
      return {
        ok: false,
        message: "Solde insuffisant. Achetez des points pour continuer."
      };
    }

    const nouveauSolde =
      Number(ligne.solde) - nombre;

    await tablesDB.updateRow({
      databaseId: DATABASE_ID,
      tableId: TABLE_POINTS,
      rowId: ligne.$id,
      data: {
        solde: nouveauSolde,
        dateModification: new Date().toISOString()
      }
    });

    return {
      ok: true,
      nouveauSolde
    };
  };
    const genererAide = async (question, conversationId) => {

    const cle = process.env.GEMINI_API_KEY;

    if (!cle) {
      throw new Error("Clé Gemini non configurée.");
    }

    let contexte = "";

    if (conversationId) {

      const conversation = await tablesDB.getRow({
        databaseId: DATABASE_ID,
        tableId: TABLE_CONVERSATIONS,
        rowId: conversationId
      });

      if (
        conversation.utilisateur1Id !== userId &&
        conversation.utilisateur2Id !== userId
      ) {
        throw new Error("Conversation non autorisée.");
      }

      const messages = await tablesDB.listRows({
        databaseId: DATABASE_ID,
        tableId: TABLE_MESSAGES,
        queries: [
          Query.equal("conversationId", conversationId),
          Query.orderDesc("dateEnvoi"),
          Query.limit(MAX_MESSAGES)
        ]
      });

      contexte = [...messages.rows]
        .reverse()
        .map(m => {
          const auteur =
            m.expediteurId === userId ? "Moi" : "Autre";
          const texte = String(m.contenu || "").trim();
          return texte ? `${auteur}: ${texte}` : "";
        })
        .filter(Boolean)
        .join("\n");
    }

    const prompt = `
Tu es l'assistant Aide à la discussion d'Affrilova.

L'utilisateur veut savoir quoi répondre à une personne
avec qui il discute.

Question :
${question}

Conversation récente :
${contexte || "Aucun historique disponible."}

Donne exactement 3 réponses courtes, naturelles,
respectueuses et différentes.

1. Une réponse naturelle.
2. Une réponse plus chaleureuse.
3. Une question permettant de continuer la conversation.

Ne sois pas insistant.
Ne manipule pas la personne.
Pas de contenu sexuel explicite.

Réponds uniquement en JSON :
{
  "suggestions": [
    "réponse 1",
    "réponse 2",
    "réponse 3"
  ]
}
`;

    const appel = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": cle
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt }
            ]
          }
        ],
        generationConfig: {
  responseMimeType: "application/json",
  maxOutputTokens: 400
        }
      })
    });

    if (!appel.ok) {
      log(`Erreur Gemini HTTP ${appel.status}`);
      throw new Error(
        "Le service d'aide est temporairement indisponible."
      );
    }

    const data = await appel.json();

    const texte =
      data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!texte) {
      throw new Error("Aucune réponse de Gemini.");
    }

    let resultat;

    try {
      resultat = JSON.parse(texte);
    } catch {
      throw new Error(
        "Réponse Gemini invalide."
      );
    }

    const suggestions =
      Array.isArray(resultat.suggestions)
        ? resultat.suggestions
            .map(x => String(x || "").trim())
            .filter(Boolean)
            .slice(0, 3)
        : [];

    if (suggestions.length !== 3) {
      throw new Error(
        "Gemini n'a pas fourni 3 suggestions."
      );
    }

    return suggestions;
  };


  try {

    if (action === "creerConversation") {

      const peerId = payload.peerId;

      if (!peerId) {
        return res.json({
          ok: false,
          message: "peerId manquant."
        }, 400);
      }

      const q1 = await tablesDB.listRows({
        databaseId: DATABASE_ID,
        tableId: TABLE_CONVERSATIONS,
        queries: [
          Query.equal("utilisateur1Id", userId),
          Query.equal("utilisateur2Id", peerId),
          Query.limit(1)
        ]
      });

      if (q1.total) {
        return res.json({
          ok: true,
          conversation: q1.rows[0]
        });
      }

      const q2 = await tablesDB.listRows({
        databaseId: DATABASE_ID,
        tableId: TABLE_CONVERSATIONS,
        queries: [
          Query.equal("utilisateur1Id", peerId),
          Query.equal("utilisateur2Id", userId),
          Query.limit(1)
        ]
      });

      if (q2.total) {
        return res.json({
          ok: true,
          conversation: q2.rows[0]
        });
      }

      const conversation =
        await tablesDB.createRow({
          databaseId: DATABASE_ID,
          tableId: TABLE_CONVERSATIONS,
          rowId: ID.unique(),
          data: {
            utilisateur1Id: userId,
            utilisateur2Id: peerId,
            dateCreation: new Date().toISOString(),
            statut: "active"
          },
          permissions: [
            Permission.read(Role.user(userId)),
            Permission.read(Role.user(peerId)),
            Permission.update(Role.user(userId)),
            Permission.update(Role.user(peerId)),
            Permission.read(Role.team(ADMIN_TEAM_ID))
          ]
        });

      return res.json({
        ok: true,
        conversation
      });
    }


    if (action === "envoyerMessage") {

      const {
        conversationId,
        peerId,
        contenu,
        photoId
      } = payload;

      if (!conversationId || !peerId) {
        return res.json({
          ok: false,
          message: "Paramètres manquants."
        }, 400);
      }

      if (photoId) {

        await storage.updateFile({
          bucketId: BUCKET_PHOTOS,
          fileId: photoId,
          permissions: [
            Permission.read(Role.user(userId)),
            Permission.read(Role.user(peerId))
          ]
        });

      }

      const message =
        await tablesDB.createRow({
          databaseId: DATABASE_ID,
          tableId: TABLE_MESSAGES,
          rowId: ID.unique(),
          data: {
            conversationId,
            expediteurId: userId,
            contenu: contenu || null,
            photoId: photoId || null,
            dateEnvoi: new Date().toISOString()
          },
          permissions: [
            Permission.read(Role.user(userId)),
            Permission.read(Role.user(peerId)),
            Permission.read(Role.team(ADMIN_TEAM_ID))
          ]
        });

      return res.json({
        ok: true,
        message
      });
    }


    if (action === "aideDiscussion") {

      const question =
        String(payload.question || "").trim();

      const conversationId =
        payload.conversationId || null;

      if (!question) {
        return res.json({
          ok: false,
          message: "Écris d'abord ta question."
        }, 400);
      }

      if (question.length > MAX_QUESTION) {
        return res.json({
          ok: false,
          message: "Ta question est trop longue."
        }, 400);
      }

      const debit =
        await removePoints(userId, COUT_AIDE);

      if (!debit.ok) {
        return res.json(debit, 400);
      }

      try {

        const suggestions =
          await genererAide(
            question,
            conversationId
          );

        return res.json({
          ok: true,
          suggestions,
          pointsDepenses: COUT_AIDE,
          nouveauSolde: debit.nouveauSolde
        });

      } catch (e) {

        await addPoints(
          userId,
          COUT_AIDE
        );

        throw e;
      }
  }
        if (action === "creditPointInscription") {

      const profils = await tablesDB.listRows({
        databaseId: DATABASE_ID,
        tableId: TABLE_PROFILS,
        queries: [
          Query.equal("userId", userId),
          Query.limit(1)
        ]
      });

      if (!profils.total) {
        return res.json({
          ok: false,
          message: "Créez d'abord votre profil."
        }, 400);
      }

      try {

        await tablesDB.createRow({
          databaseId: DATABASE_ID,
          tableId: TABLE_POINTS,
          rowId: userId,
          data: {
            userId,
            solde: 1,
            dateModification: new Date().toISOString()
          },
          permissions: [
            Permission.read(Role.user(userId)),
            Permission.read(Role.team(ADMIN_TEAM_ID))
          ]
        });

      } catch (e) {

        if (e.code === 409) {
          return res.json({
            ok: true,
            dejaCredite: true
          });
        }

        throw e;
      }

      return res.json({
        ok: true,
        dejaCredite: false,
        solde: 1
      });
    }


    if (action === "envoyerDemande") {

      const peerId = payload.peerId;

      if (!peerId) {
        return res.json({
          ok: false,
          message: "Destinataire manquant."
        }, 400);
      }

      if (peerId === userId) {
        return res.json({
          ok: false,
          message: "Vous ne pouvez pas vous envoyer une demande à vous-même."
        }, 400);
      }

      const dejaEnvoyee =
        await tablesDB.listRows({
          databaseId: DATABASE_ID,
          tableId: TABLE_DEMANDES,
          queries: [
            Query.equal("expediteurId", userId),
            Query.equal("destinataireId", peerId),
            Query.equal("statut", "en_attente"),
            Query.limit(1)
          ]
        });

      if (dejaEnvoyee.total) {
        return res.json({
          ok: false,
          message: "Une demande est déjà en attente avec cette personne."
        }, 400);
      }

      const dejaRecue =
        await tablesDB.listRows({
          databaseId: DATABASE_ID,
          tableId: TABLE_DEMANDES,
          queries: [
            Query.equal("expediteurId", peerId),
            Query.equal("destinataireId", userId),
            Query.equal("statut", "en_attente"),
            Query.limit(1)
          ]
        });

      if (dejaRecue.total) {
        return res.json({
          ok: false,
          message: "Cette personne vous a déjà envoyé une demande."
        }, 400);
      }

      const debit =
        await removePoints(userId, 1);

      if (!debit.ok) {
        return res.json(debit, 400);
      }

      try {

        const demande =
          await tablesDB.createRow({
            databaseId: DATABASE_ID,
            tableId: TABLE_DEMANDES,
            rowId: ID.unique(),
            data: {
              expediteurId: userId,
              destinataireId: peerId,
              statut: "en_attente",
              pointsDepenses: 1,
              dateCreation: new Date().toISOString()
            },
            permissions: [
              Permission.read(Role.user(userId)),
              Permission.read(Role.user(peerId)),
              Permission.update(Role.user(peerId))
            ]
          });

        return res.json({
          ok: true,
          demande,
          nouveauSolde: debit.nouveauSolde
        });

      } catch (e) {

        await addPoints(userId, 1);
        throw e;
      }
    }


    if (action === "refuserDemande") {

      const demandeId = payload.demandeId;

      if (!demandeId) {
        return res.json({
          ok: false,
          message: "Demande manquante."
        }, 400);
      }

      const demande =
        await tablesDB.getRow({
          databaseId: DATABASE_ID,
          tableId: TABLE_DEMANDES,
          rowId: demandeId
        });

      if (demande.destinataireId !== userId) {
        return res.json({
          ok: false,
          message: "Action non autorisée."
        }, 403);
      }

      if (demande.statut !== "en_attente") {
        return res.json({
          ok: false,
          message: "Cette demande a déjà été traitée."
        }, 400);
      }

      await tablesDB.updateRow({
        databaseId: DATABASE_ID,
        tableId: TABLE_DEMANDES,
        rowId: demandeId,
        data: {
          statut: "refuse",
          dateReponse: new Date().toISOString()
        }
      });

      await addPoints(
        demande.expediteurId,
        Number(demande.pointsDepenses || 1)
      );

      return res.json({
        ok: true
      });
    }


    if (action === "expirerDemandes") {

      const limite =
        new Date(
          Date.now() -
          DELAI_REPONSE_JOURS *
          24 *
          60 *
          60 *
          1000
        ).toISOString();

      let expirees = 0;

      for (const champ of [
        "destinataireId",
        "expediteurId"
      ]) {

        const demandes =
          await tablesDB.listRows({
            databaseId: DATABASE_ID,
            tableId: TABLE_DEMANDES,
            queries: [
              Query.equal(champ, userId),
              Query.equal("statut", "en_attente"),
              Query.lessThan(
                "dateCreation",
                limite
              ),
              Query.limit(50)
            ]
          });

        for (const demande of demandes.rows) {

          await tablesDB.updateRow({
            databaseId: DATABASE_ID,
            tableId: TABLE_DEMANDES,
            rowId: demande.$id,
            data: {
              statut: "refuse",
              dateReponse: new Date().toISOString()
            }
          });

          await addPoints(
            demande.expediteurId,
            Number(demande.pointsDepenses || 1)
          );

          expirees++;
        }
      }

      return res.json({
        ok: true,
        expirees
      });
    }


    return res.json({
      ok: false,
      message: "Action inconnue."
    }, 400);

  } catch (e) {

    error(e.message);

    return res.json({
      ok: false,
      message: e.message || "Erreur serveur."
    }, 500);
  }

};
