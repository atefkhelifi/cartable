/* Cartable — class lists with sign-in codes, homework, and the parent view */
(() => {
  const C = window.Cartable;
  const { $, $$, esc } = C;
  const t = (k, v) => C.t(k, v);
  const loc = () => window.I18N.locale();
  const S = (window.School = {});

  const fmtDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString(loc(), { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtWhen = (iso) => new Date(iso).toLocaleString(loc(), { dateStyle: 'medium', timeStyle: 'short' });
  const fmtSize = (n) => (n < 1048576 ? t('{n} KB', { n: Math.max(1, Math.round(n / 1024)) }) : t('{n} MB', { n: (n / 1048576).toFixed(1) }));
  const endOfDay = (d) => new Date(`${d}T23:59:59`);
  const isLate = (due, at) => (at ? new Date(at) : new Date()) > endOfDay(due);
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // Homework files need the sign-in token, so they are fetched and saved as a download.
  async function download(id, name) {
    try {
      const res = await fetch(`/api/hwfiles/${id}`, { headers: { authorization: `Bearer ${C.profile.token}` } });
      if (!res.ok) throw new Error(t((await res.json().catch(() => ({}))).error || 'Something went wrong. Try again.'));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30e3);
    } catch (err) { C.toast(err.message); }
  }
  async function uploadFiles(url, files) {
    for (const f of files) {
      if (f.size > 10 * 1024 * 1024) { C.toast(t('{name} is too big (10 MB max).', { name: f.name })); continue; }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': f.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(f.name), authorization: `Bearer ${C.profile.token}` },
        body: f,
      });
      if (!res.ok) C.toast(t((await res.json().catch(() => ({}))).error || 'Something went wrong. Try again.'));
    }
  }
  const fileList = (files, canDelete) => files.length ? `<ul class="file-list">${files.map((f) => {
    const ext = (f.name.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
    return `<li><span class="ic" aria-hidden="true">${esc(ext.slice(0, 4))}</span>
      <span class="nm"><a href="#" data-dl="${esc(f.id)}" data-name="${esc(f.name)}">${esc(f.name)}</a><small>${esc(fmtSize(f.size))}</small></span>
      ${canDelete ? `<button class="del" type="button" data-rmfile="${esc(f.id)}">${t('Delete')}</button>` : ''}</li>`;
  }).join('')}</ul>` : '';

  S.show = (view) => {
    if (view === 'homework') showHomework();
    if (view === 'classes') showRosters();
    if (view === 'attendance') showAttendance();
  };

  // =====================================================================
  // HOMEWORK
  // =====================================================================
  let hwList = [], hwSel = null, subSel = null;

  function statusOf(h) {
    if (C.isTeacher()) return { cls: '', text: t('{a} of {b} handed in, {c} marked', { a: h.handed, b: h.total, c: h.marked }) };
    if (h.markedAt) return { cls: 'ok', text: h.mark ? t('Marked: {mark}', { mark: h.mark }) : t('Marked') };
    if (h.submittedAt) return { cls: 'ok', text: t(isLate(h.due, h.submittedAt) ? 'Handed in late' : 'Handed in') };
    if (isLate(h.due)) return { cls: 'late', text: t('Late') };
    return { cls: 'todo', text: t('To do') };
  }

  async function showHomework() {
    $('#hw-sub').textContent = C.isTeacher() ? t('Give homework to a class list, then mark what comes back.')
      : C.isParent() ? t("{name}'s homework", { name: C.profile.name }) : t('What your teacher asked you to do.');
    try { hwList = await C.api('/api/homework'); } catch (err) { C.toast(err.message); hwList = []; }
    if (hwSel && !hwList.some((h) => h.id === hwSel)) hwSel = null;
    if (!hwSel && hwList.length && window.matchMedia('(min-width: 861px)').matches) hwSel = hwList[0].id;
    renderHwList();
    renderHwDetail();
  }

  function renderHwList() {
    const today = ymd(new Date());
    $('#hw-list').innerHTML = hwList.length ? hwList.map((h) => {
      const s = statusOf(h);
      return `<li><button type="button" class="hw-item${h.id === hwSel ? ' sel' : ''}" data-hw="${esc(h.id)}" aria-current="${h.id === hwSel}">
        <b>${esc(h.title)}</b>
        <small>${C.isTeacher() ? esc(h.rosterName) + ', ' : ''}${esc(t(h.due < today ? 'Was due {date}' : 'Due {date}', { date: fmtDay(h.due) }))}</small>
        <span class="chip-status ${s.cls}">${esc(s.text)}</span>
      </button></li>`;
    }).join('') : `<li class="empty">${t(C.isTeacher() ? 'No homework yet. Use "Give homework" to set some.' : 'No homework right now.')}</li>`;
  }
  $('#hw-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hw]');
    if (!b) return;
    hwSel = b.dataset.hw; subSel = null;
    renderHwList(); renderHwDetail();
    $('#hw-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  async function renderHwDetail() {
    const box = $('#hw-detail');
    if (!hwSel) { box.innerHTML = `<p class="muted">${t(hwList.length ? 'Choose homework to see it here.' : 'Nothing to show yet.')}</p>`; return; }
    let h;
    try { h = await C.api(`/api/homework/${hwSel}`); } catch (err) { box.innerHTML = `<p class="muted">${esc(err.message)}</p>`; return; }
    const head = `<header class="hw-head">
        <h2>${esc(h.title)}</h2>
        <p class="muted">${esc(h.rosterName)}, ${esc(t('due {date}', { date: fmtDay(h.due) }))}</p>
      </header>
      ${h.instructions ? `<p class="hw-text">${esc(h.instructions)}</p>` : ''}`;
    if (h.as === 'teacher') return renderTeacherHw(box, h, head);
    renderPupilHw(box, h, head);
  }

  // ---- student / parent ----
  function renderPupilHw(box, h, head) {
    const s = h.submission;
    const student = h.as === 'student';
    const marked = !!s?.markedAt;
    const handed = !!s?.submittedAt;
    let state;
    if (marked) state = t('Marked on {date}.', { date: fmtWhen(s.markedAt) });
    else if (handed) state = t(isLate(h.due, s.submittedAt) ? 'Handed in late on {date}.' : 'Handed in on {date}.', { date: fmtWhen(s.submittedAt) });
    else state = t(isLate(h.due) ? 'Not handed in, and the due date has passed.' : 'Not handed in yet.');

    box.innerHTML = `${head}
      ${h.files.length ? `<h3 class="sub">${t('From the teacher')}</h3>${fileList(h.files, false)}` : ''}
      ${marked ? `<div class="mark-box"><b>${esc(s.mark || t('Marked'))}</b>${s.feedback ? `<p>${esc(s.feedback)}</p>` : ''}</div>` : ''}
      <h3 class="sub">${t(student ? 'My work' : "{name}'s work", { name: C.profile.name })}</h3>
      <p class="hw-state">${esc(state)}</p>
      ${student && !marked ? `
        <form class="stack" id="work-form">
          <label class="field"><span>${t('Write your answer (optional)')}</span><textarea name="text" rows="6" maxlength="10000">${esc(s?.text || '')}</textarea></label>
          ${s ? fileList(s.files, true) : ''}
          <label class="btn btn-ghost btn-sm file-btn">${t('Add a file or photo…')}<input type="file" id="work-files" multiple hidden></label>
          <div class="row">
            ${handed ? `<button class="btn btn-primary" type="submit" data-act="save">${t('Update my work')}</button>
                       <button class="btn btn-ghost" type="submit" data-act="unsubmit">${t('Take it back')}</button>`
                     : `<button class="btn btn-primary" type="submit" data-act="handin">${t('Hand in')}</button>
                       <button class="btn btn-ghost" type="submit" data-act="save">${t('Save without handing in')}</button>`}
          </div>
        </form>`
      : s ? `${s.text ? `<p class="hw-text">${esc(s.text)}</p>` : ''}${fileList(s.files, false)}` : ''}`;

    const form = $('#work-form');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const act = e.submitter?.dataset.act || 'save';
      const handIn = act === 'handin' ? true : act === 'unsubmit' ? false : undefined;
      try {
        await C.api(`/api/homework/${h.id}/submission`, { method: 'PUT', body: JSON.stringify({ text: form.text.value, handIn }) });
        C.toast(act === 'handin' ? 'Handed in. Well done!' : act === 'unsubmit' ? 'Taken back. Hand it in again when it is ready.' : 'Saved.');
        await showHomework();
      } catch (err) { C.toast(err.message); }
    });
    $('#work-files').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      // keep what was typed: save the text first, then add the files
      await C.api(`/api/homework/${h.id}/submission`, { method: 'PUT', body: JSON.stringify({ text: form.text.value }) }).catch(() => {});
      await uploadFiles(`/api/homework/${h.id}/files`, files);
      renderHwDetail();
    });
  }

  // ---- teacher ----
  function renderTeacherHw(box, h, head) {
    const rows = h.students.map((s) => {
      const st = s.markedAt ? { cls: 'ok', text: s.mark ? t('Marked: {mark}', { mark: s.mark }) : t('Marked') }
        : s.submittedAt ? { cls: isLate(h.due, s.submittedAt) ? 'late' : 'ok', text: t(isLate(h.due, s.submittedAt) ? 'Handed in late' : 'Handed in') }
        : { cls: 'todo', text: t('Not handed in') };
      return `<li><button type="button" class="stu-row${s.submissionId && s.submissionId === subSel ? ' sel' : ''}" ${s.submissionId ? `data-sub="${esc(s.submissionId)}"` : 'disabled'}>
        ${C.avatar(s.name)}<span class="nm">${esc(s.name)}</span><span class="chip-status ${st.cls}">${esc(st.text)}</span></button></li>`;
    }).join('');
    box.innerHTML = `${head}
      ${fileList(h.files, true)}
      <div class="row">
        <label class="btn btn-ghost btn-sm file-btn">${t('Attach a file…')}<input type="file" id="hw-more-files" multiple hidden></label>
        <button class="btn btn-ghost btn-sm" type="button" id="hw-edit">${t('Edit')}</button>
        <button class="btn btn-ghost btn-sm" type="button" id="hw-delete">${t('Delete')}</button>
      </div>
      <h3 class="sub">${t('Students')}</h3>
      ${h.students.length ? `<ul class="stu-list">${rows}</ul>` : `<p class="muted">${t('This class list has no students yet.')}</p>`}
      <div id="sub-view"></div>`;
    $('#hw-more-files').addEventListener('change', async (e) => { const f = [...e.target.files]; e.target.value = ''; await uploadFiles(`/api/homework/${h.id}/files`, f); renderHwDetail(); });
    $('#hw-edit').addEventListener('click', () => openHwDialog(h));
    $('#hw-delete').addEventListener('click', async () => {
      if (!(await C.sure(t('Delete “{title}”?', { title: h.title }), t('All the work students handed in for it is deleted too.')))) return;
      try { await C.api(`/api/homework/${h.id}`, { method: 'DELETE' }); hwSel = null; C.toast('Homework deleted'); showHomework(); }
      catch (err) { C.toast(err.message); }
    });
    if (subSel) renderSubmission(h);
  }
  async function renderSubmission(h) {
    const view = $('#sub-view');
    if (!view) return;
    let s;
    try { s = await C.api(`/api/submissions/${subSel}`); } catch (err) { view.innerHTML = `<p class="muted">${esc(err.message)}</p>`; return; }
    view.innerHTML = `<section class="sub-card">
      <h3>${esc(s.student)}</h3>
      <p class="muted small">${s.submittedAt ? esc(t(isLate(h.due, s.submittedAt) ? 'Handed in late on {date}.' : 'Handed in on {date}.', { date: fmtWhen(s.submittedAt) })) : t('Not handed in yet (draft).')}</p>
      ${s.text ? `<p class="hw-text">${esc(s.text)}</p>` : `<p class="muted">${t('No written answer.')}</p>`}
      ${fileList(s.files, false)}
      <form class="stack" id="mark-form">
        <div class="row">
          <label class="field mark-field"><span>${t('Mark')}</span><input name="mark" maxlength="20" value="${esc(s.mark)}" placeholder="${esc(t('e.g. 18/20 or ⭐⭐⭐'))}"></label>
        </div>
        <label class="field"><span>${t('Comment for the student')}</span><textarea name="feedback" rows="3" maxlength="2000">${esc(s.feedback)}</textarea></label>
        <div class="row end"><button class="btn btn-primary" type="submit">${t(s.markedAt ? 'Update mark' : 'Save mark')}</button></div>
      </form>
    </section>`;
    $('#mark-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await C.api(`/api/submissions/${s.id}`, { method: 'PATCH', body: JSON.stringify({ mark: e.target.mark.value, feedback: e.target.feedback.value }) });
        C.toast(t('Mark saved for {name}.', { name: s.student }));
        hwList = await C.api('/api/homework'); renderHwList(); renderHwDetail();
      } catch (err) { C.toast(err.message); }
    });
    view.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  $('#hw-detail').addEventListener('click', async (e) => {
    const dl = e.target.closest('[data-dl]');
    if (dl) { e.preventDefault(); download(dl.dataset.dl, dl.dataset.name); return; }
    const rm = e.target.closest('[data-rmfile]');
    if (rm) {
      if (!(await C.sure(t('Delete {name}?', { name: rm.closest('li').querySelector('a').textContent }), t('This cannot be undone.')))) return;
      try { await C.api(`/api/hwfiles/${rm.dataset.rmfile}`, { method: 'DELETE' }); renderHwDetail(); } catch (err) { C.toast(err.message); }
      return;
    }
    const sb = e.target.closest('[data-sub]');
    if (sb) { subSel = sb.dataset.sub; renderHwDetail(); }
  });

  // ---- the "give homework" dialog ----
  let hwEditing = null;
  async function openHwDialog(h) {
    hwEditing = h || null;
    const f = $('#hw-form');
    f.reset();
    $('#hw-error').textContent = '';
    let rosters = [];
    try { rosters = await C.api('/api/rosters'); } catch {}
    if (!rosters.length && !h) {
      C.toast('First make a class list, then you can give homework to it.');
      location.hash = '#/classes';
      return;
    }
    const sel = $('#hw-roster');
    sel.innerHTML = rosters.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
    sel.disabled = !!h; // homework stays with its class list
    $('#hw-attach-field').hidden = !!h;
    $('#hw-dlg-title').textContent = t(h ? 'Edit homework' : 'Give homework');
    $('#hw-submit').textContent = t(h ? 'Save changes' : 'Give homework');
    if (h) { sel.value = h.rosterId; f.title.value = h.title; f.instructions.value = h.instructions; f.due.value = h.due; }
    else { const d = new Date(); d.setDate(d.getDate() + 7); f.due.value = ymd(d); }
    $('#dlg-hw').showModal();
    f.title.focus();
  }
  $('#btn-new-hw').addEventListener('click', () => openHwDialog());
  $('#hw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { rosterId: f.rosterId.value, title: f.title.value, instructions: f.instructions.value, due: f.due.value };
    try {
      if (hwEditing) {
        await C.api(`/api/homework/${hwEditing.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        const { id } = await C.api('/api/homework', { method: 'POST', body: JSON.stringify(body) });
        await uploadFiles(`/api/homework/${id}/files`, [...$('#hw-attach').files]);
        hwSel = id; subSel = null;
      }
      $('#dlg-hw').close();
      C.toast(hwEditing ? 'Homework updated' : 'Homework given to the class');
      showHomework();
    } catch (err) { $('#hw-error').textContent = err.message; }
  });

  // =====================================================================
  // CLASS LISTS (teacher)
  // =====================================================================
  let rosters = [], rosterSel = null;

  async function showRosters() {
    try { rosters = await C.api('/api/rosters'); } catch (err) { C.toast(err.message); rosters = []; }
    if (rosterSel && !rosters.some((r) => r.id === rosterSel)) rosterSel = null;
    if (!rosterSel && rosters.length) rosterSel = rosters[0].id;
    renderRosterList();
    renderRoster();
  }
  function renderRosterList() {
    $('#roster-list').innerHTML = rosters.length ? rosters.map((r) => `<li><button type="button" class="hw-item${r.id === rosterSel ? ' sel' : ''}" data-roster="${esc(r.id)}" aria-current="${r.id === rosterSel}">
        <b>${esc(r.name)}</b><small>${esc(t(r.students === 1 ? '1 student' : '{n} students', { n: r.students }))}</small></button></li>`).join('')
      : `<li class="empty">${t('No class lists yet. Add one below, for example "Year 3 Blue".')}</li>`;
  }
  $('#roster-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-roster]');
    if (b) { rosterSel = b.dataset.roster; renderRosterList(); renderRoster(); }
  });
  $('#roster-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await C.api('/api/rosters', { method: 'POST', body: JSON.stringify({ name: e.target.name.value }) });
      e.target.reset();
      rosterSel = r.id;
      showRosters();
    } catch (err) { C.toast(err.message); }
  });

  async function renderRoster() {
    const box = $('#roster-detail');
    const r = rosters.find((x) => x.id === rosterSel);
    if (!r) { box.innerHTML = `<p class="muted">${t('Make a class list to add students.')}</p>`; return; }
    let students = [];
    try { students = await C.api(`/api/rosters/${r.id}/students`); } catch (err) { C.toast(err.message); }
    box.innerHTML = `
      <form class="row roster-name" id="roster-rename">
        <label class="field"><span>${t('Name of the class list')}</span><input name="name" maxlength="60" value="${esc(r.name)}" required></label>
        <button class="btn btn-ghost btn-sm" type="submit">${t('Rename')}</button>
        <button class="btn btn-ghost btn-sm" type="button" id="roster-delete">${t('Delete list')}</button>
      </form>
      <h3 class="sub">${t('Students')}</h3>
      ${students.length ? `<ul class="stu-list">${students.map((s) => `<li class="stu-row">
          ${C.avatar(s.name)}<span class="nm">${esc(s.name)}<small>${s.lastSeen ? esc(t('Last in class {date}', { date: fmtWhen(s.lastSeen) })) : esc(t('Not in a class yet'))}</small></span>
          <span class="acts">
            <button class="btn btn-ghost btn-sm" type="button" data-codes="${esc(s.id)}" data-name="${esc(s.name)}">${t('New codes')}</button>
            <button class="btn btn-ghost btn-sm" type="button" data-rmstu="${esc(s.id)}" data-name="${esc(s.name)}">${t('Remove')}</button>
          </span></li>`).join('')}</ul>
        <button class="btn btn-ghost btn-sm" type="button" id="codes-all">${t('New codes for everyone (and print)')}</button>`
      : `<p class="muted">${t('No students yet.')}</p>`}
      <form class="stack add-students" id="add-students">
        <label class="field"><span>${t('Add students, one name per line')}</span><textarea name="names" rows="4" placeholder="${esc(t('Lina\nSami\nYasmine'))}"></textarea></label>
        <div class="row end"><button class="btn btn-primary" type="submit">${t('Add and make codes')}</button></div>
      </form>`;

    $('#roster-rename').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await C.api(`/api/rosters/${r.id}`, { method: 'PATCH', body: JSON.stringify({ name: e.target.name.value }) }); C.toast('Saved.'); showRosters(); }
      catch (err) { C.toast(err.message); }
    });
    $('#roster-delete').addEventListener('click', async () => {
      if (!(await C.sure(t('Delete the class list “{name}”?', { name: r.name }),
        t('Its students, their codes, its homework and all work handed in are deleted. Classes in the calendar stay.'), t('Delete list')))) return;
      try { await C.api(`/api/rosters/${r.id}`, { method: 'DELETE' }); rosterSel = null; showRosters(); } catch (err) { C.toast(err.message); }
    });
    $('#add-students').addEventListener('submit', async (e) => {
      e.preventDefault();
      const names = e.target.names.value.split('\n').map((n) => n.trim()).filter(Boolean);
      if (!names.length) return C.toast('Write at least one name.');
      try {
        const made = await C.api(`/api/rosters/${r.id}/students`, { method: 'POST', body: JSON.stringify({ names }) });
        showCodes(made, r.name);
        showRosters();
      } catch (err) { C.toast(err.message); }
    });
    $('#codes-all')?.addEventListener('click', async () => {
      if (!(await C.sure(t('New codes for everyone in “{name}”?', { name: r.name }),
        t('Every student and parent gets a new code. The old codes stop working right away.'), t('Make new codes'),
        { tone: 'yellow', icon: 'key', kind: 'primary' }))) return;
      const out = [];
      for (const s of students) {
        try { out.push(await C.api(`/api/students/${s.id}/codes`, { method: 'POST', body: JSON.stringify({ which: 'both' }) })); } catch {}
      }
      showCodes(out, r.name);
    });
  }
  $('#roster-detail').addEventListener('click', async (e) => {
    const c = e.target.closest('[data-codes]');
    if (c) {
      if (!(await C.sure(t('New codes for {name}?', { name: c.dataset.name }),
        t('{name} and their parent get new codes. The old codes stop working right away.', { name: c.dataset.name }), t('Make new codes'),
        { tone: 'yellow', icon: 'key', kind: 'primary' }))) return;
      try { showCodes([await C.api(`/api/students/${c.dataset.codes}/codes`, { method: 'POST', body: JSON.stringify({ which: 'both' }) })], rosters.find((x) => x.id === rosterSel)?.name); }
      catch (err) { C.toast(err.message); }
    }
    const rm = e.target.closest('[data-rmstu]');
    if (rm) {
      if (!(await C.sure(t('Remove {name}?', { name: rm.dataset.name }), t('Their homework and codes are deleted.'), t('Remove'), { icon: 'person' }))) return;
      try { await C.api(`/api/students/${rm.dataset.rmstu}`, { method: 'DELETE' }); showRosters(); } catch (err) { C.toast(err.message); }
    }
  });

  // ---- code cards (shown once) ----
  function codeCards(list, listName) {
    const site = location.origin;
    return list.map((s) => `<article class="code-card">
        <h3>${esc(s.name)}</h3>
        <p class="small muted">${esc(listName || '')}</p>
        ${s.code ? `<p><span class="small">${t('Student code')}</span><code>${esc(s.code)}</code></p>` : ''}
        ${s.parentCode ? `<p><span class="small">${t('Parent code')}</span><code>${esc(s.parentCode)}</code></p>` : ''}
        <p class="small">${esc(t('Go to {site}, choose Student (or Parent) and type the code.', { site }))}</p>
      </article>`).join('');
  }
  function showCodes(list, listName) {
    if (!list.length) return;
    $('#code-cards').innerHTML = codeCards(list, listName);
    $('#print-cards').innerHTML = codeCards(list, listName);
    $('#dlg-codes').showModal();
  }
  $('#codes-print').addEventListener('click', () => window.print());
  $('#dlg-codes').addEventListener('close', () => { $('#code-cards').innerHTML = ''; $('#print-cards').innerHTML = ''; });

  // =====================================================================
  // ATTENDANCE (parent)
  // =====================================================================
  async function showAttendance() {
    let list = [];
    try { list = await C.api('/api/my/attendance'); } catch (err) { C.toast(err.message); }
    $('#att-sub').textContent = t('Live classes {name} joined while signed in with their code.', { name: C.profile.name });
    $('#my-att-list').innerHTML = list.length ? list.map((a) => `<li><span>${esc(a.title || t('Live class'))}</span><span class="muted">${esc(fmtWhen(a.at))}</span></li>`).join('')
      : `<li>${t('No classes joined yet.')}</li>`;
  }
})();
