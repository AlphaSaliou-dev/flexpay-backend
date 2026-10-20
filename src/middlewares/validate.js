// Valide req.body contre un schéma Zod. Rejette systématiquement toute
// requête mal formée avant qu'elle n'atteigne la logique métier - une
// fintech ne doit jamais faire confiance à l'entrée sans la vérifier.
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Requête invalide',
        details: result.error.flatten().fieldErrors,
      });
    }
    req.body = result.data;
    next();
  };
}

module.exports = { validate };
