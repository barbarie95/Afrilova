/* =====================================================
   AFRILOVA - Fonction de notification de paiement BKApay
   Fichier : webhook/index.js
   Ne fait qu'une chose : recevoir la notification signée
   de BKApay et créditer les points d'une commande payée.
   ===================================================== */

import { Client, Databases, ID, Query } from "node-appwrite";
import crypto from "node:crypto";

/* ---------- Connexion Appwrite ---------- */
const client = new Client()
  .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
  .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID);

const databases = new Databases(client);

const DATABASE_ID =
  process.env.APPWRITE_DATABASE_ID || "6aac2a200000e6be5877";

const TABLE_TRANSACTIONS = "transactions";
const TABLE_POINTS = "points";

// Secret de signature fourni par BKApay (variable secrète de la fonction)
const WEBHOOK_SECRET = process.env.BKAPAY_WEBHOOK_SECRET;

// Devise attendue pour toutes les commandes
const DEVISE_ATTENDUE = "XOF";

/* ---------- Utilitaires ---------- */

// Limite la longueur d'un texte
function cleanText(value, max = 100) {
  return String(value ?? "").trim().slice(0, max);
}

// Vérifie la signature HMAC-SHA256 calculée sur le corps brut
function signatureValide(corpsBrut, signature) {
  if (!WEBHOOK_SECRET || !signature) {
    return false;
  }

  const attendue = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(corpsBrut)
    .digest("hex");

  const a = Buffer.from(attendue);
  const b = Buffer.from(signature);

  // Comparaison à temps constant (longueurs identiques exigées)
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- Points ---------- */

// Lit le compte de points d'un utilisateur (ou null)
async function getPoints(userId) {
  const resultat = await databases.listDocuments(
    DATABASE_ID,
    TABLE_POINTS,
    [
      Query.equal("userId", userId),
      Query.limit(1),
    ]
  );

  return resultat.documents[0] || null;
}

// Ajoute des points (crée le compte s'il n'existe pas encore)
async function addPoints(userId, montant) {
  montant = Number(montant);

  if (!Number.isInteger(montant) || montant <= 0) {
    throw new Error("Nombre de points invalide.");
  }

  const points = await getPoints(userId);

  if (!points) {
    return databases.createDocument(
      DATABASE_ID,
      TABLE_POINTS,
      ID.unique(),
      {
        userId,
        solde: montant,
        dateModification: new Date().toISOString(),
      }
    );
  }

  return databases.updateDocument(
    DATABASE_ID,
    TABLE_POINTS,
    points.$id,
    {
      solde: Number(points.solde || 0) + montant,
      dateModification: new Date().toISOString(),
    }
  );
}

/* =====================================================
   POINT D'ENTRÉE DE LA FONCTION
   ===================================================== */

export default async ({ req, res, log, error }) => {
  try {
    if (req.method !== "POST") {
      return res.json({ ok: false, message: "Méthode refusée." }, 405);
    }

    if (!WEBHOOK_SECRET) {
      throw new Error("Secret du webhook absent.");
    }

    // Clé dynamique fournie par Appwrite pour cette exécution
    const cleDynamique = req.headers?.["x-appwrite-key"];

    if (!cleDynamique) {
      throw new Error("Clé de la fonction absente.");
    }

    client.setKey(cleDynamique);

    // La signature se calcule sur le corps BRUT, avant tout parsing
    const corpsBrut = req.bodyText ?? "";
    const signature = String(req.headers?.["x-bkapay-signature"] || "");

    if (!signatureValide(corpsBrut, signature)) {
      error("Signature invalide.");
      return res.json({ ok: false, message: "Signature invalide." }, 401);
    }

    const evenement = JSON.parse(corpsBrut);
    const type = cleanText(evenement.type, 50);
    const donnees = evenement.data || {};
    const commandeId = cleanText(donnees.order_id, 40);

    if (!commandeId) {
      return res.json({ received: true, ignore: "order_id absent" });
    }

    // La commande est une ligne de la table transactions
    let commande;

    try {
      commande = await databases.getDocument(
        DATABASE_ID,
        TABLE_TRANSACTIONS,
        commandeId
      );
    } catch (e) {
      return res.json({ received: true, ignore: "commande inconnue" });
    }

    if (commande.passerelle !== "bkapay") {
      return res.json({ received: true, ignore: "autre passerelle" });
    }

    // Déjà traitée : on ne fait rien (la notification peut arriver plusieurs fois)
    if (commande.statut !== "en_attente") {
      return res.json({ received: true, deja: commande.statut });
    }

    // Paiement échoué ou session expirée
    if (type === "payment.failed" || type === "payment.expired") {
      await databases.updateDocument(
        DATABASE_ID,
        TABLE_TRANSACTIONS,
        commande.$id,
        { statut: "echoue" }
      );

      return res.json({ received: true, statut: "echoue" });
    }

    // Seul un paiement réussi crédite des points
    if (type !== "payment.completed") {
      return res.json({ received: true, ignore: "événement inconnu" });
    }

    // Contrôles de cohérence : tout doit correspondre à la commande
    const montantPaye = Number(donnees.amount);
    const sessionOk =
      !commande.referencePaiement ||
      donnees.sessionId === commande.referencePaiement;

    if (
      donnees.status !== "completed" ||
      montantPaye !== Number(commande.montant) ||
      (donnees.currency && donnees.currency !== DEVISE_ATTENDUE) ||
      !sessionOk
    ) {
      error(
        "Notification incohérente pour la commande " + commande.$id
      );
      return res.json({ received: true, ignore: "incohérent" });
    }

    // On marque la commande confirmée AVANT de créditer
    await databases.updateDocument(
      DATABASE_ID,
      TABLE_TRANSACTIONS,
      commande.$id,
      {
        statut: "confirme",
        moyenPaiement: cleanText(donnees.operator, 50),
        dateConfirmation: new Date().toISOString(),
      }
    );

    try {
      await addPoints(commande.userId, commande.nombrePoints);
    } catch (e) {
      // Échec du crédit : on remet en attente pour que BKApay réessaie
      await databases.updateDocument(
        DATABASE_ID,
        TABLE_TRANSACTIONS,
        commande.$id,
        { statut: "en_attente" }
      );

      throw e;
    }

    log("Points crédités : commande " + commande.$id);

    return res.json({ received: true, statut: "confirme" });
  } catch (e) {
    error(e?.message || e);

    // Une erreur 500 permet à BKApay de renvoyer la notification
    return res.json(
      { ok: false, message: e?.message || "Erreur." },
      500
    );
  }
};
