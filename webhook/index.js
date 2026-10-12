/* =====================================================
   AFRILOVA - Fonction de notification de paiement
   Fichier : webhook/index.js
   Reçoit la notification SIGNÉE d'un service de paiement
   (SenePay ou BKApay) et crédite les points d'une commande
   payée. Chaque service a son propre secret de signature.
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

// Secrets de signature (variables secrètes de la fonction)
const SENEPAY_SECRET = process.env.SENEPAY_WEBHOOK_SECRET;
const BKAPAY_SECRET = process.env.BKAPAY_WEBHOOK_SECRET;

// Devise attendue pour toutes les commandes
const DEVISE_ATTENDUE = "XOF";

/* ---------- Utilitaires ---------- */

// Limite la longueur d'un texte
function cleanText(value, max = 100) {
  return String(value ?? "").trim().slice(0, max);
}

// Vérifie la signature HMAC-SHA256 calculée sur le corps brut
function signatureValide(corpsBrut, signature, secret) {
  if (!secret || !signature) {
    return false;
  }

  const attendue = crypto
    .createHmac("sha256", secret)
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

    if (!SENEPAY_SECRET && !BKAPAY_SECRET) {
      throw new Error("Aucun secret de signature configuré.");
    }

    // Clé dynamique fournie par Appwrite pour cette exécution
    const cleDynamique = req.headers?.["x-appwrite-key"];

    if (!cleDynamique) {
      throw new Error("Clé de la fonction absente.");
    }

    client.setKey(cleDynamique);

    // La signature se calcule sur le corps BRUT, avant tout parsing
    const corpsBrut = req.bodyText ?? "";
    const signatureSenepay = String(req.headers?.["x-senepay-signature"] || "");
    const signatureBkapay = String(req.headers?.["x-bkapay-signature"] || "");

    // On identifie le service d'après la signature, qui doit être valide
    let passerelle = null;

    if (signatureValide(corpsBrut, signatureSenepay, SENEPAY_SECRET)) {
      passerelle = "senepay";
    } else if (signatureValide(corpsBrut, signatureBkapay, BKAPAY_SECRET)) {
      passerelle = "bkapay";
    }

    if (!passerelle) {
      error("Signature invalide.");
      return res.json({ ok: false, message: "Signature invalide." }, 401);
    }

    const evenement = JSON.parse(corpsBrut);

    // On ramène les deux formats de notification à un même résumé
    let resume;

    if (passerelle === "senepay") {
      resume = {
        reussi: evenement.event === "checkout.session.completed",
        echec: evenement.event === "checkout.session.failed",
        commandeId: cleanText(evenement.orderReference, 40),
        session: cleanText(evenement.sessionToken, 255),
        montant: Number(evenement.amount),
        devise: evenement.currency,
        statutOk: evenement.status === "Complete",
        moyen: "senepay",
      };
    } else {
      const d = evenement.data || {};

      resume = {
        reussi: evenement.type === "payment.completed",
        echec:
          evenement.type === "payment.failed" ||
          evenement.type === "payment.expired",
        commandeId: cleanText(d.order_id, 40),
        session: cleanText(d.sessionId, 255),
        montant: Number(d.amount),
        devise: d.currency,
        statutOk: d.status === "completed",
        moyen: cleanText(d.operator, 50) || "bkapay",
      };
    }

    if (!resume.commandeId) {
      return res.json({ received: true, ignore: "référence absente" });
    }

    // La commande est une ligne de la table transactions
    let commande;

    try {
      commande = await databases.getDocument(
        DATABASE_ID,
        TABLE_TRANSACTIONS,
        resume.commandeId
      );
    } catch (e) {
      return res.json({ received: true, ignore: "commande inconnue" });
    }

    // Une notification ne peut concerner que les commandes de SON service
    if (commande.passerelle !== passerelle) {
      return res.json({ received: true, ignore: "autre passerelle" });
    }

    // Déjà traitée : on ne fait rien (la notification peut arriver plusieurs fois)
    if (commande.statut !== "en_attente") {
      return res.json({ received: true, deja: commande.statut });
    }

    // Paiement échoué ou session expirée
    if (resume.echec) {
      await databases.updateDocument(
        DATABASE_ID,
        TABLE_TRANSACTIONS,
        commande.$id,
        { statut: "echoue" }
      );

      return res.json({ received: true, statut: "echoue" });
    }

    // Seul un paiement réussi crédite des points
    if (!resume.reussi) {
      return res.json({ received: true, ignore: "événement inconnu" });
    }

    // Contrôles de cohérence : tout doit correspondre à la commande
    const sessionOk =
      !commande.referencePaiement ||
      resume.session === commande.referencePaiement;

    if (
      !resume.statutOk ||
      resume.montant !== Number(commande.montant) ||
      (resume.devise && resume.devise !== DEVISE_ATTENDUE) ||
      !sessionOk
    ) {
      error("Notification incohérente pour la commande " + commande.$id);
      return res.json({ received: true, ignore: "incohérent" });
    }

    // On marque la commande confirmée AVANT de créditer
    await databases.updateDocument(
      DATABASE_ID,
      TABLE_TRANSACTIONS,
      commande.$id,
      {
        statut: "confirme",
        moyenPaiement: resume.moyen,
        dateConfirmation: new Date().toISOString(),
      }
    );

    try {
      await addPoints(commande.userId, commande.nombrePoints);
    } catch (e) {
      // Échec du crédit : on remet en attente pour que le service réessaie
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

    // Une erreur 500 permet au service de renvoyer la notification
    return res.json(
      { ok: false, message: e?.message || "Erreur." },
      500
    );
  }
};
