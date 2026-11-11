/* Cartable privacy page: language switch and the school's contact */
(() => {
  const read = () => { try { return localStorage.getItem('cartable.lang'); } catch { return null; } };
  let lang = read() || (navigator.language || 'en').slice(0, 2).toLowerCase();
  if (!['en', 'fr', 'ar'].includes(lang)) lang = 'en';
  function show(l) {
    lang = l;
    document.documentElement.lang = l;
    document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
    document.querySelectorAll('.sheet').forEach((s) => (s.hidden = s.dataset.lang !== l));
    document.querySelectorAll('[data-l]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.l === l)));
    document.title = { en: 'Privacy', fr: 'Vie privée', ar: 'الخصوصية' }[l] + ' · Cartable';
  }
  document.querySelectorAll('[data-l]').forEach((b) => b.addEventListener('click', () => {
    show(b.dataset.l);
    try { localStorage.setItem('cartable.lang', b.dataset.l); } catch {}
  }));
  show(lang);
  // the school's contact, if it set one (PRIVACY_CONTACT)
  fetch('/api/config').then((r) => r.json()).then(({ privacyContact }) => {
    if (!privacyContact) return;
    document.querySelectorAll('[data-contact]').forEach((p) => { p.textContent = p.dataset.contact.replace('{c}', privacyContact); });
  }).catch(() => {});
})();
