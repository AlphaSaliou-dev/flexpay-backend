// Usage : node scripts/generate-api-reference.js
//
// Génère flexpay-docs/reference.html directement depuis docs/openapi.yaml
// (source unique, voir src/app.js). Le but : que la page de référence du
// site de documentation ne soit jamais retapée à la main (donc jamais en
// désaccord avec la vraie API) - on la régénère à chaque fois que
// openapi.yaml change, au lieu de maintenir une copie séparée.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const SPEC_PATH = path.join(__dirname, '../docs/openapi.yaml');
const OUTPUT_PATH = path.join(__dirname, '../../flexpay-docs/reference.html');

const spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));

function slug(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resolveRef(ref) {
  // Seule forme utilisée dans ce spec : '#/components/schemas/Nom'
  const name = ref.split('/').pop();
  return spec.components.schemas[name];
}

function describeType(schema) {
  if (!schema) return '';
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop();
    return name;
  }
  if (schema.type === 'array') {
    const itemType = schema.items ? describeType(schema.items) : '';
    return `${itemType}[]`;
  }
  if (schema.enum) {
    return `enum (${schema.enum.join(' | ')})`;
  }
  let t = schema.type || 'object';
  if (schema.format) t += ` (${schema.format})`;
  return t;
}

function renderFieldTable(properties, required) {
  const requiredSet = new Set(required || []);
  const names = Object.keys(properties || {});
  if (names.length === 0) return '';
  const rows = names.map((name) => {
    const field = properties[name];
    const isRequired = requiredSet.has(name);
    const bits = [];
    if (field.description) bits.push(escapeHtml(field.description));
    if (field.example !== undefined) bits.push(`<span style="color:var(--text-muted)">ex: <code>${escapeHtml(JSON.stringify(field.example))}</code></span>`);
    if (field.default !== undefined) bits.push(`<span style="color:var(--text-muted)">défaut: <code>${escapeHtml(JSON.stringify(field.default))}</code></span>`);
    if (field.minLength || field.maxLength) {
      const bounds = [field.minLength ? `min ${field.minLength}` : null, field.maxLength ? `max ${field.maxLength}` : null].filter(Boolean).join(', ');
      bits.push(`<span style="color:var(--text-muted)">${bounds}</span>`);
    }
    return `
      <div class="frow">
        <span class="fname">${escapeHtml(name)}${isRequired ? ' <span class="req">*</span>' : ''}</span>
        <span class="ftype">${escapeHtml(describeType(field))}</span>
        <span>${bits.join(' · ') || '&nbsp;'}</span>
      </div>`;
  }).join('');
  return `
    <div class="ref-field-table">
      <div class="frow head"><span>CHAMP</span><span>TYPE</span><span>DÉTAIL</span></div>
      ${rows}
    </div>`;
}

function renderParams(parameters) {
  if (!parameters || parameters.length === 0) return '';
  const rows = parameters.map((p) => {
    const isRequired = !!p.required;
    const loc = p.in === 'path' ? 'URL' : p.in === 'query' ? 'query' : p.in;
    return `
      <div class="frow">
        <span class="fname">${escapeHtml(p.name)}${isRequired ? ' <span class="req">*</span>' : ''}</span>
        <span class="ftype">${escapeHtml(describeType(p.schema))}</span>
        <span>${loc}${p.description ? ' · ' + escapeHtml(p.description) : ''}</span>
      </div>`;
  }).join('');
  return `
    <div class="ref-subhead">PARAMÈTRES</div>
    <div class="ref-field-table">
      <div class="frow head"><span>NOM</span><span>TYPE</span><span>DÉTAIL</span></div>
      ${rows}
    </div>`;
}

function renderRequestBody(requestBody) {
  if (!requestBody) return '';
  const content = requestBody.content && requestBody.content['application/json'];
  if (!content || !content.schema) return '';
  let schema = content.schema;
  if (schema.$ref) schema = resolveRef(schema.$ref);
  if (!schema.properties) return '';
  return `
    <div class="ref-subhead">CORPS DE LA REQUÊTE${requestBody.required ? ' (requis)' : ''}</div>
    ${renderFieldTable(schema.properties, schema.required)}`;
}

function renderResponses(responses) {
  if (!responses) return '';
  const rows = Object.keys(responses).map((code) => {
    const r = responses[code];
    const isOk = code.startsWith('2');
    let schemaNote = '';
    const content = r.content && r.content['application/json'];
    if (content && content.schema) {
      let s = content.schema;
      if (s.$ref) schemaNote = ` <span style="color:var(--text-muted)">(schéma : <code>${escapeHtml(s.$ref.split('/').pop())}</code>)</span>`;
      else if (s.type === 'array' && s.items && s.items.$ref) schemaNote = ` <span style="color:var(--text-muted)">(liste de <code>${escapeHtml(s.items.$ref.split('/').pop())}</code>)</span>`;
    }
    return `
      <div class="ref-resp-row">
        <span class="code ${isOk ? 'ok' : 'err'}">${escapeHtml(code)}</span>
        <span>${escapeHtml(r.description || '')}${schemaNote}</span>
      </div>`;
  }).join('');
  return `
    <div class="ref-subhead">RÉPONSES</div>
    ${rows}`;
}

function renderAuthPill(security) {
  if (!security || security.length === 0) {
    return '<span class="auth-pill">Public · aucune authentification</span>';
  }
  const scheme = Object.keys(security[0])[0];
  if (scheme === 'ApiKeyAuth') return '<span class="auth-pill">Clé API partenaire · en-tête <code>x-api-key</code></span>';
  if (scheme === 'BearerAuth') return '<span class="auth-pill">Session app FlexPay · en-tête <code>Authorization: Bearer</code></span>';
  return `<span class="auth-pill">${escapeHtml(scheme)}</span>`;
}

function renderOperation(opPath, method, op) {
  return `
    <div class="ref-op">
      <div class="code-block">
        <div class="head"><span class="method ${method}">${method.toUpperCase()}</span><span class="path">${escapeHtml(opPath)}</span></div>
      </div>
      <div class="summary">${escapeHtml(op.summary || '')}</div>
      ${op.description ? `<div class="op-desc">${escapeHtml(op.description.trim())}</div>` : ''}
      ${renderAuthPill(op.security)}
      ${renderParams(op.parameters)}
      ${renderRequestBody(op.requestBody)}
      ${renderResponses(op.responses)}
    </div>`;
}

// --- Regroupement par tag, dans l'ordre où les tags apparaissent dans
// spec.tags (ordre éditorial déjà choisi dans le fichier source), puis par
// ordre d'apparition des routes dans paths: ---
const tagOrder = spec.tags.map((t) => t.name);
const tagDescriptions = Object.fromEntries(spec.tags.map((t) => [t.name, t.description]));
const byTag = Object.fromEntries(tagOrder.map((t) => [t, []]));

let totalOps = 0;
for (const [opPath, methods] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
    totalOps += 1;
    const tag = (op.tags && op.tags[0]) || 'Autres';
    if (!byTag[tag]) {
      // Tag utilisé par une route mais absent de la liste `tags:` en tête
      // de fichier - on ne le perd jamais silencieusement, on l'ajoute en
      // fin de sommaire plutôt que de faire disparaître ses routes. Un
      // vrai cas trouvé en pratique : "Liens de paiement" (5 routes) n'y
      // figurait pas avant correction de openapi.yaml.
      console.warn(`[generate-api-reference] tag "${tag}" utilisé par ${method.toUpperCase()} ${opPath} mais absent de la section top-level "tags:" - ajouté quand même, mais corrigez openapi.yaml.`);
      tagOrder.push(tag);
      byTag[tag] = [];
    }
    byTag[tag].push({ opPath, method, op });
  }
}

const tocHtml = tagOrder
  .filter((tag) => byTag[tag].length > 0)
  .map((tag) => `<div class="toc-item" data-target="${slug(tag)}">${escapeHtml(tag)} <span style="color:var(--text-muted);font-weight:400">(${byTag[tag].length})</span></div>`)
  .join('\n        ');

const sectionsHtml = tagOrder
  .filter((tag) => byTag[tag].length > 0)
  .map((tag) => `
    <section id="${slug(tag)}" class="ref-tag-group">
      <h2>${escapeHtml(tag)}</h2>
      ${tagDescriptions[tag] ? `<p>${escapeHtml(tagDescriptions[tag])}</p>` : ''}
      ${byTag[tag].map(({ opPath, method, op }) => renderOperation(opPath, method, op)).join('\n')}
    </section>`)
  .join('\n');

const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FlexPay · Référence API complète</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>

<script>
  window.FLEXPAY_APP_URL = window.FLEXPAY_APP_URL || 'http://localhost:8081';
  window.FLEXPAY_LANDING_URL = window.FLEXPAY_LANDING_URL || 'http://localhost:5003';
  window.FLEXPAY_BUSINESS_URL = window.FLEXPAY_BUSINESS_URL || 'http://localhost:5001';
  window.FLEXPAY_SWAGGER_URL = window.FLEXPAY_SWAGGER_URL || 'http://localhost:4000/docs';
  window.FLEXPAY_SWAGGER_JSON_URL = window.FLEXPAY_SWAGGER_JSON_URL || 'http://localhost:4000/docs.json';
</script>

<header>
  <div class="brand" style="cursor:pointer" onclick="location.href=window.FLEXPAY_LANDING_URL">
    <svg width="22" height="22" viewBox="0 0 100 100"><rect x="24" y="42" width="52" height="34" rx="8" fill="#0A2540"></rect><path d="M24,42 L50,24 L76,42 Z" fill="#0A2540" opacity="0.55"></path><circle cx="64" cy="59" r="5" fill="#0D6EFD"></circle></svg>
    <span class="name">FlexPay</span>
    <span class="tag">Docs</span>
  </div>
  <div class="header-spacer"></div>
  <span class="header-link" onclick="location.href='index.html'">Guide</span>
  <span class="header-link active">Référence API</span>
  <span class="header-link" onclick="location.href='changelog.html'">Changelog</span>
  <button class="btn-cta" onclick="location.href=window.FLEXPAY_BUSINESS_URL">Obtenir une clé</button>
</header>

<div class="layout">
  <aside class="toc">
    <div>
      <div class="toc-group-label">${totalOps} ROUTES PAR DOMAINE</div>
      <div class="toc-items">
        ${tocHtml}
      </div>
    </div>
  </aside>

  <main>
    <section class="doc-section" style="margin-top:0;padding-top:0;border-top:none">
      <div class="pill">API ${escapeHtml(spec.info.version)} · générée depuis openapi.yaml</div>
      <h1>Référence API complète</h1>
      <p class="lede">Les ${totalOps} routes de l'API FlexPay, générées directement depuis la spécification OpenAPI du backend (<code class="mono">docs/openapi.yaml</code>), jamais retapées à la main, donc toujours synchronisées avec le code réel.</p>
      <div class="two-card-grid" style="margin-top:24px">
        <div class="note-card">
          <div class="title">Tester les requêtes en direct</div>
          <div class="body-text">L'explorateur Swagger interactif reste disponible pour envoyer de vraies requêtes depuis le navigateur : <a href="#" onclick="location.href=window.FLEXPAY_SWAGGER_URL;return false">ouvrir l'explorateur</a></div>
        </div>
        <div class="note-card">
          <div class="title">Générer un client (Postman, SDK...)</div>
          <div class="body-text">La spécification brute est disponible en JSON, pour l'importer dans Postman ou générer un SDK : <a href="#" onclick="location.href=window.FLEXPAY_SWAGGER_JSON_URL;return false">/docs.json</a></div>
        </div>
      </div>
    </section>

    ${sectionsHtml}
  </main>
</div>

<script>
  const sections = [...document.querySelectorAll('section.ref-tag-group[id]')];
  const tocItems = [...document.querySelectorAll('.toc-item[data-target]')];
  tocItems.forEach((item) => {
    item.addEventListener('click', () => {
      document.getElementById(item.dataset.target)?.scrollIntoView({ behavior: 'smooth' });
    });
  });
  function updateActiveToc() {
    let currentId = sections[0]?.id;
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= 100) currentId = section.id;
    }
    tocItems.forEach((item) => item.classList.toggle('active', item.dataset.target === currentId));
  }
  document.addEventListener('scroll', updateActiveToc, { passive: true });
  updateActiveToc();
</script>

</body>
</html>
`;

fs.writeFileSync(OUTPUT_PATH, html, 'utf8');
console.log(`[generate-api-reference] ${totalOps} routes écrites dans ${path.relative(process.cwd(), OUTPUT_PATH)}`);
