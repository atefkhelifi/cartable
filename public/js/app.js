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

  // ---------- helpers ----------
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const at = (c, t) => new Date(`${c.date}T${t}:00`);
  const { t } = window.I18N;
  const loc = () => window.I18N.locale();
  const fmtTime = (x) => new Date(`2000-01-01T${x}:00`).toLocaleTimeString(loc(), { hour: 'numeric', minute: '2-digit', hourCycle: window.I18N.lang === 'en' ? undefined : 'h23' });
  C.t = t;
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

  C.api = async (url, opts = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (C.profile?.teacherCode) headers['x-teacher-code'] = C.profile.teacherCode;
    const res = await fetch(url, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(t(data.error || 'Something went wrong. Try again.'));
    return data;
  };

  const isTeacher = () => C.profile?.role === 'teacher';
  // joinable from 10 minutes before start until the end (teachers: anytime that day)
  C.status = (c, now = new Date()) => {
    const s = at(c, c.start), e = at(c, c.end);
    if (now >= s && now < e) return 'live';
    if (now >= e) return 'done';
    if (s - now <= 10 * 60e3) return 'soon';
    return 'later';
  };
  const canJoin = (c) => { const st = C.status(c); return st === 'live' || st === 'soon' || (isTeacher() && c.date === ymd(new Date()) && st !== 'done'); };

  async function loadCourses() {
    try { C.courses = (await C.api('/api/courses')).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)); }
    catch (e) { C.toast(e.message); }
  }

  // ---------- profile ----------
  const roleRadios = $$('input[name="role"]');
  roleRadios.forEach((r) => r.addEventListener('change', () => { $('#teacher-code-field').hidden = r.value !== 'teacher' || !r.checked; }));

  $('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#p-name').value.trim();
    const role = $('input[name="role"]:checked').value;
    const err = $('#profile-error');
    err.textContent = '';
    const p = { name, role };
    if (role === 'teacher') {
      const code = $('#p-code').value.trim();
      const { ok } = await C.api('/api/teacher/verify', { method: 'POST', body: JSON.stringify({ code }) });
      if (!ok) { err.textContent = t('That teacher code is not right. Ask your school for it, or join as a student.'); return; }
      p.teacherCode = code;
    }
    C.profile = p;
    store.set('cartable.profile', p);
    route();
  });

  $('#btn-signout').addEventListener('click', () => {
    store.del('cartable.profile');
    C.profile = null;
    location.hash = '#/today';
    route();
  });

  // ---------- routing ----------
  async function route() {
    const [, view = 'today', arg] = (location.hash || '#/today').split('/');
    if (!C.profile) {
      $$('.view, #shell, #view-room').forEach((v) => (v.hidden = true));
      $('#view-welcome').hidden = false;
      $('#p-name').focus();
      return;
    }
    $('#view-welcome').hidden = true;
    document.body.classList.toggle('is-teacher', isTeacher());
    $('#me-chip').innerHTML = `${C.avatar(C.profile.name)}<div><b>${esc(C.profile.name)}</b><small>${t(isTeacher() ? 'Teacher' : 'Student')}</small></div>`;

    if (view === 'room' && arg) {
      $('#shell').hidden = true;
      await loadCourses();
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
    if (view === 'today') renderToday();
    if (view === 'calendar') renderCalendar();
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
    $('#today-greeting').textContent = t(h < 12 ? 'Good morning, {name}' : h < 18 ? 'Good afternoon, {name}' : 'Good evening, {name}', { name: C.profile.name });
    $('#today-date').textContent = now.toLocaleDateString(loc(), { weekday: 'long', day: 'numeric', month: 'long' });

    const today = C.courses.filter((c) => c.date === ymd(now));
    const upcoming = C.courses.filter((c) => C.status(c) !== 'done');
    const next = upcoming[0];

    const nu = $('#next-up');
    if (!next) {
      nu.innerHTML = `<div class="next-empty"><h2>${t('No classes planned yet')}</h2><p>${t(isTeacher() ? 'Plan your first class in the calendar, or start one right now.' : 'When your teacher plans a class, it will show up here.')}</p></div>`;
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
            ${joinButton(next, true) || `<p class="countdown">${t('Starts in {time}', { time: relTime(ms) })}</p><p class="muted small">${t('You can join 10 minutes before.')}</p>`}
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
            ${isTeacher() ? `<button class="btn btn-ghost btn-sm" data-del="${esc(c.id)}" type="button">${t('Delete')}</button>` : ''}
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
    const del = e.target.closest('[data-del]');
    if (del) {
      const c = C.courses.find((x) => x.id === del.dataset.del);
      const sameSeries = C.courses.filter((x) => x.series === c.series).length > 1;
      const all = sameSeries && confirm(t('Delete every week of this class?\n\nOK: delete all weeks\nCancel: delete only this day'));
      try { await C.api(`/api/courses/${c.id}${all ? '?series=1' : ''}`, { method: 'DELETE' }); C.toast('Class deleted'); await loadCourses(); renderCalendar(); }
      catch (err) { C.toast(err.message); }
    }
  });

  // ---------- course dialog ----------
  const dlgCourse = $('#dlg-course');
  function openCourseDialog(date) {
    const f = $('#course-form');
    f.reset();
    f.date.value = date || ymd(new Date());
    $('#course-error').textContent = '';
    dlgCourse.showModal();
    f.title.focus();
  }
  $('#btn-new-course').addEventListener('click', () => openCourseDialog(selected));
  $('#course-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    body.teacher = C.profile.name;
    try {
      const created = await C.api('/api/courses', { method: 'POST', body: JSON.stringify(body) });
      dlgCourse.close();
      C.toast(created.length > 1 ? t('Added {n} weekly classes', { n: created.length }) : 'Class added to the calendar');
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
    v = v.replace(/[^a-z0-9-]/g, '');
    if (v.length < 3) return;
    dlgCode.close();
    location.hash = `#/room/${v}`;
  });
  $('#btn-instant').addEventListener('click', async () => {
    const { room } = await C.api('/api/new-room');
    location.hash = `#/room/${room}`;
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

  // re-render dynamic views when the language changes
  window.addEventListener('languagechange-app', () => { if (C.profile && !window.Room?.active) route(); });

  document.addEventListener('DOMContentLoaded', route);
})();
