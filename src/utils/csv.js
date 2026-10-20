// Volontairement écrit à la main plutôt que d'ajouter une dépendance :
// le besoin (lignes de relevé -> CSV) est trop simple pour justifier un
// paquet externe, surtout que les alternatives matures pour Node sont
// soit obsolètes soit encore en alpha au moment où ceci est écrit.

function escapeCsvField(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(rows, columns) {
  const header = columns.map((c) => escapeCsvField(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => escapeCsvField(row[c.key])).join(','));
  return [header, ...lines].join('\r\n');
}

module.exports = { toCsv };
