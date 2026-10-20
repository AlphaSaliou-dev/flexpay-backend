const walletService = require('./wallet.service');
const { logError } = require('../../utils/logger');
const { LimitExceededError } = require('./limits.guard');

function handle(serviceFn) {
  return async (req, res) => {
    try {
      const result = await serviceFn(req);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof walletService.WalletError || err instanceof LimitExceededError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      logError('wallet', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  };
}

const getBalance = handle((req) => walletService.getBalance(req.user.id));
const getHistory = handle((req) => walletService.getHistory(req.user.id));
const lookupRecipient = handle((req) => walletService.lookupRecipient(req.user.id, req.query.phone));
// Le dépôt (argent qui ENTRE) ne nécessite pas d'OTP sensible - le risque
// est côté retrait/transfert (argent qui SORT), pas côté dépôt.
const deposit = handle((req) => walletService.deposit(req.user.id, req.body));

const withdraw = handle((req) => walletService.withdraw(req.user.id, req.body));
const transfer = handle((req) => walletService.transfer(req.user.id, req.body));

const statementService = require('./statement.service');

async function getStatementCsv(req, res) {
  try {
    const csv = await statementService.generateCsvStatement(req.user.id, req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="releve-flexpay.csv"');
    res.send(csv);
  } catch (err) {
    if (err instanceof statementService.StatementError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logError('wallet', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

async function getStatementPdf(req, res) {
  try {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="releve-flexpay.pdf"');
    await statementService.generatePdfStatement(req.user.id, req.query, res);
  } catch (err) {
    if (err instanceof statementService.StatementError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logError('wallet', err);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur serveur' });
  }
}

module.exports = { getBalance, getHistory, lookupRecipient, deposit, withdraw, transfer, getStatementCsv, getStatementPdf };
