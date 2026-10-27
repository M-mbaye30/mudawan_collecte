
import { api, t, el, toast, errorMessage, formatDate, initHeader, bindSignIn } from './common.js';

const queue = document.getElementById('queue');
const signinForm = document.getElementById('signin-form');
const forbidden = document.getElementById('forbidden');
let state = { user: null, role: null };

bindSignIn(signinForm);

function metaLine(p) {
  const parts = [
    t(`origin_${p.origin}`),
    t(`domain_${p.domain}`),
    p.source_title || p.source_url
      ? `${t('source')}: ${[p.source_title, p.source_url].filter(Boolean).join(', ')}`
      : null,
    formatDate(p.created_at),
  ];
  return el('p', { class: 'row-meta' }, parts.filter(Boolean).map((s) => el('span', {}, s)));
}

// Historique, chargé seulement quand on ouvre le volet.
function historyBlock(p) {
  const list = el('ol', { class: 'history-list' });
  const details = el(
    'details',
    { class: 'history' },
    el('summary', {}, t('history')),
    list,
  );
  details.addEventListener('toggle', async () => {
    if (!details.open || list.childElementCount) return;
    const rows = await api.history(p.id);
    list.replaceChildren(
      ...rows.map((v) =>
        el(
          'li',
          {},
          el('span', { class: 'history-act' }, `${t(`act_${v.action}`)} (v${v.version})`),
          el('span', { class: 'history-date' }, formatDate(v.created_at)),
          el('span', { class: 'history-text', lang: 'ar', dir: 'rtl' }, v.arabic),
          el('span', { class: 'history-text', lang: 'wo', dir: 'ltr' }, v.wolof),
          v.comment ? el('span', { class: 'comment' }, v.comment) : null,
        ),
      ),
    );
  });
  return details;
}

function card(p) {
  const wo = el('textarea', { lang: 'wo', dir: 'ltr', rows: 3 }, p.wolof);
  const ar = el('textarea', { lang: 'ar', dir: 'rtl', rows: 3 }, p.arabic);
  const comment = el('textarea', { class: 'comment-input', rows: 2 });
  const errorBox = el('p', { class: 'form-error', role: 'alert' });

  const validateBtn = el('button', { type: 'button', class: 'primary' }, t('btn_validate'));
  const rejectBtn = el('button', { type: 'button', class: 'danger' }, t('btn_reject'));

  // Le bouton principal change de nom dès que le texte est modifié,
  // pour que le validateur sache ce qu'il enregistre.
  const edited = () => wo.value.trim() !== p.wolof || ar.value.trim() !== p.arabic;
  const syncLabel = () => (validateBtn.textContent = t(edited() ? 'btn_save_validate' : 'btn_validate'));
  wo.addEventListener('input', syncLabel);
  ar.addEventListener('input', syncLabel);

  const item = el(
    'li',
    { class: 'review-card' },
    el(
      'div',
      { class: 'facing facing-input' },
      el('label', { class: 'side side-wo' }, el('span', { class: 'side-label' }, t('side_wolof')), wo),
      el('span', { class: 'spine', 'aria-hidden': 'true' }),
      el('label', { class: 'side side-ar' }, el('span', { class: 'side-label' }, t('side_arabic')), ar),
    ),
    metaLine(p),
    el('label', { class: 'field' }, el('span', {}, t('comment_label')), comment),
    errorBox,
    el('div', { class: 'actions' }, validateBtn, rejectBtn),
    historyBlock(p),
  );

  async function act(status) {
    const patch = { status, review_comment: comment.value.trim() || null };
    if (status === 'rejected' && !patch.review_comment) {
      errorBox.textContent = t('err_reject_comment');
      comment.focus();
      return;
    }
    if (status === 'validated' && edited()) {
      patch.wolof = wo.value.trim();
      patch.arabic = ar.value.trim();
    }
    validateBtn.disabled = rejectBtn.disabled = true;
    try {
      await api.update(p.id, patch);
      toast(t(status === 'validated' ? 'validated_toast' : 'rejected_toast'));
      item.remove();
      if (!queue.childElementCount) showEmpty();
    } catch (err) {
      errorBox.textContent = errorMessage(err);
      validateBtn.disabled = rejectBtn.disabled = false;
    }
  }

  validateBtn.addEventListener('click', () => act('validated'));
  rejectBtn.addEventListener('click', () => act('rejected'));
  return item;
}

function showEmpty() {
  queue.replaceChildren(el('li', { class: 'empty' }, t('review_empty')));
}

async function load() {
  const { user, role } = state;
  signinForm.hidden = !!user;
  const allowed = ['validator', 'admin'].includes(role);
  forbidden.hidden = !user || allowed;
  if (!user || !allowed) {
    queue.replaceChildren();
    return;
  }
  const rows = await api.pending(user.id, role);
  if (!rows.length) return showEmpty();
  queue.replaceChildren(...rows.map(card));
}

document.addEventListener('authchange', (e) => {
  state = e.detail;
  load();
});
document.addEventListener('langchange', load);

await initHeader('review');
