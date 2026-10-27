
import { CONFIG } from './config.js';
import { STRINGS } from './i18n.js';

// ---------------------------------------------------------------------
// Langue
// ---------------------------------------------------------------------
function storedLang() {
  try {
    return localStorage.getItem('mudawan_lang');
  } catch {
    return null;
  }
}

export let lang = ['ar', 'en'].includes(storedLang()) ? storedLang() : CONFIG.defaultLang;

export function t(key, vars = {}) {
  const s = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

// Remplit tous les éléments marqués data-i18n / data-i18n-ph.
export function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  // Nom de licence isolé (U+2066…U+2069) et insécable : sinon, dans une
  // phrase arabe, « CC BY-NC 4.0 » se coupe et ses morceaux s'inversent.
  const license = `⁦${CONFIG.corpusLicense.replace(/ /g, ' ')}⁩`;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n, { license });
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
}

export function toggleLang() {
  lang = lang === 'ar' ? 'en' : 'ar';
  try {
    localStorage.setItem('mudawan_lang', lang);
  } catch {
    /* navigateur sans stockage : la langue reviendra au défaut */
  }
  applyLang();
  document.dispatchEvent(new CustomEvent('langchange'));
}

// ---------------------------------------------------------------------
// Erreurs : traduit les erreurs de la base en message lisible
// ---------------------------------------------------------------------
export function errorMessage(err) {
  const m = `${err?.message ?? ''} ${err?.details ?? ''}`;
  if (err?.code === '23505' || m.includes('pair_key')) return t('err_duplicate');
  if (m.includes('consent_required')) return t('err_consent');
  if (m.includes('published_needs_source')) return t('err_source');
  if (m.includes('self_review')) return t('err_self_review');
  if (m.includes('reject_needs_comment')) return t('err_reject_comment');
  return t('err_generic', { msg: err?.message ?? String(err) });
}

// ---------------------------------------------------------------------
// API — version Supabase
// ---------------------------------------------------------------------
async function supabaseApi() {
  const { createClient } = await import(
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
  );
  const sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);
  const check = ({ data, error }) => {
    if (error) throw error;
    return data;
  };

  return {
    demo: false,
    async user() {
      const { data } = await sb.auth.getSession();
      return data.session?.user ?? null;
    },
    onAuthChange(cb) {
      sb.auth.onAuthStateChange((_event, session) => cb(session?.user ?? null));
    },
    async signIn(email) {
      check(
        await sb.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: location.href.split('#')[0] },
        }),
      );
    },
    async signOut() {
      await sb.auth.signOut();
    },
    async role() {
      return check(await sb.rpc('my_role'));
    },
    async stats() {
      return check(await sb.rpc('public_stats'));
    },
    async submit(pair) {
      check(await sb.from('pairs').insert(pair));
    },
    async mine(userId) {
      return check(
        await sb
          .from('pairs')
          .select('id, wolof, arabic, status, review_comment, version, created_at')
          .eq('submitted_by', userId)
          .order('created_at', { ascending: false })
          .limit(50),
      );
    },
    async pending(userId, role) {
      let q = sb
        .from('pairs')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(30);
      if (role !== 'admin') q = q.neq('submitted_by', userId);
      return check(await q);
    },
    async update(id, patch) {
      check(await sb.from('pairs').update(patch).eq('id', id));
    },
    async history(id) {
      return check(
        await sb
          .from('pair_versions')
          .select('version, action, status, comment, wolof, arabic, created_at')
          .eq('pair_id', id)
          .order('id', { ascending: true }),
      );
    },
  };
}

// ---------------------------------------------------------------------
// API — version démonstration (en mémoire, rien n'est enregistré)
// Reproduit les règles du schéma SQL pour que l'essai soit fidèle.
// ---------------------------------------------------------------------
function demoApi() {
  const me = { id: 'demo-me', email: 'demo@example.org' };
  const other = 'demo-other';
  let signedIn = false;
  let nextId = 1;
  const pairs = [];
  const versions = [];
  const listeners = [];

  const key = (p) =>
    `${p.wolof.trim().replace(/\s+/g, ' ').toLowerCase()}|${p.arabic.trim().replace(/\s+/g, ' ')}`;

  function log(p, action, author, comment = null) {
    versions.push({
      pair_id: p.id,
      version: p.version,
      action,
      status: p.status,
      comment,
      wolof: p.wolof,
      arabic: p.arabic,
      author,
      created_at: new Date().toISOString(),
    });
  }

  function insert(pair, author) {
    if (pairs.some((p) => key(p) === key(pair))) throw { code: '23505', message: 'pair_key' };
    if (['human_native', 'mt_postedit'].includes(pair.origin) && !pair.consent)
      throw { message: 'consent_required' };
    if (pair.origin === 'published' && !pair.source_title?.trim() && !pair.source_url?.trim())
      throw { message: 'published_needs_source' };
    const p = {
      ...pair,
      id: nextId++,
      status: 'pending',
      version: 1,
      submitted_by: author,
      review_comment: null,
      created_at: new Date().toISOString(),
    };
    pairs.push(p);
    log(p, 'submit', author);
  }

  insert(
    {
      wolof: 'Jàng moo gën a am solo ci dund gi.',
      arabic: 'التعلّم هو أهمّ شيء في الحياة.',
      origin: 'human_native',
      domain: 'education',
      license: 'contributor',
      consent: true,
    },
    other,
  );
  insert(
    {
      wolof: 'Ku muñ, muñ mu ñor.',
      arabic: 'من صبر ظفر.',
      origin: 'published',
      domain: 'literature',
      source_title: 'Proverbes wolof',
      license: 'unknown',
      consent: false,
    },
    other,
  );

  const notify = () => listeners.forEach((cb) => cb(signedIn ? me : null));
  const delay = (v) => new Promise((r) => setTimeout(() => r(v), 150));

  return {
    demo: true,
    async user() {
      return signedIn ? me : null;
    },
    onAuthChange(cb) {
      listeners.push(cb);
    },
    async signIn() {
      signedIn = true;
      setTimeout(notify, 600);
    },
    async signOut() {
      signedIn = false;
      notify();
    },
    async role() {
      return signedIn ? 'admin' : null;
    },
    async stats() {
      return delay({
        validated: pairs.filter((p) => p.status === 'validated').length,
        pending: pairs.filter((p) => p.status === 'pending').length,
        contributors: new Set(pairs.map((p) => p.submitted_by)).size,
      });
    },
    async submit(pair) {
      insert(pair, me.id);
      return delay();
    },
    async mine() {
      return delay(pairs.filter((p) => p.submitted_by === me.id).slice().reverse());
    },
    async pending() {
      return delay(pairs.filter((p) => p.status === 'pending'));
    },
    async update(id, patch) {
      const p = pairs.find((x) => x.id === id);
      if (patch.status === 'rejected' && !patch.review_comment?.trim())
        throw { message: 'reject_needs_comment' };
      const textChanged =
        (patch.wolof !== undefined && patch.wolof !== p.wolof) ||
        (patch.arabic !== undefined && patch.arabic !== p.arabic);
      const statusChanged = patch.status !== undefined && patch.status !== p.status;
      Object.assign(p, patch);
      if (textChanged) p.version += 1;
      if (textChanged) log(p, 'correct', me.id, p.review_comment);
      else if (statusChanged)
        log(p, p.status === 'validated' ? 'validate' : 'reject', me.id, p.review_comment);
      return delay();
    },
    async history(id) {
      return delay(versions.filter((v) => v.pair_id === id));
    },
  };
}

export const api =
  CONFIG.supabaseUrl && CONFIG.supabaseAnonKey ? await supabaseApi() : demoApi();

// ---------------------------------------------------------------------
// Petits utilitaires d'interface
// ---------------------------------------------------------------------
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastTimer;
export function toast(message, kind = 'ok') {
  const box = document.getElementById('toast');
  box.textContent = message;
  box.dataset.kind = kind;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 4500);
}

export function formatDate(iso) {
  return new Date(iso).toLocaleDateString(lang === 'ar' ? 'ar' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

// ---------------------------------------------------------------------
// En-tête : navigation, langue, connexion
// ---------------------------------------------------------------------
export async function initHeader(page) {
  document.getElementById('lang-btn').addEventListener('click', toggleLang);
  document.getElementById('signout-btn').addEventListener('click', () => api.signOut());

  if (api.demo) document.getElementById('demo-notice').hidden = false;

  document
    .querySelectorAll('[data-nav]')
    .forEach((a) => a.toggleAttribute('aria-current', a.dataset.nav === page));

  const refresh = async (user) => {
    document.getElementById('signout-btn').hidden = !user;
    const role = user ? await api.role() : null;
    document.getElementById('nav-review').hidden = !['validator', 'admin'].includes(role);
    document.dispatchEvent(new CustomEvent('authchange', { detail: { user, role } }));
  };

  api.onAuthChange(refresh);
  applyLang();
  await refresh(await api.user());
}

// Formulaire de connexion par lien email, réutilisé par les deux pages.
export function bindSignIn(form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.querySelector('input[type=email]').value.trim();
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await api.signIn(email);
      form.querySelector('.signin-sent').textContent = t('link_sent', { email });
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      button.disabled = false;
    }
  });
}
