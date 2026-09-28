import { Client, TablesDB, Storage, Permission, Role, Query, ID } from "node-appwrite";

const DATABASE_ID = "6aac2a200000e6be5877";
const TABLE_CONVERSATIONS = "conversations";
const TABLE_MESSAGES = "messages";
const BUCKET_PHOTOS = "6aad2a754e0e095d6a9a";
const ADMIN_TEAM_ID = "6aacffe749b1978e61bf";

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
  } catch (e) {
    return res.json({ ok: false, message: "Requête invalide." }, 400);
  }

  const action = payload.action;

  try {

    if (action === "creerConversation") {

      const peerId = payload.peerId;
      if (!peerId) return res.json({ ok: false, message: "peerId manquant." }, 400);

      const q1 = await tablesDB.listRows({
        databaseId: DATABASE_ID, tableId: TABLE_CONVERSATIONS,
        queries: [Query.equal("utilisateur1Id", userId), Query.equal("utilisateur2Id", peerId), Query.limit(1)]
      });
      if (q1.total > 0) return res.json({ ok: true, conversation: q1.rows[0] });

      const q2 = await tablesDB.listRows({
        databaseId: DATABASE_ID, tableId: TABLE_CONVERSATIONS,
        queries: [Query.equal("utilisateur1Id", peerId), Query.equal("utilisateur2Id", userId), Query.limit(1)]
      });
      if (q2.total > 0) return res.json({ ok: true, conversation: q2.rows[0] });

      const conversation = await tablesDB.createRow({
        databaseId: DATABASE_ID, tableId: TABLE_CONVERSATIONS, rowId: ID.unique(),
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

      return res.json({ ok: true, conversation });

    }

    if (action === "envoyerMessage") {

      const { conversationId, peerId, contenu, photoId } = payload;
      if (!conversationId || !peerId) {
        return res.json({ ok: false, message: "Paramètres manquants." }, 400);
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

      const message = await tablesDB.createRow({
        databaseId: DATABASE_ID, tableId: TABLE_MESSAGES, rowId: ID.unique(),
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

      return res.json({ ok: true, message });

    }

    if (action === "creditPointInscription") {

      const TABLE_PROFILS = "6aac2b35002a0debbb85";
      const TABLE_POINTS = "points";

      // 1. Le profil de l'utilisateur doit exister
      const profils = await tablesDB.listRows({
        databaseId: DATABASE_ID,
        tableId: TABLE_PROFILS,
        queries: [Query.equal("userId", userId), Query.limit(1)]
      });

      if (profils.total === 0) {
        return res.json({ ok: false, message: "Créez d'abord votre profil." }, 400);
      }

      // 2. Un seul point par compte : l'identifiant de la ligne = userId
      //    (un deuxième essai est refusé par Appwrite : conflit 409)
      try {
        await tablesDB.createRow({
          databaseId: DATABASE_ID,
          tableId: TABLE_POINTS,
          rowId: userId,
          data: {
            userId: userId,
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
          return res.json({ ok: true, dejaCredite: true });
        }
        throw e;
      }

      return res.json({ ok: true, dejaCredite: false, solde: 1 });

    } // <-- fermeture ajoutée : fin du bloc creditPointInscription

    if (action === "envoyerDemande") {

      const TABLE_DEMANDES = "demandes";
      const TABLE_POINTS = "points";

      const { peerId } = payload;

      if (!peerId) {
        return res.json({ ok: false, message: "Destinataire manquant." }, 400);
      }

      if (peerId === userId) {
        return res.json({ ok: false, message: "Vous ne pouvez pas vous envoyer une demande à vous-même." }, 400);
      }

      // 1. Vérifier qu'aucune demande en attente n'existe déjà entre les deux, dans un sens ou l'autre
      const existante1 = await tablesDB.listRows({
        databaseId: DATABASE_ID,
        tableId: TABLE_DEMANDES,
        queries: [
          Query.equal("expediteurId", userId),
          Query.equal("destinataireId", peerId),
          Query.equal("statut", "en_attente"),
          Query.limit(1)
        ]
      });
      if (existante1.total > 0) {
        return res.json({ ok: false, message: "Une demande est déjà en attente avec cette personne." }, 400);
      }

      const existante2 = await tablesDB.listRows({
        databaseId: DATABASE_ID,
        tableId: TABLE_DEMANDES,
        queries: [
          Query.equal("expediteurId", peerId),
          Query.equal("destinataireId", userId),
          Query.equal("statut", "en_attente"),
          Query.limit(1)
        ]
      });
      if (existante2.total > 0) {
        return res.json({ ok: false, message: "Cette personne vous a déjà envoyé une demande. Consultez vos demandes." }, 400);
      }

      // 2. Vérifier le solde de points
      const soldeRows = await tablesDB.listRows({
        databaseId: DATABASE_ID,
        tableId: TABLE_POINTS,
        queries: [Query.equal("userId", userId), Query.limit(1)]
      });

      const solde = soldeRows.total > 0 ? soldeRows.rows[0].solde : 0;

      if (solde < 1) {
        return res.json({ ok: false, message: "Solde insuffisant. Achetez des points pour envoyer une demande." }, 400);
      }

      // 3. Retirer 1 point
      await tablesDB.updateRow({
        databaseId: DATABASE_ID,
        tableId: TABLE_POINTS,
        rowId: soldeRows.rows[0].$id,
        data: {
          solde: solde - 1,
          dateModification: new Date().toISOString()
        }
      });

      // 4. Créer la demande
      const demande = await tablesDB.createRow({
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

      return res.json({ ok: true, demande });

    }

    return res.json({ ok: false, message: "Action inconnue." }, 400);

  } catch (e) {
    error(e.message);
    return res.json({ ok: false, message: e.message }, 500);
  }

};
