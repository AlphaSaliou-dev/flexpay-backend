const PDFDocument = require('pdfkit');
const prisma = require('../../config/db');
const { toCsv } = require('../../utils/csv');
const { getOrCreateUserWallet } = require('./wallet.service');

class StatementError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function parseDateRange({ from, to }) {
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from ? new Date(from) : new Date(toDate.getFullYear(), toDate.getMonth() - 1, toDate.getDate());

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new StatementError('Dates invalides (format attendu : AAAA-MM-JJ)', 400);
  }
  if (fromDate > toDate) {
    throw new StatementError('La date de début doit précéder la date de fin', 400);
  }
  return { fromDate, toDate };
}

async function getStatementEntries(userId, { from, to }) {
  const { fromDate, toDate } = parseDateRange({ from, to });
  const wallet = await getOrCreateUserWallet(userId);

  const entries = await prisma.ledgerEntry.findMany({
    where: { walletId: wallet.id, createdAt: { gte: fromDate, lte: toDate } },
    orderBy: { createdAt: 'asc' },
    include: { transaction: true },
  });

  return { wallet, fromDate, toDate, entries };
}

const TYPE_LABELS = {
  DEPOSIT: 'Dépôt',
  WITHDRAWAL: 'Retrait',
  TRANSFER: 'Transfert',
  MERCHANT_PAYMENT: 'Paiement marchand',
  FEE: 'Frais',
  CARD_TOPUP: 'Rechargement carte',
  REFUND: 'Remboursement',
};

async function generateCsvStatement(userId, range) {
  const { entries } = await getStatementEntries(userId, range);

  const rows = entries.map((e) => ({
    date: e.createdAt.toISOString(),
    type: TYPE_LABELS[e.transaction.type] || e.transaction.type,
    direction: e.direction === 'CREDIT' ? 'Crédit' : 'Débit',
    amount: Number(e.amount),
    balanceAfter: Number(e.balanceAfter),
    transactionId: e.transactionId,
  }));

  return toCsv(rows, [
    { key: 'date', label: 'Date' },
    { key: 'type', label: 'Type' },
    { key: 'direction', label: 'Sens' },
    { key: 'amount', label: 'Montant (GNF)' },
    { key: 'balanceAfter', label: 'Solde après (GNF)' },
    { key: 'transactionId', label: 'Référence' },
  ]);
}

// PDFKit génère en flux (stream) plutôt qu'en une seule chaîne en mémoire
// - important pour un relevé qui pourrait un jour couvrir des milliers de
// lignes sans faire exploser la mémoire du serveur.
async function generatePdfStatement(userId, range, res) {
  const { wallet, fromDate, toDate, entries } = await getStatementEntries(userId, range);
  const user = await prisma.user.findUnique({ where: { id: userId } });

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  doc.pipe(res);

  doc.fontSize(18).text('FlexPay — Relevé de compte', { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#4B5768');
  doc.text(`Titulaire : ${user.fullName || user.phone}`);
  doc.text(`Période : ${fromDate.toLocaleDateString('fr-FR')} — ${toDate.toLocaleDateString('fr-FR')}`);
  doc.text(`Solde actuel : ${Number(wallet.balance).toLocaleString('fr-FR')} GNF`);
  doc.moveDown(1);

  doc.fillColor('#000000').fontSize(9);
  const colX = { date: 40, type: 130, sens: 260, montant: 320, solde: 420 };
  doc.font('Helvetica-Bold');
  doc.text('Date', colX.date, doc.y, { continued: false });
  doc.text('Type', colX.type, doc.y - 12);
  doc.text('Sens', colX.sens, doc.y - 12);
  doc.text('Montant', colX.montant, doc.y - 12);
  doc.text('Solde après', colX.solde, doc.y - 12);
  doc.font('Helvetica');
  doc.moveTo(40, doc.y + 4).lineTo(555, doc.y + 4).strokeColor('#E4E9F0').stroke();
  doc.moveDown(0.5);

  if (entries.length === 0) {
    doc.fillColor('#8A94A6').text('Aucune transaction sur cette période.');
  }

  for (const e of entries) {
    const y = doc.y;
    doc.fillColor('#101828');
    doc.text(e.createdAt.toLocaleDateString('fr-FR'), colX.date, y);
    doc.text(TYPE_LABELS[e.transaction.type] || e.transaction.type, colX.type, y);
    doc.text(e.direction === 'CREDIT' ? 'Crédit' : 'Débit', colX.sens, y);
    doc.text(
      `${e.direction === 'CREDIT' ? '+' : '-'}${Number(e.amount).toLocaleString('fr-FR')}`,
      colX.montant,
      y
    );
    doc.text(Number(e.balanceAfter).toLocaleString('fr-FR'), colX.solde, y);
    doc.moveDown(0.6);

    // Nouvelle page si on approche du bas - PDFKit ne le fait pas
    // automatiquement en mode "texte positionné à la main" comme ici.
    if (doc.y > 760) {
      doc.addPage();
    }
  }

  doc.end();
}

module.exports = { StatementError, generateCsvStatement, generatePdfStatement };
