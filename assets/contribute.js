
import { CONFIG } from './config.js';
import { api, t, el, toast, errorMessage, formatDate, initHeader, bindSignIn } from './common.js';

const form = document.getElementById('pair-form');
const signinForm = document.getElementById('signin-form');
const submitBtn = document.getElementById('submit-btn');
const formError = document.getElementById('form-error');
let currentUser = null;

// --- Exemple en tête de page -----------------------------------------
const sample = CONFIG.samples[Math.floor(Math.random() * CONFIG.samples.length)];
document.getElementById('hero-wo').textContent = sample.wolof;
document.getElementById('hero-ar').textContent = sample.arabic;

// --- Compteurs ---------------------------------------------------------
async function loadStats() {
  try {
    const s = await api.stats();
    document.getElementById('stat-validated').textContent = s.validated;
    document.getElementById('stat-pending').textContent = s.pending;
    document.getElementById('stat-contributors').textContent = s.contributors;
  } catch {
    /* les compteurs restent à « – » */
  }
}

// --- Champs qui dépendent de la provenance -----------------------------
// Traduction publiée : source obligatoire, licence de la source demandée,
// pas de consentement (ce n'est pas le travail du contributeur).
// Sinon : la traduction est celle du contributeur, il consent à la publier.
function syncOrigin() {
  const published = form.origin.value === 'published';
  document.getElementById('license-field').hidden = !published;
  document.getElementById('consent-field').hidden = published;
  document.getElementById('source-opt').hidden = published;
}
form.addEventListener('change', (e) => {
  if (e.target.name === 'origin') syncOrigin();
});

// --- Soumission ---------------------------------------------------------
function readForm() {
  const published = form.origin.value === 'published';
  return {
    wolof: form.wolof.value.trim(),
    arabic: form.arabic.value.trim(),
    origin: form.origin.value,
    domain: form.domain.value,
    source_title: form.source_title.value.trim() || null,
    source_url: form.source_url.value.trim() || null,
    license: published ? form.license.value : 'contributor',
    consent: published ? false : form.consent.checked,
  };
}

// Mêmes règles que la base, vérifiées avant l'envoi pour un message immédiat.
function validate(p) {
  if (!p.wolof || !p.arabic) return t('err_empty');
  if (p.origin === 'published' && !p.source_title && !p.source_url) return t('err_source');
  if (p.origin !== 'published' && !p.consent) return t('err_consent');
  return null;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pair = readForm();
  const problem = validate(pair);
  formError.textContent = problem ?? '';
  if (problem) return;

  submitBtn.disabled = true;
  try {
    await api.submit(pair);
    // On garde la provenance, le domaine et la source : on saisit souvent
    // plusieurs phrases d'un même texte d'affilée.
    form.wolof.value = '';
    form.arabic.value = '';
    form.wolof.focus();
    toast(t('submitted'));
    loadStats();
    loadMine();
  } catch (err) {
    formError.textContent = errorMessage(err);
  } finally {
    submitBtn.disabled = false;
  }
});

// --- Mes paires ---------------------------------------------------------
async function loadMine() {
  const section = document.getElementById('mine');
  if (!currentUser) {
    section.hidden = true;
    return;
  }
  const rows = await api.mine(currentUser.id);
  const list = document.getElementById('mine-list');
  list.replaceChildren(
    ...(rows.length
      ? rows.map((p) =>
          el(
            'li',
            { class: 'pair-row' },
            el(
              'div',
              { class: 'facing facing-small' },
              el('p', { class: 'side side-wo', lang: 'wo', dir: 'ltr' }, p.wolof),
              el('span', { class: 'spine', 'aria-hidden': 'true' }),
              el('p', { class: 'side side-ar', lang: 'ar', dir: 'rtl' }, p.arabic),
            ),
            el(
              'p',
              { class: 'row-meta' },
              el('span', { class: `status status-${p.status}` }, t(`status_${p.status}`)),
              el('span', {}, formatDate(p.created_at)),
              p.review_comment ? el('span', { class: 'comment' }, p.review_comment) : null,
            ),
          ),
        )
      : [el('li', { class: 'empty' }, t('mine_empty'))]),
  );
  section.hidden = false;
}

// --- Connexion ------------------------------------------------------------
bindSignIn(signinForm);

document.addEventListener('authchange', (e) => {
  currentUser = e.detail.user;
  submitBtn.hidden = !currentUser;
  signinForm.hidden = !!currentUser;
  loadMine();
});

document.addEventListener('langchange', () => loadMine());

syncOrigin();
loadStats();
await initHeader('contribute');
