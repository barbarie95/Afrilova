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

    return res.json({ ok: false, message: "Action inconnue." }, 400);

  } catch (e) {
    error(e.message);
    return res.json({ ok: false, message: e.message }, 500);
  }

};
