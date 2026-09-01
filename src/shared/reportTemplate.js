/*
 * Module partagé (UMD) : génère le HTML du rapport de maintenance.
 * Utilisé à la fois côté main process (Node, pour l'export PDF)
 * et côté renderer (simple <script>, pour l'aperçu à l'écran),
 * afin que l'aperçu et le PDF final soient toujours identiques.
 *
 * Structure du document :
 *   page 1  : couverture (logo, photo du site, site / adresse / date / technicien)
 *   page 2  : sommaire, construit dynamiquement depuis les catégories réelles
 *   page 3+ : 1. Étapes de l'intervention, puis 2. Informations du site
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ReportTemplate = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function nl2br(value) {
    return esc(value).replace(/\r?\n/g, '<br>');
  }

  function formatDateFr(isoDate) {
    if (!isoDate) return '';
    const parts = String(isoDate).split('-');
    if (parts.length !== 3) return esc(isoDate);
    const [y, m, d] = parts;
    return `${d}/${m}/${y}`;
  }

  // Une seule variable à changer pour coller à une autre charte graphique :
  // --accent pilote les filets, les titres de section et la couverture.
  const CSS = `
    @page { size: A4; }

    * { box-sizing: border-box; }

    :root {
      --accent: #1f3a5f;
      --accent-soft: #31527d;
      --ink: #111827;
      --muted: #6b7280;
      --line: #e5e7eb;
      --soft: #f8fafc;
    }

    html, body { margin: 0; padding: 0; background: #fff; }

    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      color: var(--ink);
      font-size: 10.5pt;
      line-height: 1.45;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* À l'écran (aperçu dans l'app) on simule les marges que printToPDF
       applique au PDF, pour que l'aperçu ressemble au document final. */
    @media screen {
      body { padding: 12mm 14mm 16mm 14mm; }
    }

    /* ---------- COUVERTURE ---------- */
    .cover { break-after: page; page-break-after: always; }

    .cover-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10mm;
      border-bottom: 2.5px solid var(--accent);
      padding-bottom: 5mm;
      min-height: 15mm;
    }

    .cover-logo img { height: 15mm; width: auto; display: block; }

    .cover-kicker {
      font-size: 8.5pt;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 600;
      text-align: right;
      white-space: nowrap;
    }

    .cover-media {
      margin-top: 9mm;
      height: 92mm;
      border-radius: 2mm;
      overflow: hidden;
      border: 1px solid var(--line);
      background: var(--soft);
      line-height: 0;
    }

    /* Surtout PAS d'object-fit: cover ici. Chromium re-encode alors l'image
       sans compression dans le PDF (mesure : 3,5 Mo au lieu de 0,6 Mo pour
       la meme photo), ce qui fait ramer le lecteur au defilement. La photo
       est deja recadree au bon ratio par le renderer (contain ne recadre
       donc jamais dans le cas normal), mais le cadre reste fixe a 92mm :
       une photo issue d'une ancienne fiche jamais recadree (avant l'ajout
       de cropImageToRatio) est ainsi cantonnee au bandeau au lieu de
       prendre toute la hauteur de la page. contain ne re-encode pas
       l'image, contrairement a cover : pas de regression sur le poids. */
    .cover-media img { width: 100%; height: 100%; object-fit: contain; display: block; }

    .cover-media.is-empty {
      border: none;
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-soft) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .cover-media.is-empty span {
      color: rgba(255, 255, 255, 0.85);
      font-size: 10pt;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      font-weight: 600;
    }

    .cover-title {
      margin: 13mm 0 0 0;
      font-size: 27pt;
      font-weight: 700;
      letter-spacing: -0.01em;
      line-height: 1.15;
    }

    .cover-site {
      margin-top: 2mm;
      font-size: 15pt;
      font-weight: 600;
      color: var(--accent);
    }

    .cover-meta { margin-top: 11mm; width: 100%; border-collapse: collapse; }

    .cover-meta th {
      text-align: left;
      width: 46mm;
      padding: 3mm 0;
      border-top: 1px solid var(--line);
      font-size: 8.5pt;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      vertical-align: top;
    }

    .cover-meta td {
      padding: 3mm 0;
      border-top: 1px solid var(--line);
      font-size: 11pt;
    }

    /* ---------- SOMMAIRE ---------- */
    .toc { break-after: page; page-break-after: always; }

    .page-title {
      font-size: 17pt;
      font-weight: 700;
      margin: 0 0 8mm 0;
      padding-bottom: 3mm;
      border-bottom: 2.5px solid var(--accent);
    }

    .toc-row {
      display: flex;
      align-items: baseline;
      gap: 4mm;
      padding: 3.4mm 0;
      border-bottom: 1px solid var(--line);
      font-size: 12pt;
      font-weight: 600;
    }

    .toc-row.is-sub {
      padding: 2mm 0 2mm 13mm;
      border-bottom: none;
      font-size: 10.5pt;
      font-weight: 400;
      color: var(--muted);
    }

    .toc-num { width: 12mm; flex-shrink: 0; color: var(--accent); font-weight: 700; }
    .toc-row.is-sub .toc-num { width: 14mm; color: var(--muted); font-weight: 600; }

    /* ---------- SECTIONS ---------- */
    .section + .section { break-before: page; page-break-before: always; }

    .section-title {
      font-size: 15pt;
      font-weight: 700;
      margin: 0 0 6mm 0;
      padding-bottom: 2.5mm;
      border-bottom: 2.5px solid var(--accent);
    }

    .section-title .num { color: var(--accent); margin-right: 3mm; }

    /* ---------- TABLEAUX ---------- */
    table.grid { width: 100%; border-collapse: collapse; }

    .grid thead th {
      background: var(--soft);
      text-align: left;
      padding: 2.4mm 3mm;
      font-size: 8pt;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      border-bottom: 1px solid var(--line);
    }

    .grid td {
      padding: 2.4mm 3mm;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }

    .grid tr { break-inside: avoid; page-break-inside: avoid; }

    /* Une ligne qui enveloppe un sous-tableau entier (liste d'appareils) ou
       un bloc de photos ne doit pas etre forcee a rester d'un seul tenant :
       si ce contenu ne tient pas dans l'espace restant de la page, l'avoid
       ci-dessus fait basculer TOUTE la ligne sur la page suivante et laisse
       une zone blanche derriere. Le sous-tableau et chaque photo ont deja
       leur propre break-inside: avoid plus bas ; c'est suffisant. */
    .grid tr.row-subtable,
    .grid tr.row-photos { break-inside: auto; page-break-inside: auto; }

    .col-idx { width: 9mm; color: var(--muted); font-size: 9pt; }

    /* Commentaire libre saisi sur une etape (surtout utile sur un NOK) */
    .etape-remarque {
      margin-top: 1.2mm;
      font-size: 9pt;
      color: var(--muted);
      line-height: 1.4;
    }
    /* Assez large pour "NON RENSEIGNÉ" (etat de depart d'une etape), le plus
       long des libelles possibles ici. */
    .col-status { width: 34mm; text-align: right; white-space: nowrap; }
    .row-nok td { background: #fef7f7; }

    .pill {
      display: inline-block;
      font-size: 8.5pt;
      font-weight: 700;
      letter-spacing: 0.04em;
      padding: 1mm 3.2mm;
      border-radius: 1.2mm;
    }

    .pill.ok, .pill.yes { background: #e7f6ec; color: #166534; }
    .pill.nok, .pill.no { background: #fdecec; color: #b91c1c; }
    .pill.wip { background: #fef3c7; color: #92400e; }
    .pill.neutral { background: #eef2f7; color: #334155; }

    /* Tableaux saisis dans un champ (liste d'appareils, etc.) */
    .subtable { width: 100%; border-collapse: collapse; margin: 1mm 0 2mm 0; }
    .subtable th {
      background: var(--soft);
      text-align: left;
      padding: 1.8mm 2.4mm;
      font-size: 8pt;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--muted);
      border: 1px solid var(--line);
    }
    .subtable td {
      padding: 1.8mm 2.4mm;
      border: 1px solid var(--line);
      font-size: 9.5pt;
      vertical-align: top;
    }
    .subtable tr { break-inside: avoid; page-break-inside: avoid; }

    /* ---------- CATEGORIES (informations du site) ---------- */
    .cat { margin-top: 9mm; }
    .cat:first-of-type { margin-top: 0; }

    /* Chaque categorie (sauf la premiere, deja en haut de la section)
       demarre sur une nouvelle page : plus simple a retrouver pendant
       l'intervention qu'un enchainement continu. */
    .cat + .cat {
      margin-top: 0;
      break-before: page;
      page-break-before: always;
    }

    .cat-title {
      font-size: 12pt;
      font-weight: 700;
      color: var(--accent);
      margin: 0 0 3mm 0;
    }

    .cat-title .num { margin-right: 2.5mm; }

    /* Un titre de catégorie ne doit jamais rester seul en bas de page. */
    .cat-title { break-after: avoid; page-break-after: avoid; }

    .kv td.k {
      width: 55mm;
      padding-top: 2.9mm;
      color: var(--muted);
      font-weight: 600;
      font-size: 9.5pt;
    }

    .kv td.v { color: var(--ink); }
    .kv td.k-alone { width: auto; border-bottom: none; padding-bottom: 0.5mm; }
    .kv td.table-cell-full { padding-top: 0; }
    .kv .is-empty { color: #b6bcc7; font-style: italic; }

    /* ---------- PHOTOS ---------- */
    /* display: block + photos en inline-block plutot que flex : un
       conteneur flex ne se fragmente pas proprement a l'impression dans
       Chromium (le bloc entier saute d'un seul tenant sur la page
       suivante). En inline-block, chaque photo reste indivisible (son
       propre break-inside: avoid ci-dessous) mais le groupe peut se
       repartir naturellement entre deux pages. */
    .photos {
      display: block;
      padding: 1mm 0 2mm 0;
      margin: 0;
      font-size: 0;
    }

    .photo {
      display: inline-block;
      vertical-align: top;
      width: 80mm;
      margin: 0 3mm 3mm 0;
      font-size: 10.5pt;
      border: 1px solid var(--line);
      border-radius: 1.5mm;
      overflow: hidden;
      background: var(--soft);
      break-inside: avoid;
      page-break-inside: avoid;
    }

    /* Hauteur libre : le cadre épouse la photo au lieu de la letterboxer.
       max-height borne les photos en portrait, qui sinon mangeraient la page. */
    .photo img {
      width: 100%;
      height: auto;
      max-height: 62mm;
      object-fit: contain;
      display: block;
      background: #fff;
    }

    .photo figcaption {
      font-size: 7.5pt;
      color: var(--muted);
      padding: 1.2mm 2.4mm;
      border-top: 1px solid var(--line);
      word-break: break-all;
    }

    .empty-doc { color: var(--muted); font-style: italic; }
  `;

  function renderPhotos(photos) {
    const list = Array.isArray(photos) ? photos : [];
    if (!list.length) return '';
    const items = list
      .map((p) => {
        const caption = p && p.name ? `<figcaption>${esc(p.name)}</figcaption>` : '';
        return `<figure class="photo"><img src="${esc(p.dataUrl)}" alt="${esc(p.name || 'Photo')}">${caption}</figure>`;
      })
      .join('');
    return `<div class="photos">${items}</div>`;
  }

  // ---------- Section 1 : etapes ----------
  function renderEtapesSection(etapes, num) {
    if (!etapes.length) return '';

    const rows = etapes
      .map((etape, i) => {
        // Statut a 3 valeurs (OK/NOK/EN COURS), plus un 4e etat neutre quand
        // rien n'a encore ete choisi (fiche a peine commencee). pillClass()
        // classe deja EN COURS -> "wip" pour les champs "choix" : meme regle
        // ici, pas besoin de la redupliquer.
        const statut = etape.statut === 'OK' || etape.statut === 'NOK' || etape.statut === 'EN COURS'
          ? etape.statut
          : '';
        const nok = statut === 'NOK';
        const pill = statut
          ? `<span class="pill ${pillClass(statut)}">${esc(statut)}</span>`
          : '<span class="pill neutral">NON RENSEIGNÉ</span>';
        const remarque = etape.remarques && String(etape.remarques).trim()
          ? `<div class="etape-remarque">${nl2br(etape.remarques)}</div>`
          : '';

        const main =
          `<tr class="${nok ? 'row-nok' : ''}">` +
          `<td class="col-idx">${i + 1}</td>` +
          `<td>${esc(etape.nom || '(Sans nom)')}${remarque}</td>` +
          `<td class="col-status">${pill}</td>` +
          '</tr>';

        const photosHtml = renderPhotos(etape.photos);
        const photoRow = photosHtml
          ? `<tr class="row-photos ${nok ? 'row-nok' : ''}"><td colspan="3">${photosHtml}</td></tr>`
          : '';

        return main + photoRow;
      })
      .join('');

    return `
    <section class="section">
      <h2 class="section-title"><span class="num">${num}</span>Étapes de l'intervention</h2>
      <table class="grid">
        <thead>
          <tr><th class="col-idx">#</th><th>Étape</th><th class="col-status">Statut</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }

  // ---------- Section 2 : informations du site ----------
  function fieldHasContent(field) {
    const hasPhotos = Array.isArray(field.photos) && field.photos.length > 0;
    if (hasPhotos) return true;
    // Un choix peut porter une precision libre meme sans valeur cochee
    // (ex: une remarque sur un champ laisse "non renseigne").
    if (field.type === 'choix') {
      return Boolean(String(field.valeur || '').trim()) || Boolean(String(field.remarques || '').trim());
    }
    if (field.type === 'tableau') return tableHasContent(field);
    return Boolean(field.remarques && String(field.remarques).trim());
  }

  // Regroupe les champs renseignés par catégorie, en respectant l'ordre des
  // catégories tel qu'il apparaît dans l'application.
  function groupChamps(champs, categories) {
    const documented = champs.filter(fieldHasContent);
    const grouped = {};
    const seen = [];

    documented.forEach((field) => {
      const cat = field.categorie || 'Autre';
      if (!grouped[cat]) {
        grouped[cat] = [];
        seen.push(cat);
      }
      grouped[cat].push(field);
    });

    const known = Array.isArray(categories) ? categories.filter((c) => grouped[c]) : [];
    const extra = seen.filter((c) => known.indexOf(c) === -1);
    return { order: known.concat(extra), grouped };
  }

  // Couleur de pastille deduite de la valeur choisie. OUI/NON/EN COURS
  // reprennent la logique visuelle des etapes OK/NOK ; toute autre valeur
  // (choix personnalise) tombe sur une pastille neutre.
  function pillClass(value) {
    const v = String(value || '').trim().toUpperCase();
    if (v === 'OUI' || v === 'OK' || v === 'ACTIF' || v === 'CONFORME') return 'yes';
    if (v === 'NON' || v === 'NOK' || v === 'KO' || v === 'ABSENT') return 'no';
    if (v === 'EN COURS' || v === 'PARTIEL' || v === 'A VERIFIER') return 'wip';
    return 'neutral';
  }

  function tableHasContent(field) {
    const lignes = Array.isArray(field.lignes) ? field.lignes : [];
    return lignes.some((row) => Array.isArray(row) && row.some((cell) => String(cell || '').trim()));
  }

  function renderFieldTable(field) {
    const colonnes = Array.isArray(field.colonnes) ? field.colonnes : [];
    const lignes = Array.isArray(field.lignes) ? field.lignes : [];
    const filled = lignes.filter((row) => Array.isArray(row) && row.some((cell) => String(cell || '').trim()));
    if (!colonnes.length || !filled.length) return '';

    const head = colonnes.map((c) => `<th>${esc(c)}</th>`).join('');
    const body = filled
      .map((row) => '<tr>' + colonnes.map((c, i) => `<td>${nl2br(row[i] || '')}</td>`).join('') + '</tr>')
      .join('');

    return `<table class="subtable"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  // Un champ peut n'avoir qu'une photo, sans aucun texte (ex: une photo de
  // plaque signalétique sans commentaire) : dans ce cas la cellule de valeur
  // ne doit pas afficher "Non renseigné" a cote de la photo juste en dessous,
  // ca laisserait croire que rien n'a ete releve.
  function renderFieldValue(field) {
    const hasPhotos = Array.isArray(field.photos) && field.photos.length > 0;
    const emptyLabel = hasPhotos ? '' : '<span class="is-empty">Non renseigné</span>';

    if (field.type === 'choix') {
      const value = String(field.valeur || '').trim();
      const note = field.remarques && String(field.remarques).trim()
        ? `<div class="etape-remarque">${nl2br(field.remarques)}</div>`
        : '';
      const pill = value ? `<span class="pill ${pillClass(value)}">${esc(value)}</span>` : '';
      if (!pill && !note) return emptyLabel;
      return pill + note;
    }

    if (field.type === 'tableau') {
      const table = renderFieldTable(field);
      return table || emptyLabel;
    }

    return field.remarques && String(field.remarques).trim()
      ? nl2br(field.remarques)
      : emptyLabel;
  }

  function renderCategory(cat, fields, num) {
    const rows = fields
      .map((field) => {
        const value = renderFieldValue(field);

        // Un tableau est mis sur toute la largeur : coince dans la colonne
        // de droite, ses en-tetes passent a la ligne et deviennent illisibles.
        const main = field.type === 'tableau'
          ? `<tr><td class="k k-alone" colspan="2">${esc(field.nom || '(Sans nom)')}</td></tr>` +
            `<tr class="row-subtable"><td class="table-cell-full" colspan="2">${value}</td></tr>`
          : '<tr>' +
            `<td class="k">${esc(field.nom || '(Sans nom)')}</td>` +
            `<td class="v">${value}</td>` +
            '</tr>';

        const photosHtml = renderPhotos(field.photos);
        const photoRow = photosHtml ? `<tr class="row-photos"><td colspan="2">${photosHtml}</td></tr>` : '';

        return main + photoRow;
      })
      .join('');

    return `
    <div class="cat">
      <h3 class="cat-title"><span class="num">${num}</span>${esc(cat)}</h3>
      <table class="grid kv"><tbody>${rows}</tbody></table>
    </div>`;
  }

  function renderSiteSection(order, grouped, num) {
    if (!order.length) return '';

    const cats = order
      .map((cat, i) => renderCategory(cat, grouped[cat], `${num}.${i + 1}`))
      .join('');

    return `
    <section class="section">
      <h2 class="section-title"><span class="num">${num}</span>Informations du site</h2>
      ${cats}
    </section>`;
  }

  // ---------- Sommaire ----------
  function renderToc(entries) {
    const rows = entries
      .map((entry) => {
        const cls = entry.sub ? 'toc-row is-sub' : 'toc-row';
        return `<div class="${cls}"><span class="toc-num">${esc(entry.num)}</span><span>${esc(entry.label)}</span></div>`;
      })
      .join('');

    return `
    <section class="toc">
      <h2 class="page-title">Sommaire</h2>
      <div class="toc-list">${rows}</div>
    </section>`;
  }

  // ---------- Couverture ----------
  function renderCover(data) {
    const logoHtml = data.logo
      ? `<div class="cover-logo"><img src="${esc(data.logo)}" alt="Logo"></div>`
      : '<div class="cover-logo"></div>';

    const photo = data.photo && data.photo.dataUrl ? data.photo.dataUrl : null;
    const mediaHtml = photo
      ? `<div class="cover-media"><img src="${esc(photo)}" alt="Photo du site"></div>`
      : '<div class="cover-media is-empty"><span>Photo du site non fournie</span></div>';

    // Coordonnées facultatives du technicien : n'apparaissent que si
    // renseignées, pour ne pas alourdir la couverture d'une ligne vide.
    const contactRows = [];
    if (data.telephone) contactRows.push(`<tr><th>Téléphone</th><td>${esc(data.telephone)}</td></tr>`);
    if (data.email) contactRows.push(`<tr><th>Email</th><td>${esc(data.email)}</td></tr>`);

    return `
    <section class="cover">
      <div class="cover-head">
        ${logoHtml}
        <div class="cover-kicker">Rapport d'intervention</div>
      </div>

      ${mediaHtml}

      <h1 class="cover-title">Fiche de maintenance</h1>
      <div class="cover-site">${esc(data.site)}</div>

      <table class="cover-meta">
        <tr><th>Adresse</th><td>${esc(data.adresse)}</td></tr>
        <tr><th>Date d'intervention</th><td>${formatDateFr(data.date)}</td></tr>
        <tr><th>Technicien</th><td>${esc(data.technicien)}</td></tr>
        ${contactRows.join('')}
      </table>
    </section>`;
  }

  function buildReportHtml(fiche, options) {
    const data = fiche || {};
    const opts = options || {};
    const champs = Array.isArray(data.champs) ? data.champs : [];
    // hideEtapes : version "client" du rapport (voir app.js/main.js) — le
    // déroulement de l'intervention, réservé à l'usage interne, n'y figure
    // pas. Les champs "Informations du site" restent filtrés dans tous les
    // cas : un champ jamais renseigné n'apporte rien au document.
    const etapes = opts.hideEtapes ? [] : (Array.isArray(data.etapes) ? data.etapes : []);

    const { order, grouped } = groupChamps(champs, data.categories);

    const tocEntries = [];
    let sectionNum = 0;
    let etapesHtml = '';
    let siteHtml = '';

    if (etapes.length) {
      sectionNum += 1;
      tocEntries.push({ num: String(sectionNum), label: "Étapes de l'intervention" });
      etapesHtml = renderEtapesSection(etapes, sectionNum);
    }

    if (order.length) {
      sectionNum += 1;
      tocEntries.push({ num: String(sectionNum), label: 'Informations du site' });
      order.forEach((cat, i) => {
        tocEntries.push({ num: `${sectionNum}.${i + 1}`, label: cat, sub: true });
      });
      siteHtml = renderSiteSection(order, grouped, sectionNum);
    }

    const bodyHtml = etapesHtml + siteHtml;
    const tocHtml = tocEntries.length ? renderToc(tocEntries) : '';

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Fiche de maintenance - ${esc(data.site)}</title>
<style>${CSS}</style>
</head>
<body>
${renderCover(data)}
${tocHtml}
${bodyHtml || '<p class="empty-doc">Aucune information renseignée.</p>'}
</body>
</html>`;
  }

  return { buildReportHtml };
});
