/* Cartable — app shell: profile, routing, Today, Calendar */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  const C = (window.Cartable = { $, $$, esc, profile: store.get('cartable.profile'), courses: [] });
  // Teachers from before accounts existed signed in with a shared code; they sign in again.
  if (C.profile?.role === 'teacher' && !C.profile.token) { store.del('cartable.profile'); C.profile = null; }

  // Students only see classes whose link or code they have opened.
  const ROOM_RE = /^[a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3}$/;
  const myRooms = () => (store.get('cartable.rooms') || []).filter((r) => ROOM_RE.test(r));
  C.rememberRoom = (room) => {
    if (!ROOM_RE.test(room) || C.profile?.role === 'teacher') return;
    store.set('cartable.rooms', [room, ...myRooms().filter((r) => r !== room)].slice(0, 50));
  };

  // ---------- helpers ----------
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const at = (c, t) => new Date(`${c.date}T${t}:00`);
  const { t } = window.I18N;
  const loc = () => window.I18N.locale();
  const fmtTime = (x) => new Date(`2000-01-01T${x}:00`).toLocaleTimeString(loc(), { hour: 'numeric', minute: '2-digit', hourCycle: window.I18N.lang === 'en' ? undefined : 'h23' });
  C.t = t;
  // why a teacher gives a star ("bon point"); the server keeps the key
  C.STARS = { answer: 'Good answer', help: 'Helping others', effort: 'Hard work', listen: 'Good listening', idea: 'Great idea' };
  C.initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const AV_COLORS = ['#2F6FED', '#2BA36B', '#8B5CF6', '#F0584A', '#F29E1F', '#0E9AA7'];
  C.avColor = (n) => AV_COLORS[[...String(n)].reduce((a, c) => a + c.charCodeAt(0), 0) % AV_COLORS.length];
  C.avatar = (n) => `<span class="avatar" style="background:${C.avColor(n)}" aria-hidden="true">${esc(C.initials(n))}</span>`;

  let toastTimer;
  C.toast = (msg) => {
    const el = $('#toast');
    el.textContent = t(msg);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3200);
  };

  // ---------- "are you sure?" dialog (instead of the browser's confirm box) ----------
  // C.ask({ title, text, tone, icon, actions: [{ label, value, kind: 'ghost' | 'primary' | 'danger', focus }] })
  // resolves to the chosen action's value, or null if closed with ×, Esc or Cancel.
  const ASK_ICONS = {
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2"/>',
    record: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none"/>',
    leave: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/>',
    repeat: '<path d="M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h16M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4"/>',
    eraser: '<path d="M8 20h12M5.5 14.5l8-8a2 2 0 0 1 3 0l2 2a2 2 0 0 1 0 3L12 18H9z"/>',
    person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0M17 4l4 4M21 4l-4 4"/>',
    star: '<path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
    cc: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.5 10.2a2.4 2.4 0 1 0 0 3.6M17 10.2a2.4 2.4 0 1 0 0 3.6"/>',
  };
  C.ask = ({ title, text = '', tone = 'red', icon = 'trash', actions }) => new Promise((resolve) => {
    const d = $('#dlg-ask');
    if (d.open) d.close();
    d.className = `dialog dialog-sm tone-${tone}`;
    $('#ask-icon').innerHTML = `<svg viewBox="0 0 24 24">${ASK_ICONS[icon] || ASK_ICONS.trash}</svg>`;
    $('#ask-title').textContent = title;
    $('#ask-text').textContent = text;
    $('#ask-text').closest('.dlg-body').hidden = !text;
    const list = actions || [{ label: t('Cancel'), value: '', focus: true }, { label: t('Delete'), value: 'ok', kind: 'danger' }];
    $('#ask-actions').innerHTML = list.map((a) => `<button class="btn btn-${a.kind || 'ghost'}" value="${esc(a.value)}"${a.focus ? ' autofocus' : ''}>${esc(a.label)}</button>`).join('');
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue || null), { once: true });
    d.showModal();
  });
  // the common case: one destructive (or important) action and Cancel
  C.sure = async (title, text, okLabel, opts = {}) => (await C.ask({
    title, text, tone: opts.tone || 'red', icon: opts.icon || 'trash',
    actions: [{ label: t('Cancel'), value: '', focus: !opts.okFocus }, { label: okLabel || t('Delete'), value: 'ok', kind: opts.kind || 'danger', focus: !!opts.okFocus }],
  })) === 'ok';

  C.api = async (url, opts = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (C.profile?.token) headers.authorization = `Bearer ${C.profile.token}`;
    const res = await fetch(url, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(t(data.error || 'Something went wrong. Try again.'));
    return data;
  };

  const isTeacher = () => C.profile?.role === 'teacher';
  const isParent = () => C.profile?.role === 'parent';
  const isAdmin = () => isTeacher() && C.profile?.admin === true;
  // signed in with a code (students) or as a teacher or parent: can see homework
  const hasAccount = () => !!C.profile?.token;
  Object.assign(C, { isTeacher, isParent, isAdmin, hasAccount });
  // joinable from 10 minutes before start until the end (teachers: anytime that day)
  C.status = (c, now = new Date()) => {
    const s = at(c, c.start), e = at(c, c.end);
    if (now >= s && now < e) return 'live';
    if (now >= e) return 'done';
    if (s - now <= 10 * 60e3) return 'soon';
    return 'later';
  };
  const canJoin = (c) => { if (isParent()) return false; const st = C.status(c); return st === 'live' || st === 'soon' || (isTeacher() && c.date === ymd(new Date()) && st !== 'done'); };

  async function loadCourses(extraRoom) {
    try {
      let url = '/api/courses';
      if (!isTeacher()) {
        const rooms = myRooms();
        if (extraRoom && ROOM_RE.test(extraRoom) && !rooms.includes(extraRoom)) rooms.push(extraRoom);
        // guests with no class codes have nothing to load; signed-in students and parents get their class list's classes
        if (!rooms.length && !hasAccount()) { C.courses = []; return; }
        if (rooms.length && !isParent()) url += `?rooms=${encodeURIComponent(rooms.join(','))}`;
      }
      C.courses = (await C.api(url)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    } catch (e) { C.toast(e.message); }
  }

  // ---------- profile / sign-in ----------
  let authMode = 'login', studentMode = 'code';
  function syncWelcome() {
    const role = $('input[name="role"]:checked').value;
    const teacher = role === 'teacher', parent = role === 'parent';
    const signup = teacher && authMode === 'signup';
    const byCode = parent || (role === 'student' && studentMode === 'code');
    $('#student-mode').hidden = role !== 'student';
    $$('#student-mode [data-smode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.smode === studentMode)));
    $('#code-field').hidden = !byCode;
    $('#p-pupil-code').required = byCode;
    $('#code-label').textContent = t(parent ? 'Parent code' : 'My code');
    $('#code-hint').textContent = t(parent ? "Your child's teacher gave you this code. It starts with p-." : 'Your teacher gave you this code.');
    $('#p-pupil-code').placeholder = parent ? 'p-abcde-23456' : 'abcd-2345';
    $('#auth-mode').hidden = !teacher;
    $('#teacher-fields').hidden = !teacher;
    $('#school-code-field').hidden = !signup;
    $('#name-field').hidden = (teacher && !signup) || byCode;
    $('#p-name').required = !$('#name-field').hidden;
    $('#p-user').required = teacher;
    $('#p-pass').required = teacher;
    $('#p-code').required = signup;
    $('#p-pass').autocomplete = signup ? 'new-password' : 'current-password';
    $('#p-pass').minLength = signup ? 8 : 0;
    $('#btn-forgot').hidden = signup;
    $$('#auth-mode [data-auth]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.auth === authMode)));
    $('#profile-error').textContent = '';
  }
  const focusWelcome = () => ['#p-pupil-code', '#p-name', '#p-user'].map((x) => $(x)).find((el) => !el.closest('[hidden]'))?.focus();
  $$('input[name="role"]').forEach((r) => r.addEventListener('change', () => { syncWelcome(); focusWelcome(); }));
  $('#auth-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-auth]');
    if (b) { authMode = b.dataset.auth; syncWelcome(); }
  });
  $('#student-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-smode]');
    if (b) { studentMode = b.dataset.smode; syncWelcome(); }
  });

  $('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const role = $('input[name="role"]:checked').value;
    const err = $('#profile-error');
    err.textContent = '';
    let p;
    if (role === 'teacher') {
      const body = { username: $('#p-user').value.trim(), password: $('#p-pass').value };
      if (authMode === 'signup') Object.assign(body, { name: $('#p-name').value.trim(), schoolCode: $('#p-code').value.trim() });
      const btn = e.submitter; if (btn) btn.disabled = true;
      try {
        const res = await C.api(`/api/auth/${authMode}`, { method: 'POST', body: JSON.stringify(body) });
        p = { role, name: res.teacher.name, username: res.teacher.username, admin: res.teacher.admin, token: res.token };
      } catch (ex) { err.textContent = ex.message; return; }
      finally { if (btn) btn.disabled = false; }
      $('#p-pass').value = ''; $('#p-code').value = '';
    } else if (role === 'parent' || studentMode === 'code') {
      const btn = e.submitter; if (btn) btn.disabled = true;
      try {
        const res = await C.api('/api/auth/code', { method: 'POST', body: JSON.stringify({ code: $('#p-pupil-code').value }) });
        if (res.role !== role) {
          // a student code typed as a parent, or the other way round
          fetch('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${res.token}` } }).catch(() => {});
          err.textContent = t(res.role === 'parent' ? 'This is a parent code. Choose Parent above to use it.' : 'This is a student code. Choose Student above to use it.');
          return;
        }
        p = { role, name: res.name, token: res.token, rosterName: res.rosterName };
      } catch (ex) { err.textContent = ex.message; return; }
      finally { if (btn) btn.disabled = false; }
      $('#p-pupil-code').value = '';
    } else {
      p = { role, name: $('#p-name').value.trim() };
    }
    C.profile = p;
    store.set('cartable.profile', p);
    pushChecked = false;
    route();
  });

  function signOut() {
    // the next person on this device must not get this person's notifications
    pushOff().catch(() => {});
    if (C.profile?.token) C.api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    store.del('cartable.profile');
    C.profile = null;
    location.hash = '#/today';
    route();
  }
  $('#btn-signout').addEventListener('click', signOut);

  // ---------- passwords ----------
  // forgot: a one-time reset code from the school admin
  $('#btn-forgot').addEventListener('click', () => {
    const f = $('#reset-form');
    f.reset();
    f.username.value = $('#p-user').value.trim();
    $('#reset-error').textContent = '';
    $('#dlg-reset').showModal();
    (f.username.value ? f.code : f.username).focus();
  });
  $('#reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, btn = e.submitter;
    $('#reset-error').textContent = '';
    if (btn) btn.disabled = true;
    try {
      const res = await C.api('/api/auth/reset', { method: 'POST', body: JSON.stringify({ username: f.username.value.trim(), code: f.code.value, password: f.password.value }) });
      $('#dlg-reset').close();
      C.profile = { role: 'teacher', name: res.teacher.name, username: res.teacher.username, admin: res.teacher.admin, token: res.token };
      store.set('cartable.profile', C.profile);
      C.toast('Your new password is saved.');
      route();
    } catch (ex) { $('#reset-error').textContent = ex.message; }
    finally { if (btn) btn.disabled = false; }
  });
  // change: signed-in teacher
  $('#acc-password').addEventListener('click', () => {
    $('#dlg-account').close();
    const f = $('#password-form');
    f.reset();
    f.username.value = C.profile?.username || '';
    $('#password-error').textContent = '';
    $('#dlg-password').showModal();
    f.current.focus();
  });
  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, btn = e.submitter;
    $('#password-error').textContent = '';
    if (btn) btn.disabled = true;
    try {
      await C.api('/api/auth/password', { method: 'POST', body: JSON.stringify({ current: f.current.value, password: f.password.value }) });
      $('#dlg-password').close();
      C.toast('Your new password is saved.');
    } catch (ex) { $('#password-error').textContent = ex.message; }
    finally { if (btn) btn.disabled = false; }
  });

  // Check once per page load that a teacher's session is still valid.
  let sessionChecked = false;
  async function checkSession() {
    if (sessionChecked || !C.profile?.token) return true;
    try {
      const me = await C.api('/api/auth/me');
      sessionChecked = true;
      // an admin may have changed this teacher's role since the last visit
      if (me.teacher && me.teacher.admin !== C.profile.admin) { C.profile.admin = me.teacher.admin; store.set('cartable.profile', C.profile); }
      return true;
    }
    catch {
      store.del('cartable.profile'); C.profile = null;
      C.toast('Please sign in again.');
      return false;
    }
  }

  // ---------- my account: data export, deleting a teacher account ----------
  $('#btn-account').addEventListener('click', () => {
    $('#acc-sub').textContent = isTeacher() ? `${C.profile.name} (${C.profile.username})`
      : isParent() ? t('Parent of {name}', { name: C.profile.name }) : C.profile.name;
    $('#acc-data-text').textContent = t(isParent() ? "Everything Cartable keeps about your child, in one file (JSON)." : 'Everything Cartable keeps about you, in one file (JSON).');
    $('#dlg-account').showModal();
  });
  $('#acc-export').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      const res = await fetch('/api/my/export', { headers: { authorization: `Bearer ${C.profile.token}` } });
      if (!res.ok) throw new Error(t((await res.json().catch(() => ({}))).error || 'Something went wrong. Try again.'));
      const name = decodeURIComponent((res.headers.get('content-disposition') || '').match(/filename\*=UTF-8''([^;]+)/)?.[1] || 'Cartable.json');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30e3);
    } catch (err) { C.toast(err.message); }
    finally { b.disabled = false; }
  });
  $('#acc-delete').addEventListener('click', () => {
    $('#dlg-account').close();
    const f = $('#delete-account-form');
    f.reset();
    f.username.value = C.profile?.username || '';
    $('#delete-account-error').textContent = '';
    $('#dlg-delete-account').showModal();
  });
  $('#delete-account-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter; if (btn) btn.disabled = true;
    try {
      await C.api('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password: e.target.password.value }) });
      $('#dlg-delete-account').close();
      pushOff().catch(() => {});
      store.del('cartable.profile');
      C.profile = null;
      C.toast('Your account is deleted.');
      location.hash = '#/today';
      route();
    } catch (err) { $('#delete-account-error').textContent = err.message; }
    finally { if (btn) btn.disabled = false; }
  });

  // ---------- stars (students and parents see theirs on Today) ----------
  async function renderStars() {
    const box = $('#stars-panel');
    box.hidden = !hasAccount() || isTeacher();
    if (box.hidden) return;
    let d;
    try { d = await C.api('/api/my/stars'); } catch { box.hidden = true; return; }
    const who = isParent() ? C.profile.name : null;
    box.innerHTML = `<h2>${esc(t(who ? 'Stars of {name}' : 'My stars', { name: who }))}</h2>
      <p class="stars-count"><span class="stars-big" aria-hidden="true">★</span><b>${d.total}</b>
        <span>${esc(t(d.total === 1 ? 'star from the teacher' : 'stars from the teacher'))}</span></p>
      ${d.recent.length ? `<ul class="stars-recent">${d.recent.map((x) => `<li><span>${esc(t(C.STARS[x.reason] || ''))}</span>
        <small>${esc(new Date(x.at).toLocaleDateString(loc(), { day: 'numeric', month: 'short' }))}, ${esc(x.teacher)}</small></li>`).join('')}</ul>`
      : `<p class="muted small">${esc(t(who ? 'When the teacher gives {name} a star in class, it shows up here.' : 'When your teacher gives you a star in class, it shows up here.', { name: who }))}</p>`}`;
  }

  // ---------- routing ----------
  let pushChecked = false;
  async function route() {
    const [, view = 'today', arg] = (location.hash || '#/today').split('/');
    if (C.profile && !(await checkSession())) return route();
    if (!C.profile) {
      $$('.view, #shell, #view-room').forEach((v) => (v.hidden = true));
      $('#view-welcome').hidden = false;
      syncWelcome();
      focusWelcome();
      return;
    }
    $('#view-welcome').hidden = true;
    if (!pushChecked) { pushChecked = true; syncPush(); }
    syncRemindButton();
    document.body.classList.toggle('is-teacher', isTeacher());
    document.body.classList.toggle('is-parent', isParent());
    const roleLabel = isTeacher() ? t('Teacher') : isParent() ? t('Parent') : C.profile.rosterName ? t('Student, {list}', { list: C.profile.rosterName }) : t('Student');
    $('#me-chip').innerHTML = `${C.avatar(C.profile.name)}<div><b>${esc(isParent() ? t('Parent of {name}', { name: C.profile.name }) : C.profile.name)}</b><small>${esc(roleLabel)}</small></div>`;
    $('#nav-homework').hidden = !hasAccount();
    $('#nav-classes').hidden = !isTeacher();
    $('#nav-attendance').hidden = !isParent();
    $('#nav-marks').hidden = !isTeacher();
    $('#btn-account').hidden = !hasAccount();
    $('#nav-school').hidden = !isAdmin();

    if (view === 'room' && isParent()) { location.hash = '#/today'; return; }
    const allowed = { homework: hasAccount(), classes: isTeacher(), attendance: isParent(), school: isAdmin(), marks: isTeacher() };
    if (view in allowed && !allowed[view]) { location.hash = '#/today'; return; }
    if (view === 'room' && arg) {
      $('#shell').hidden = true;
      await loadCourses(arg);
      const course = C.courses.find((c) => c.room === arg && C.status(c) !== 'done') || C.courses.find((c) => c.room === arg);
      window.Room.open(arg, course);
      return;
    }
    if (window.Room?.active) window.Room.leave(true);
    $('#view-room').hidden = true;
    $('#shell').hidden = false;
    $$('.main > .view').forEach((v) => (v.hidden = v.id !== `view-${view}`));
    if (!$(`#view-${view}`)) { location.hash = '#/today'; return; }
    $$('.rail-link[data-nav]').forEach((a) => (a.dataset.nav === view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    await loadCourses();
    if (view === 'today') { renderToday(); renderStars(); }
    if (view === 'calendar') renderCalendar();
    if (window.School && view in allowed) window.School.show(view);
  }
  window.addEventListener('hashchange', route);
  C.route = route;

  // ---------- today ----------
  function joinButton(c, big) {
    const st = C.status(c);
    if (st === 'done') return `<span class="muted small">${t('Finished')}</span>`;
    if (canJoin(c)) return `<a class="btn btn-primary ${big ? 'btn-lg' : 'btn-sm'}" href="#/room/${esc(c.room)}">${t(st === 'live' ? 'Join now' : isTeacher() ? 'Open class' : 'Join')}</a>`;
    return big ? '' : `<span class="muted small">${fmtTime(c.start)}</span>`;
  }

  function relTime(ms) {
    const m = Math.round(ms / 60e3);
    if (m < 60) return t('{n} min', { n: m });
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? t('{h} h {m} min', { h, m: m % 60 }) : t('{h} h', { h });
    const d = Math.round(h / 24);
    return t(d > 1 ? '{n} days' : '{n} day', { n: d });
  }

  function renderToday() {
    const now = new Date();
    const h = now.getHours();
    $('#today-greeting').textContent = isParent() ? t("{name}'s day", { name: C.profile.name }) : t(h < 12 ? 'Good morning, {name}' : h < 18 ? 'Good afternoon, {name}' : 'Good evening, {name}', { name: C.profile.name });
    $('#today-date').textContent = now.toLocaleDateString(loc(), { weekday: 'long', day: 'numeric', month: 'long' });

    const today = C.courses.filter((c) => c.date === ymd(now));
    const upcoming = C.courses.filter((c) => C.status(c) !== 'done');
    const next = upcoming[0];

    const nu = $('#next-up');
    if (!next) {
      nu.innerHTML = `<div class="next-empty"><h2>${t('No classes planned yet')}</h2><p>${t(isTeacher() ? 'Plan your first class in the calendar, or start one right now.' : isParent() ? "When your child's teacher plans a class, it will show up here." : 'Open the link from your teacher, or join with a code, and your classes will show up here.')}</p></div>`;
    } else {
      const st = C.status(next);
      const ms = at(next, next.start) - now;
      const when = st === 'live' ? t('Happening now') : next.date === ymd(now) ? t('Today at {time}', { time: fmtTime(next.start) }) : t('{date} at {time}', { date: at(next, next.start).toLocaleDateString(loc(), { weekday: 'long', day: 'numeric', month: 'long' }), time: fmtTime(next.start) });
      nu.innerHTML = `
        <article class="next-card s-${esc(next.color)} ${st === 'live' ? 'is-live' : ''}">
          <div>
            <p class="when">${esc(when)}</p>
            <h2>${esc(next.title)}</h2>
            <p class="muted">${esc([t(next.subject), next.group, next.teacher].filter(Boolean).join(', '))}</p>
            ${next.notes ? `<p class="notes"><b>${t('Bring:')}</b> ${esc(next.notes)}</p>` : ''}
          </div>
          <div>
            ${joinButton(next, true) || `<p class="countdown">${t('Starts in {time}', { time: relTime(ms) })}</p>${isParent() ? '' : `<p class="muted small">${t('You can join 10 minutes before.')}</p>`}`}
          </div>
        </article>`;
    }

    $('#today-list').innerHTML = today.length
      ? today.map((c) => `
        <li class="s-${esc(c.color)} ${C.status(c) === 'done' ? 'done' : ''}">
          <span class="t">${fmtTime(c.start)}<small>${fmtTime(c.end)}</small></span>
          <span class="what"><b><i class="subject-dot"></i>${esc(c.title)}</b><small>${esc([t(c.subject), c.group].filter(Boolean).join(', '))}</small></span>
          ${joinButton(c)}
        </li>`).join('')
      : `<li class="empty">${t('Nothing on the timetable today.')}</li>`;

    const end = new Date(now); end.setDate(end.getDate() + 7);
    const week = upcoming.filter((c) => c.date !== ymd(now) && at(c, c.start) < end);
    $('#week-list').innerHTML = week.length
      ? week.map((c) => {
          const d = at(c, c.start);
          return `<li class="s-${esc(c.color)}"><span class="day"><b>${d.getDate()}</b><small>${d.toLocaleDateString(loc(), { weekday: 'short' })}</small></span>
            <span><b>${esc(c.title)}</b><br><small class="muted">${fmtTime(c.start)}, ${esc(t(c.subject))}</small></span></li>`;
        }).join('')
      : `<li class="empty">${t('Nothing else this week.')}</li>`;
  }
  setInterval(() => { if (!$('#view-today').hidden && !$('#shell').hidden) renderToday(); }, 30e3);

  // ---------- calendar ----------
  let calMonth = new Date(); calMonth.setDate(1);
  let selected = ymd(new Date());

  function renderCalendar() {
    const y = calMonth.getFullYear(), m = calMonth.getMonth();
    $('#cal-title').textContent = calMonth.toLocaleDateString(loc(), { month: 'long', year: 'numeric' });
    const first = new Date(y, m, 1);
    const offset = (first.getDay() + 6) % 7; // Monday first
    const start = new Date(y, m, 1 - offset);
    const byDay = {};
    C.courses.forEach((c) => (byDay[c.date] = byDay[c.date] || []).push(c));
    const todayStr = ymd(new Date());

    const dows = [...Array(7)].map((_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(loc(), { weekday: 'short' }));
    let html = dows.map((d) => `<div class="cal-dow" role="columnheader">${esc(d)}</div>`).join('');
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const k = ymd(d);
      const items = byDay[k] || [];
      const cls = ['cal-day', d.getMonth() !== m && 'out', k === todayStr && 'today', (d.getDay() === 0 || d.getDay() === 6) && 'weekend'].filter(Boolean).join(' ');
      html += `<button type="button" role="gridcell" class="${cls}" data-day="${k}" aria-selected="${k === selected}" aria-label="${esc(t('{date}, {n} classes', { date: d.toLocaleDateString(loc(), { weekday: 'long', day: 'numeric', month: 'long' }), n: items.length }))}">
        <span class="n">${d.getDate()}</span>
        ${items.slice(0, 3).map((c) => `<span class="chip s-${esc(c.color)}">${fmtTime(c.start)} ${esc(c.title)}</span>`).join('')}
        ${items.length > 3 ? `<span class="more">${t('+{n} more', { n: items.length - 3 })}</span>` : ''}
      </button>`;
    }
    $('#cal-grid').innerHTML = html;
    renderDayPanel();
  }

  function renderDayPanel() {
    const d = new Date(selected + 'T00:00:00');
    const items = C.courses.filter((c) => c.date === selected);
    $('#day-panel').innerHTML = `
      <h2>${esc(d.toLocaleDateString(loc(), { weekday: 'long', day: 'numeric', month: 'long' }))}</h2>
      <p class="sub">${items.length ? t(items.length > 1 ? '{n} classes' : '1 class', { n: items.length }) : t('No classes')}</p>
      ${items.length ? `<ul class="day-items">${items.map((c) => `
        <li class="day-item s-${esc(c.color)}">
          <h3>${esc(c.title)}</h3>
          <p class="meta">${t('{start} to {end}', { start: fmtTime(c.start), end: fmtTime(c.end) })}${c.subject ? `, ${esc(t(c.subject))}` : ''}${c.group ? `, ${esc(c.group)}` : ''}<br>${esc(t('With {name}', { name: c.teacher }))}</p>
          ${c.notes ? `<p class="notes"><b>${t('Bring:')}</b> ${esc(c.notes)}</p>` : ''}
          <div class="acts">
            ${C.status(c) !== 'done' ? joinButton(c) : ''}
            <button class="btn btn-ghost btn-sm" data-copy="${esc(c.room)}" type="button">${t('Copy link')}</button>
            <button class="btn btn-ghost btn-sm" data-files="${esc(c.room)}" type="button">${t('Files')}</button>
            ${isTeacher() ? `<button class="btn btn-ghost btn-sm" data-edit="${esc(c.id)}" type="button">${t('Edit')}</button>
            <button class="btn btn-ghost btn-sm" data-del="${esc(c.id)}" type="button">${t('Delete')}</button>` : ''}
          </div>
        </li>`).join('')}</ul>` : isTeacher() ? `<button class="btn btn-ghost" id="day-plan" type="button">${t('Plan a class on this day')}</button>` : ''}`;
  }

  $('#cal-grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-day]');
    if (!b) return;
    selected = b.dataset.day;
    $$('.cal-day').forEach((x) => x.setAttribute('aria-selected', x === b));
    renderDayPanel();
  });
  $('#cal-prev').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() - 1); renderCalendar(); });
  $('#cal-next').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() + 1); renderCalendar(); });
  $('#cal-today').addEventListener('click', () => { calMonth = new Date(); calMonth.setDate(1); selected = ymd(new Date()); renderCalendar(); });

  C.inviteLink = (room) => `${location.origin}/#/room/${room}`;
  $('#day-panel').addEventListener('click', async (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) { await navigator.clipboard?.writeText(C.inviteLink(copy.dataset.copy)).catch(() => {}); C.toast('Invite link copied'); }
    if (e.target.id === 'day-plan') openCourseDialog(selected);
    const files = e.target.closest('[data-files]');
    if (files) {
      const c = C.courses.find((x) => x.room === files.dataset.files);
      C.openFiles(files.dataset.files, c?.title, isTeacher());
    }
    const edit = e.target.closest('[data-edit]');
    if (edit) openCourseDialog(null, C.courses.find((x) => x.id === edit.dataset.edit));
    const del = e.target.closest('[data-del]');
    if (del) {
      const c = C.courses.find((x) => x.id === del.dataset.del);
      const sameSeries = C.courses.filter((x) => x.series === c.series).length > 1;
      const choice = await C.ask(sameSeries ? {
        title: t('Delete “{title}”?', { title: c.title }),
        text: t('This class happens every week. Delete only this day, or every week?'),
        actions: [
          { label: t('Cancel'), value: '', focus: true },
          { label: t('Only this day'), value: 'one' },
          { label: t('Every week'), value: 'all', kind: 'danger' },
        ],
      } : {
        title: t('Delete “{title}”?', { title: c.title }),
        text: t('It disappears from the calendar for everyone.'),
      });
      if (!choice) return;
      const all = choice === 'all';
      try { await C.api(`/api/courses/${c.id}${all ? '?series=1' : ''}`, { method: 'DELETE' }); C.toast('Class deleted'); await loadCourses(); renderCalendar(); }
      catch (err) { C.toast(err.message); }
    }
  });

  // ---------- course dialog ----------
  const dlgCourse = $('#dlg-course');
  let editing = null; // the class being edited, or null when planning a new one
  function openCourseDialog(date, course) {
    const f = $('#course-form');
    f.reset();
    editing = course || null;
    if (editing) {
      for (const k of ['title', 'subject', 'group', 'date', 'start', 'end', 'notes']) f[k].value = editing[k] || '';
      f.querySelector(`input[name="color"][value="${editing.color}"]`)?.click();
      f.waitingRoom.checked = !!editing.waitingRoom;
    } else {
      f.date.value = date || ymd(new Date());
    }
    $('#repeat-field').hidden = !!editing;
    // class lists for the "Class list" choice
    const sel = $('#course-roster');
    sel.length = 1;
    C.api('/api/rosters').then((list) => {
      for (const r of list) sel.add(new Option(r.name, r.id));
      sel.value = editing?.rosterId || '';
    }).catch(() => {});
    $('#course-dlg-title').textContent = t(editing ? 'Edit class' : 'Plan a class');
    $('#course-submit').textContent = t(editing ? 'Save changes' : 'Add to calendar');
    $('#course-error').textContent = '';
    dlgCourse.showModal();
    f.title.focus();
  }
  $('#btn-new-course').addEventListener('click', () => openCourseDialog(selected));
  $('#course-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    body.waitingRoom = e.target.waitingRoom.checked;
    try {
      if (editing) {
        // A new date only applies to this day; otherwise ask about the other weeks.
        const weeks = C.courses.filter((x) => x.series === editing.series).length;
        let all = false;
        if (weeks > 1 && body.date === editing.date) {
          const choice = await C.ask({
            title: t('Change every week?'),
            text: t('“{title}” happens every week. Save the changes for this day only, or for every week?', { title: editing.title }),
            tone: 'blue', icon: 'repeat',
            actions: [
              { label: t('Cancel'), value: '' },
              { label: t('Only this day'), value: 'one' },
              { label: t('Every week'), value: 'all', kind: 'primary', focus: true },
            ],
          });
          if (!choice) return;
          all = choice === 'all';
        }
        await C.api(`/api/courses/${editing.id}${all ? '?series=1' : ''}`, { method: 'PATCH', body: JSON.stringify(body) });
        dlgCourse.close();
        C.toast('Class updated');
      } else {
        const created = await C.api('/api/courses', { method: 'POST', body: JSON.stringify(body) });
        dlgCourse.close();
        C.toast(created.length > 1 ? t('Added {n} weekly classes', { n: created.length }) : 'Class added to the calendar');
      }
      editing = null;
      selected = body.date;
      calMonth = new Date(body.date + 'T00:00:00'); calMonth.setDate(1);
      await loadCourses();
      renderCalendar();
    } catch (err) { $('#course-error').textContent = err.message; }
  });
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  // ---------- join by code / instant class ----------
  const dlgCode = $('#dlg-code');
  $('#btn-join-code').addEventListener('click', () => { $('#code-form').reset(); dlgCode.showModal(); });
  $('#code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    let v = $('#code-input').value.trim().toLowerCase();
    const m = v.match(/#\/room\/([a-z0-9-]+)/);
    if (m) v = m[1];
    v = v.replace(/[^a-z0-9]/g, '');
    if (v.length !== 9) { C.toast('A class code looks like abc-def-ghi.'); return; }
    v = `${v.slice(0, 3)}-${v.slice(3, 6)}-${v.slice(6)}`;
    dlgCode.close();
    location.hash = `#/room/${v}`;
  });
  $('#btn-instant').addEventListener('click', async () => {
    try {
      const { room } = await C.api('/api/rooms', { method: 'POST' });
      location.hash = `#/room/${room}`;
    } catch (err) { C.toast(err.message); }
  });

  // ---------- .ics export ----------
  $('#btn-ics').addEventListener('click', () => {
    const stamp = (c, t) => `${c.date.replace(/-/g, '')}T${t.replace(':', '')}00`;
    const escI = (s) => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cartable//Open Classroom//EN', 'CALSCALE:GREGORIAN'];
    C.courses.forEach((c) => lines.push('BEGIN:VEVENT', `UID:${c.id}@cartable`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
      `DTSTART:${stamp(c, c.start)}`, `DTEND:${stamp(c, c.end)}`, `SUMMARY:${escI(c.title)}`,
      `DESCRIPTION:${escI([t(c.subject), c.group, c.notes && t('Bring:') + ' ' + c.notes, t('Join: {link}', { link: C.inviteLink(c.room) })].filter(Boolean).join('\n'))}`,
      `URL:${C.inviteLink(c.room)}`, 'END:VEVENT'));
    lines.push('END:VCALENDAR');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar' }));
    a.download = 'cartable-classes.ics';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------- class files (shared by the calendar and the live class) ----------
  const dlgFiles = $('#dlg-files');
  let filesRoom = null, filesManage = false;
  const fmtSize = (n) => (n < 1024 * 1024 ? t('{n} KB', { n: Math.max(1, Math.round(n / 1024)) }) : t('{n} MB', { n: (n / 1048576).toFixed(1) }));
  async function renderFiles() {
    const room = filesRoom;
    let list;
    try { list = await C.api(`/api/rooms/${encodeURIComponent(room)}/files`); }
    catch (err) { $('#file-list').innerHTML = `<li class="empty">${esc(err.message)}</li>`; return; }
    if (room !== filesRoom) return;
    $('#file-list').innerHTML = list.length ? list.map((f) => {
      const ext = (f.name.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
      return `<li>
        <span class="ic" aria-hidden="true">${esc(ext.slice(0, 4))}</span>
        <span class="nm"><a href="/api/files/${esc(f.id)}" download>${esc(f.name)}</a>
          <small>${esc(fmtSize(f.size))}, ${esc(new Date(f.at).toLocaleDateString(loc(), { day: 'numeric', month: 'short' }))}</small></span>
        ${filesManage ? `<button class="del" type="button" data-del-file="${esc(f.id)}">${t('Delete')}</button>` : ''}
      </li>`;
    }).join('') : `<li class="empty">${t(filesManage ? 'No files yet. Share worksheets, pictures or slides with the class.' : 'Your teacher has not shared any files yet.')}</li>`;
  }
  C.openFiles = (room, title, canManage) => {
    filesRoom = room;
    filesManage = !!canManage;
    $('#files-title').textContent = title ? t('Files for {title}', { title }) : t('Class files');
    $('#files-pick').hidden = !filesManage;
    $('#file-list').innerHTML = '';
    if (!dlgFiles.open) dlgFiles.showModal();
    renderFiles();
  };
  C.refreshFiles = (room) => { if (dlgFiles.open && room === filesRoom) renderFiles(); };
  dlgFiles.addEventListener('close', () => { filesRoom = null; });
  $('#files-input').addEventListener('change', async (e) => {
    const picked = [...e.target.files];
    e.target.value = '';
    for (const f of picked) {
      if (f.size > 10 * 1024 * 1024) { C.toast(t('{name} is too big (10 MB max).', { name: f.name })); continue; }
      C.toast(t('Sharing {name}…', { name: f.name }));
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(filesRoom)}/files`, {
          method: 'POST',
          headers: { 'content-type': f.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(f.name), authorization: `Bearer ${C.profile.token}` },
          body: f,
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(t(d.error || 'Something went wrong. Try again.'));
        C.toast(t('{name} is shared with the class.', { name: f.name }));
      } catch (err) { C.toast(err.message); }
    }
    renderFiles();
  });
  $('#file-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del-file]');
    if (!b) return;
    const name = b.closest('li').querySelector('a').textContent;
    if (!(await C.sure(t('Delete {name}?', { name }), t('It disappears for everyone in the class.')))) return;
    try { await C.api(`/api/files/${b.dataset.delFile}`, { method: 'DELETE' }); renderFiles(); }
    catch (err) { C.toast(err.message); }
  });

  // ---------- notifications ----------
  // Signed in (teacher, student with a code, parent): real push notifications from the server, even when
  // Cartable is closed: classes about to start, new homework, marks. Guests: reminders while Cartable is open.
  const REMIND_MIN = 5;
  const canPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let pushOn = false;
  const swReady = () => ('serviceWorker' in navigator ? navigator.serviceWorker.ready : Promise.reject(new Error('no service worker')));
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('service worker', err));
  }
  async function pushSubscription() {
    if (!canPush()) return null;
    try { return await (await swReady()).pushManager.getSubscription(); } catch { return null; }
  }
  async function pushOnServer(sub) {
    await C.api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON(), lang: window.I18N.lang }) });
  }
  async function pushEnable() {
    const { key } = await C.api('/api/push/key');
    const reg = await swReady();
    const sub = (await reg.pushManager.getSubscription())
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)) });
    await pushOnServer(sub);
    pushOn = true;
  }
  async function pushOff() {
    const sub = await pushSubscription();
    pushOn = false;
    if (!sub) return;
    await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  // On each visit: is this device subscribed? Re-send it, so the server has the right person and language.
  async function syncPush() {
    const sub = hasAccount() && canPush() && Notification.permission === 'granted' ? await pushSubscription() : null;
    pushOn = !!sub;
    if (sub) pushOnServer(sub).catch(() => {});
    syncRemindButton();
  }

  const reminded = new Set(store.get('cartable.reminded') || []);
  const localOn = () => !hasAccount() && store.get('cartable.remind') === true && 'Notification' in window && Notification.permission === 'granted';
  const syncRemindButton = () => $('#btn-remind').setAttribute('aria-pressed', String(pushOn || localOn()));
  $('#btn-remind').addEventListener('click', async () => {
    if (!('Notification' in window)) return C.toast('This browser cannot show notifications.');
    if (pushOn) { await pushOff(); syncRemindButton(); return C.toast('Notifications are off on this device.'); }
    if (localOn()) { store.set('cartable.remind', false); syncRemindButton(); return C.toast('Class reminders are off.'); }
    const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (p !== 'granted') return C.toast('Notifications are blocked. Allow them for this site in your browser settings.');
    if (hasAccount() && canPush()) {
      try {
        await pushEnable();
        syncRemindButton();
        return C.toast(isTeacher() ? t('You will get a notification {n} minutes before each of your classes.', { n: REMIND_MIN })
          : 'You will get a notification before each class, and for new homework and marks.');
      } catch (err) {
        console.warn('push', err);
        // iPhone and iPad: push only works once Cartable is added to the home screen
        if (/iPad|iPhone|iPod/.test(navigator.userAgent) && !navigator.standalone) return C.toast('On iPhone and iPad, first add Cartable to your home screen (Share, then Add to Home Screen).');
        if (hasAccount()) return C.toast('Notifications could not be turned on. Try again later.');
      }
    }
    store.set('cartable.remind', true);
    syncRemindButton();
    C.toast(t('You will get a reminder {n} minutes before each class while Cartable is open.', { n: REMIND_MIN }));
  });
  let coursesLoadedAt = Date.now();
  async function checkReminders() {
    syncRemindButton();
    if (!C.profile || !localOn() || window.Room?.active) return;
    if (Date.now() - coursesLoadedAt > 5 * 60e3) { coursesLoadedAt = Date.now(); await loadCourses(); }
    const now = Date.now();
    for (const c of C.courses) {
      const ms = at(c, c.start) - now;
      if (ms <= 0 || ms > REMIND_MIN * 60e3 || reminded.has(c.id)) continue;
      reminded.add(c.id);
      store.set('cartable.reminded', [...reminded].slice(-200));
      const n = new Notification(t('{title} starts in {n} min', { title: c.title, n: Math.max(1, Math.round(ms / 60e3)) }), {
        body: t(isTeacher() ? 'Click to open the class.' : 'Click to join the class.'), tag: `cartable-${c.id}`,
      });
      n.onclick = () => { window.focus(); location.hash = `#/room/${c.room}`; n.close(); };
    }
  }
  setInterval(checkReminders, 30e3);

  // re-render dynamic views when the language changes
  window.addEventListener('languagechange-app', () => { if (C.profile && !window.Room?.active) route(); if (pushOn) syncPush(); });

  document.addEventListener('DOMContentLoaded', route);
})();
