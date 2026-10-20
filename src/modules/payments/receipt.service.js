const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const prisma = require('../../config/db');
const filesService = require('../files/files.service');

class ReceiptError extends Error {
  constructor(message, statusCode = 404) {
    super(message);
    this.statusCode = statusCode;
  }
}

function extractFileId(fileUrl) {
  return fileUrl.split('/').pop();
}

function getVerificationUrl(transactionId) {
  const base = process.env.PUBLIC_API_URL || 'http://localhost:4000';
  return `${base}/api/v1/payments/receipts/${transactionId}/verify`;
}

// Charge la transaction et vérifie que le demandeur est bien l'une des
// deux parties (le payeur OU l'institution qui a reçu le paiement) -
// jamais un tiers, même connecté.
async function loadTransactionForReceipt(transactionId, requestingUserId) {
  const tx = await prisma.transaction.findUnique({
    where: { id: transactionId },
    include: { ledgerEntries: { include: { wallet: true } } },
  });

  if (!tx || tx.type !== 'MERCHANT_PAYMENT') {
    throw new ReceiptError('Reçu indisponible pour cette transaction');
  }

  const creditEntry = tx.ledgerEntries.find((e) => e.direction === 'CREDIT');
  const businessUserId = creditEntry?.wallet.userId;

  const isPayer = tx.initiatedByUserId === requestingUserId;
  const isRecipient = businessUserId === requestingUserId;
  if (!isPayer && !isRecipient) {
    throw new ReceiptError('Reçu introuvable');
  }

  return { tx, businessUserId };
}

// --- Vérification publique (n'importe qui peut scanner le QR) --------------
// Volontairement minimal : confirme l'AUTHENTICITÉ du reçu sans jamais
// republier d'informations potentiellement sensibles - ni le numéro de
// téléphone du payeur, ni les champs personnalisés (un nom d'élève, un
// numéro de dossier patient n'ont rien à faire dans une réponse publique
// accessible par simple scan, même si c'est le payeur qui montre le reçu
// à quelqu'un d'autre que l'institution concernée).
async function getPublicVerificationData(transactionId) {
  const tx = await prisma.transaction.findUnique({
    where: { id: transactionId },
    include: { ledgerEntries: { include: { wallet: true } } },
  });

  if (!tx || tx.type !== 'MERCHANT_PAYMENT') {
    throw new ReceiptError('Reçu introuvable ou invalide');
  }

  const creditEntry = tx.ledgerEntries.find((e) => e.direction === 'CREDIT');
  const business = creditEntry?.wallet.userId
    ? await prisma.businessProfile.findUnique({ where: { userId: creditEntry.wallet.userId } })
    : null;

  return {
    transactionId: tx.id,
    businessName: business?.businessName || null,
    amount: Number(tx.amount),
    currency: tx.currency,
    date: tx.createdAt,
  };
}

function formatDateTime(date) {
  return `${date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })} à ${date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

// Helvetica (police de base PDFKit) ne rend pas l'espace insécable que
// toLocaleString('fr-FR') utilise comme séparateur de milliers - il
// s'affiche comme un caractère erroné plutôt qu'un espace. Remplacé par un
// espace normal uniquement pour le rendu PDF.
function formatAmount(amount) {
  return `${Number(amount).toLocaleString('fr-FR').replace(/\u202f/g, ' ')} GNF`;
}

async function generateReceiptPdf(transactionId, requestingUserId, res) {
  const { tx, businessUserId } = await loadTransactionForReceipt(transactionId, requestingUserId);

  const [business, payer] = await Promise.all([
    prisma.businessProfile.findUnique({ where: { userId: businessUserId } }),
    // Paiement invité (Mobile Money, sans compte FlexPay) : pas d'utilisateur à chercher.
    tx.initiatedByUserId ? prisma.user.findUnique({ where: { id: tx.initiatedByUserId } }) : null,
  ]);
  const customFields = tx.metadata?.customFields || [];

  const qrBuffer = await QRCode.toBuffer(getVerificationUrl(tx.id), { margin: 0, width: 240 });

  const PAGE_WIDTH = 595.28;
  const LEFT = 56;
  const RIGHT = PAGE_WIDTH - 56;
  const CONTENT_WIDTH = RIGHT - LEFT;

  const doc = new PDFDocument({ margin: 0, size: 'A4' });
  doc.pipe(res);

  // --- En-tête : logo + nom à gauche, QR de vérification à droite --------
  doc.rect(0, 0, PAGE_WIDTH, 4).fill('#0A2540');

  let logoDrawn = false;
  if (business?.receiptLogoUrl) {
    try {
      const { buffer } = await filesService.getFileBuffer(extractFileId(business.receiptLogoUrl));
      doc.image(buffer, LEFT, 40, { width: 112, height: 44, fit: [112, 44] });
      logoDrawn = true;
    } catch {
      // logo illisible - le reçu continue sans, jamais d'échec total pour ça
    }
  }

  const nameY = logoDrawn ? 96 : 44;
  doc.fontSize(16).fillColor('#0A2540').font('Helvetica-Bold').text(business?.businessName || 'Reçu de paiement', LEFT, nameY, { width: 300 });
  if (business?.receiptContactInfo) {
    doc.fontSize(9).fillColor('#4B5768').font('Helvetica').text(business.receiptContactInfo, LEFT, nameY + 20, { width: 300 });
  }

  doc.image(qrBuffer, RIGHT - 68, 40, { width: 68 });
  doc
    .fontSize(7)
    .fillColor('#8A94A6')
    .font('Helvetica')
    .text("Scannez pour vérifier l'authenticité", RIGHT - 92, 112, { width: 92, align: 'center' });

  // --- Numéro / date à gauche, montant à droite ---------------------------
  let y = 150;
  doc.fontSize(8).fillColor('#8A94A6').font('Helvetica').text('REÇU DE PAIEMENT', LEFT, y, { characterSpacing: 1 });
  doc.fontSize(10).fillColor('#4B5768').font('Helvetica').text('N° de reçu', LEFT, y + 16, { continued: true });
  doc.font('Helvetica-Bold').fillColor('#101828').text(`  ${tx.id}`);
  doc.font('Helvetica').fillColor('#4B5768').text('Émis le', LEFT, y + 32, { continued: true });
  doc.font('Helvetica-Bold').fillColor('#101828').text(`  ${formatDateTime(tx.createdAt)}`);

  doc.fontSize(8).fillColor('#8A94A6').font('Helvetica').text('MONTANT PAYÉ', LEFT, y, { width: CONTENT_WIDTH, align: 'right', characterSpacing: 1 });
  doc
    .fontSize(26)
    .fillColor('#0D6EFD')
    .font('Helvetica-Bold')
    .text(formatAmount(tx.amount), LEFT, y + 12, { width: CONTENT_WIDTH, align: 'right' });
  doc.rect(RIGHT - 148, y + 44, 148, 18).fill('#E9F7EF');
  // Coche dessinée en vecteur plutôt qu'en caractère Unicode : Helvetica
  // (police de base PDFKit) n'a pas le glyphe ✓ et affiche un caractère
  // erroné à la place.
  doc
    .save()
    .lineWidth(1.6)
    .strokeColor('#16A34A')
    .moveTo(RIGHT - 134, y + 53)
    .lineTo(RIGHT - 130, y + 57)
    .lineTo(RIGHT - 123, y + 49)
    .stroke()
    .restore();
  doc
    .fontSize(8)
    .fillColor('#16A34A')
    .font('Helvetica-Bold')
    .text('PAIEMENT CONFIRMÉ', RIGHT - 148 + 14, y + 49, { width: 148 - 14, align: 'center' });

  y += 88;
  doc.moveTo(LEFT, y).lineTo(RIGHT, y).strokeColor('#E4E9F0').lineWidth(1).stroke();

  // --- Objet du paiement + détails --------------------------------------
  y += 24;
  doc.fontSize(8).fillColor('#8A94A6').font('Helvetica').text('OBJET DU PAIEMENT', LEFT, y, { characterSpacing: 1 });
  y += 14;
  doc.fontSize(13).fillColor('#101828').font('Helvetica-Bold').text(tx.metadata?.reference || 'Paiement marchand', LEFT, y);
  y += 26;

  const rows = [...customFields.map((f) => [f.label, f.value || '-'])];
  const mobileMoneyLabel = { orange_money: 'Orange Money', mtn_momo: 'MTN Mobile Money' }[tx.metadata?.mobileMoneyProvider];
  const paidByValue = payer?.phone
    ? `${payer.phone}, via FlexPay`
    : mobileMoneyLabel
      ? `${tx.metadata?.payerPhone || ''}, via ${mobileMoneyLabel}`.trim()
      : 'via FlexPay';
  rows.push(['Payé par', paidByValue]);

  rows.forEach(([label, value], index) => {
    const rowHeight = 26;
    doc.fontSize(10).fillColor('#8A94A6').font('Helvetica').text(label, LEFT, y, { width: CONTENT_WIDTH * 0.38 });
    doc.fontSize(10).fillColor('#101828').font('Helvetica-Bold').text(value, LEFT + CONTENT_WIDTH * 0.38, y, { width: CONTENT_WIDTH * 0.62 });
    y += rowHeight;
    if (index < rows.length - 1) {
      doc.moveTo(LEFT, y - 8).lineTo(RIGHT, y - 8).strokeColor('#EEF1F5').lineWidth(0.75).stroke();
    }
  });

  // --- Bandeau récapitulatif ----------------------------------------------
  y += 12;
  const bandHeight = 60;
  doc.roundedRect(LEFT, y, CONTENT_WIDTH, bandHeight, 4).fill('#F6F8FB');
  doc
    .fontSize(9)
    .fillColor('#4B5768')
    .font('Helvetica')
    .text(
      'Ce reçu atteste d\'un paiement encaissé par l\'institution nommée ci-dessus. Le montant indiqué est celui débité au payeur.',
      LEFT + 18,
      y + 14,
      { width: CONTENT_WIDTH * 0.6 }
    );
  doc.fontSize(8).fillColor('#8A94A6').font('Helvetica').text('TOTAL RÉGLÉ', LEFT, y + 14, { width: CONTENT_WIDTH - 18, align: 'right', characterSpacing: 0.5 });
  doc
    .fontSize(14)
    .fillColor('#0A2540')
    .font('Helvetica-Bold')
    .text(formatAmount(tx.amount), LEFT, y + 28, { width: CONTENT_WIDTH - 18, align: 'right' });

  if (business?.receiptFooterText) {
    y += bandHeight + 20;
    doc.fontSize(9).fillColor('#4B5768').font('Helvetica').text(business.receiptFooterText, LEFT, y, { width: CONTENT_WIDTH });
  }

  // Mentions légales (RCCM/NIF) - déjà collectées au KYB Entreprise,
  // jamais ressaisies ici, affichées seulement si renseignées.
  const legalMentions = [business?.rccmNumber && `RCCM ${business.rccmNumber}`, business?.nifNumber && `NIF ${business.nifNumber}`]
    .filter(Boolean)
    .join('   ·   ');
  if (legalMentions) {
    y += business?.receiptFooterText ? 18 : bandHeight + 20;
    doc.fontSize(8).fillColor('#8A94A6').font('Helvetica').text(legalMentions, LEFT, y, { width: CONTENT_WIDTH });
  }

  // --- Pied de page : marque FlexPay + référence --------------------------
  const footerY = 780;
  doc.moveTo(LEFT, footerY).lineTo(RIGHT, footerY).strokeColor('#E4E9F0').lineWidth(1).stroke();
  doc.fontSize(9).fillColor('#8A94A6').font('Helvetica').text('Reçu émis par ', LEFT, footerY + 14, { continued: true });
  doc.font('Helvetica-Bold').fillColor('#0A2540').text('FlexPay', { continued: true });
  doc.font('Helvetica').fillColor('#8A94A6').text(', flexpay.gn');
  doc.fontSize(9).font('Helvetica').fillColor('#8A94A6').text(tx.id, LEFT, footerY + 14, { width: CONTENT_WIDTH, align: 'right' });

  doc.end();
}

module.exports = {
  ReceiptError,
  generateReceiptPdf,
  loadTransactionForReceipt,
  getPublicVerificationData,
  getVerificationUrl,
};
