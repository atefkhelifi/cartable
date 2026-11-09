/* Cartable — live classroom: WebRTC mesh video, screen share, chat, whiteboard */
(() => {
  const C = window.Cartable;
  const { $, $$, esc } = C;
  const ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
  const BOARD_W = 1600, BOARD_H = 1000;

  const R = (window.Room = { active: false });
  let socket, myId, myRole, code, course;
  let camStream = null, screenTrack = null;
  let micOn = true, camOn = true, hand = false;
  let joinedAt = 0, clockTimer, speakTimer, audioCtx;
  let boardLocked = false, roomLocked = false;
  let spotId = null, pinnedId = null, boardBig = false;
  const peers = new Map(); // id -> { pc, stream, info, tile, pending: [], analyser }

  // ---------- media ----------
  const audioTrack = () => camStream?.getAudioTracks()[0] || null;
  const camTrack = () => camStream?.getVideoTracks()[0] || null;
  const outVideo = () => screenTrack || camTrack();

  async function getMedia() {
    for (const c of [{ audio: true, video: { width: 1280, height: 720 } }, { audio: true }, { video: true }]) {
      try { return await navigator.mediaDevices.getUserMedia(c); } catch {}
    }
    return null;
  }

  // ---------- pre-join ----------
  R.open = async (roomCode, c) => {
    if (R.active && code === roomCode) return;
    if (R.active) R.leave(true);
    code = roomCode; course = c;
    $('#prejoin-title').textContent = c ? `Ready for ${c.title}?` : 'Ready to join?';
    const dlg = $('#dlg-prejoin');
    if (!navigator.mediaDevices?.getUserMedia) {
      C.toast('Camera and microphone need a secure (https) connection.');
    } else if (!camStream) {
      camStream = await getMedia();
    }
    const v = $('#prejoin-video');
    v.srcObject = camStream;
    $('#prejoin-nocam').hidden = !!camTrack();
    v.hidden = !camTrack();
    $('#pj-mic').disabled = !audioTrack();
    $('#pj-cam').disabled = !camTrack();
    dlg.returnValue = '';
    dlg.showModal();
    dlg.addEventListener('close', function once() {
      dlg.removeEventListener('close', once);
      v.srcObject = null;
      if (dlg.returnValue === 'join') {
        micOn = $('#pj-mic').checked && !!audioTrack();
        camOn = $('#pj-cam').checked && !!camTrack();
        join();
      } else {
        stopMedia();
        location.hash = '#/today';
      }
    });
  };

  // ---------- join ----------
  function join() {
    R.active = true;
    $('#view-room').hidden = false;
    $('#room-name').textContent = course?.title || 'Live class';
    $('#room-meta').textContent = [course?.subject, course?.group, `Code ${code}`].filter(Boolean).join(', ');
    $('#chat-log').innerHTML = '';
    $('#tiles').innerHTML = '';
    if (audioTrack()) audioTrack().enabled = micOn;
    if (camTrack()) camTrack().enabled = camOn;
    setPressed('#btn-mic', micOn); setPressed('#btn-cam', camOn); setPressed('#btn-hand', false); setPressed('#btn-share', false);
    hand = false;
    selectTab('chat');
    setupBoard();

    socket = io({ transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      socket.emit('join', { room: code, name: C.profile.name, role: C.profile.role, teacherCode: C.profile.teacherCode }, (res) => {
        if (res.error) { C.toast(res.error); R.leave(); return; }
        myId = res.id; myRole = res.role;
        document.body.classList.toggle('is-teacher', myRole === 'teacher');
        addTile('me', { name: C.profile.name, role: myRole, mic: micOn, cam: camOn, hand: false }, camStream, true);
        sendState();
        applyFlags(res);
        res.strokes.forEach(drawStroke);
        res.peers.forEach((p) => { createPeer(p.id, p); call(p.id); });
        joinedAt = Date.now();
        clockTimer = setInterval(tickClock, 1000); tickClock();
        speakTimer = setInterval(detectSpeaking, 250);
        sys('You joined the class.');
        renderPeople();
      });
    });

    socket.on('peer-joined', (p) => { createPeer(p.id, p); sys(`${p.name} joined.`); renderPeople(); });
    socket.on('peer-left', ({ id }) => { const p = peers.get(id); if (p) sys(`${p.info.name} left.`); removePeer(id); });
    socket.on('peer-state', (s) => {
      if (s.id === myId) return;
      const p = peers.get(s.id); if (!p) return;
      const raised = !p.info.hand && s.hand;
      p.info = { ...p.info, ...s };
      updateTile(s.id);
      renderPeople();
      if (raised) { sys(`${s.name} raised their hand ✋`); if (myRole === 'teacher') C.toast(`${s.name} raised their hand`); }
      updateSpotlight();
    });
    socket.on('signal', onSignal);
    socket.on('chat', onChat);
    socket.on('react', ({ name, emoji }) => floatReaction(emoji, name));
    socket.on('draw', drawStroke);
    socket.on('clear-board', clearBoard);
    socket.on('room-flags', applyFlags);
    socket.on('force-mute', () => { if (micOn) { toggleMic(); C.toast('The teacher muted your microphone'); } });
    socket.on('force-lower-hand', () => { if (hand) { toggleHand(); C.toast('The teacher lowered your hand'); } });
    socket.on('removed', () => { C.toast('The teacher removed you from the class.'); R.leave(); });
    socket.on('ended', () => { C.toast('The teacher ended the class. See you next time!'); R.leave(); });
    socket.on('disconnect', (reason) => { if (R.active && reason !== 'io client disconnect') sys('Connection lost. Trying to reconnect…'); });
  }

  // ---------- peers ----------
  function createPeer(id, info) {
    if (peers.has(id)) return peers.get(id);
    const pc = new RTCPeerConnection(ICE);
    const stream = new MediaStream();
    const p = { pc, stream, info, pending: [] };
    peers.set(id, p);
    pc.onicecandidate = (e) => e.candidate && socket.emit('signal', { to: id, data: { candidate: e.candidate } });
    pc.ontrack = (e) => {
      stream.addTrack(e.track);
      const v = p.tile?.querySelector('video');
      if (v) { v.srcObject = null; v.srcObject = stream; }
      if (e.track.kind === 'audio') attachAnalyser(p);
      updateSpotlight();
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') pc.restartIce?.(); };
    addTile(id, info, stream, false);
    return p;
  }

  async function call(id) {
    const { pc } = peers.get(id);
    pc.addTransceiver(audioTrack() || 'audio', { direction: 'sendrecv' });
    pc.addTransceiver(outVideo() || 'video', { direction: 'sendrecv' });
    await pc.setLocalDescription(await pc.createOffer());
    socket.emit('signal', { to: id, data: { sdp: pc.localDescription } });
  }

  async function onSignal({ from, data }) {
    const p = peers.get(from) || createPeer(from, { name: 'Guest', role: 'student' });
    const pc = p.pc;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          const [ta, tv] = pc.getTransceivers();
          if (ta) { ta.direction = 'sendrecv'; await ta.sender.replaceTrack(audioTrack()); }
          if (tv) { tv.direction = 'sendrecv'; await tv.sender.replaceTrack(outVideo()); }
          await pc.setLocalDescription(await pc.createAnswer());
          socket.emit('signal', { to: from, data: { sdp: pc.localDescription } });
        }
        for (const c of p.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else p.pending.push(data.candidate);
      }
    } catch (err) { console.warn('signal error', err); }
  }

  function removePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    p.pc.close();
    p.tile?.remove();
    peers.delete(id);
    if (pinnedId === id) pinnedId = null;
    updateSpotlight(); renderPeople(); layoutTiles();
  }

  const videoSenders = () => [...peers.values()].map((p) => p.pc.getTransceivers()[1]?.sender).filter(Boolean);

  // ---------- tiles ----------
  const MIC_OFF = '<svg viewBox="0 0 24 24" aria-label="Microphone off"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16"/></svg>';

  function addTile(id, info, stream, mine) {
    const el = document.createElement('div');
    el.className = 'tile' + (mine ? ' me' : '');
    el.dataset.id = id;
    el.innerHTML = `<video autoplay playsinline ${mine ? 'muted' : ''}></video>
      <div class="ph">${C.avatar(info.name)}</div>
      <div class="tile-name"></div>
      <button class="btn btn-ghost btn-sm pin" type="button">Pin</button>`;
    const v = el.querySelector('video');
    v.srcObject = stream;
    el.querySelector('.pin').addEventListener('click', () => { pinnedId = pinnedId === id ? null : id; boardBig = false; updateSpotlight(); });
    if (mine) $('#tiles').prepend(el); else $('#tiles').append(el);
    if (mine) R.meInfo = info; else peers.get(id).tile = el;
    updateTile(id);
    layoutTiles();
  }

  function infoOf(id) { return id === 'me' ? { ...R.meInfo, mic: micOn, cam: camOn || !!screenTrack, hand, sharing: !!screenTrack } : peers.get(id)?.info; }
  function tileOf(id) { return id === 'me' ? $('.tile.me') : peers.get(id)?.tile; }

  function updateTile(id) {
    const el = tileOf(id), i = infoOf(id);
    if (!el || !i) return;
    el.classList.toggle('cam-on', !!(i.cam || i.sharing));
    el.classList.toggle('hand', !!i.hand);
    el.classList.toggle('sharing', !!i.sharing);
    el.querySelector('.tile-name').innerHTML = `${i.mic === false ? MIC_OFF : ''}<span>${esc(i.name)}${id === 'me' ? ' (you)' : ''}</span>${i.role === 'teacher' ? '<span class="role">Teacher</span>' : ''}`;
    let flag = el.querySelector('.hand-flag');
    if (i.hand && !flag) { flag = document.createElement('span'); flag.className = 'hand-flag'; flag.textContent = '✋'; el.append(flag); }
    if (!i.hand && flag) flag.remove();
    el.querySelector('.pin').textContent = pinnedId === id ? 'Unpin' : 'Pin';
  }

  function layoutTiles() {
    const n = $('#tiles').children.length;
    $('#people-count').textContent = n;
  }

  function updateSpotlight() {
    const sharer = [...peers].find(([, p]) => p.info.sharing)?.[0] || (screenTrack ? 'me' : null);
    const target = boardBig ? 'board' : pinnedId || sharer;
    const spot = $('#spotlight');
    if (target === spotId && target !== null && target !== 'board' && spot.querySelector('video')?.srcObject) return;
    // return the board if it was out on the stage
    if (target !== 'board' && spot.contains($('#board'))) $('#board-wrap').append($('#board'));
    spotId = target;
    $('#stage').classList.toggle('has-spot', !!target);
    spot.hidden = !target;
    if (!target) { spot.innerHTML = ''; return; }
    if (target === 'board') {
      spot.innerHTML = '';
      spot.append($('#board'));
      $('#board-big').textContent = 'Back to panel';
      return;
    }
    $('#board-big').textContent = 'Show big';
    const stream = target === 'me' ? (screenTrack ? new MediaStream([screenTrack]) : camStream) : peers.get(target)?.stream;
    const i = infoOf(target);
    spot.innerHTML = `<video autoplay playsinline muted></video><div class="tile-name"><span>${esc(i?.name || '')}${i?.sharing ? ' is sharing their screen' : ''}</span></div>`;
    spot.querySelector('video').srcObject = stream;
    $$('.tile').forEach((t) => updateTile(t.dataset.id));
  }

  // ---------- speaking indicator ----------
  function attachAnalyser(p) {
    try {
      audioCtx = audioCtx || new AudioContext();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const src = audioCtx.createMediaStreamSource(new MediaStream(p.stream.getAudioTracks()));
      const an = audioCtx.createAnalyser(); an.fftSize = 512;
      src.connect(an);
      p.analyser = an;
    } catch {}
  }
  let meAnalyser;
  function detectSpeaking() {
    if (!meAnalyser && audioTrack()) attachAnalyser((meAnalyser = { stream: camStream }));
    const level = (an) => { if (!an) return 0; const d = new Uint8Array(an.fftSize); an.getByteTimeDomainData(d); let s = 0; for (const x of d) s += (x - 128) ** 2; return Math.sqrt(s / d.length); };
    $('.tile.me')?.classList.toggle('speaking', micOn && level(meAnalyser?.analyser) > 6);
    peers.forEach((p) => p.tile?.classList.toggle('speaking', p.info.mic !== false && level(p.analyser) > 6));
  }

  // ---------- controls ----------
  function setPressed(sel, v) { $(sel).setAttribute('aria-pressed', String(v)); }
  function sendState() { socket?.emit('state', { mic: micOn, cam: camOn, hand, sharing: !!screenTrack }); updateTile('me'); renderPeople(); }

  function toggleMic() {
    if (!audioTrack()) return C.toast('No microphone found.');
    micOn = !micOn; audioTrack().enabled = micOn; setPressed('#btn-mic', micOn); sendState();
  }
  function toggleCam() {
    if (!camTrack()) return C.toast('No camera found.');
    camOn = !camOn; camTrack().enabled = camOn; setPressed('#btn-cam', camOn); sendState();
  }
  function toggleHand() {
    hand = !hand;
    setPressed('#btn-hand', hand);
    $('#hand-label').textContent = hand ? 'Lower hand' : 'Raise hand';
    sendState();
  }
  async function toggleShare() {
    if (screenTrack) return stopShare();
    if (!navigator.mediaDevices?.getDisplayMedia) return C.toast('Screen sharing is not supported on this device.');
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
      screenTrack = s.getVideoTracks()[0];
      screenTrack.onended = stopShare;
      await Promise.all(videoSenders().map((x) => x.replaceTrack(screenTrack)));
      $('.tile.me video').srcObject = new MediaStream([screenTrack]);
      setPressed('#btn-share', true);
      sendState(); updateSpotlight();
    } catch { /* user cancelled */ }
  }
  async function stopShare() {
    if (!screenTrack) return;
    screenTrack.onended = null; screenTrack.stop(); screenTrack = null;
    await Promise.all(videoSenders().map((x) => x.replaceTrack(camTrack())));
    $('.tile.me video').srcObject = camStream;
    setPressed('#btn-share', false);
    if (pinnedId === 'me') pinnedId = null;
    sendState(); spotId = undefined; updateSpotlight();
  }

  $('#btn-mic').addEventListener('click', toggleMic);
  $('#btn-cam').addEventListener('click', toggleCam);
  $('#btn-hand').addEventListener('click', toggleHand);
  $('#btn-share').addEventListener('click', toggleShare);
  $('#btn-leave').addEventListener('click', () => R.leave());
  $('#btn-end').addEventListener('click', () => { if (confirm('End the class for everyone?')) socket.emit('teacher', { action: 'end' }); });
  $('#btn-side').addEventListener('click', () => $('#side').classList.toggle('open'));
  $('#btn-copy-link').addEventListener('click', async () => { await navigator.clipboard?.writeText(C.inviteLink(code)).catch(() => {}); C.toast('Invite link copied'); });

  $('#btn-react').addEventListener('click', () => { const m = $('#react-menu'); m.hidden = !m.hidden; $('#btn-react').setAttribute('aria-expanded', String(!m.hidden)); });
  $('#react-menu').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') { socket.emit('react', e.target.textContent); $('#react-menu').hidden = true; } });
  function floatReaction(emoji, name) {
    const f = document.createElement('div');
    f.className = 'float';
    f.style.left = `${10 + Math.random() * 75}%`;
    f.innerHTML = `${esc(emoji)}<small>${esc(name)}</small>`;
    $('#reactions').append(f);
    setTimeout(() => f.remove(), 2700);
  }

  document.addEventListener('keydown', (e) => {
    if (!R.active || e.target.closest('input, textarea, select')) return;
    if (e.key === 'm') toggleMic();
    if (e.key === 'v') toggleCam();
    if (e.key === 'h') toggleHand();
  });

  // ---------- side tabs ----------
  function selectTab(name) {
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    $$('.tab-panel').forEach((p) => (p.hidden = p.id !== `tab-${name}`));
    if (name === 'chat') { unread = 0; $('#chat-badge').hidden = true; }
    if (name === 'board') sizeBoard();
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  // ---------- chat ----------
  let unread = 0;
  function sys(text) { const li = document.createElement('li'); li.className = 'sys'; li.textContent = text; appendChat(li); }
  function appendChat(li) { const log = $('#chat-log'); const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60; log.append(li); if (atBottom) log.scrollTop = log.scrollHeight; }
  function onChat(m) {
    const li = document.createElement('li');
    if (m.from === myId) li.className = 'mine';
    const time = new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    li.innerHTML = `<div class="who">${m.from === myId ? 'You' : esc(m.name)}${m.role === 'teacher' && m.from !== myId ? ' <span class="role">(Teacher)</span>' : ''}, ${time}</div><div class="bubble">${esc(m.text)}</div>`;
    appendChat(li);
    if ($('#tab-chat').hidden && m.from !== myId) { unread++; $('#chat-badge').textContent = unread; $('#chat-badge').hidden = false; }
  }
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#chat-input').value.trim();
    if (v) socket.emit('chat', v);
    $('#chat-input').value = '';
  });

  // ---------- people & teacher tools ----------
  function renderPeople() {
    const rows = [['me', infoOf('me')], ...[...peers].map(([id, p]) => [id, p.info])].filter(([, i]) => i);
    rows.sort((a, b) => (b[1].hand - a[1].hand) || (a[1].role === 'teacher' ? -1 : 1));
    $('#people-list').innerHTML = rows.map(([id, i]) => `
      <li>
        ${C.avatar(i.name)}
        <div class="nm"><b>${esc(i.name)}${id === 'me' ? ' (you)' : ''}</b><small>${i.role === 'teacher' ? 'Teacher' : 'Student'}${i.mic === false ? ', muted' : ''}${i.sharing ? ', sharing screen' : ''}</small></div>
        ${i.hand ? '<span class="hand-mark" title="Hand raised">✋</span>' : ''}
        ${myRole === 'teacher' && id !== 'me' ? `<div class="acts">
          ${i.hand ? `<button data-a="lower-hand" data-id="${id}">Lower hand</button>` : ''}
          ${i.mic !== false ? `<button data-a="mute" data-id="${id}">Mute</button>` : ''}
          <button data-a="remove" data-id="${id}">Remove</button></div>` : ''}
      </li>`).join('');
    $('#people-count').textContent = rows.length;
  }
  $('#people-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    if (b.dataset.a === 'remove' && !confirm(`Remove ${peers.get(b.dataset.id)?.info.name} from the class?`)) return;
    socket.emit('teacher', { action: b.dataset.a, target: b.dataset.id });
  });
  $$('[data-t]').forEach((b) => b.addEventListener('click', async () => {
    const a = b.dataset.t;
    if (a === 'attendance') {
      try {
        const list = await C.api(`/api/attendance/${code}`);
        $('#att-list').innerHTML = list.length ? list.slice().reverse().map((x) => `<li><span>${esc(x.name)}${x.role === 'teacher' ? ' (Teacher)' : ''}</span><span class="muted">${new Date(x.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span></li>`).join('') : '<li>No one has joined yet.</li>';
        $('#dlg-attendance').showModal();
      } catch (err) { C.toast(err.message); }
      return;
    }
    if (a === 'clear-board' && !confirm('Clear the whiteboard for everyone?')) return;
    socket.emit('teacher', { action: a });
    if (a === 'mute-all') C.toast('Everyone is muted');
  }));
  function applyFlags(f) {
    boardLocked = !!f.boardLocked; roomLocked = !!f.locked;
    $('#room-lock-pill').hidden = !roomLocked;
    $('#t-lock').textContent = roomLocked ? 'Unlock class' : 'Lock class';
    $('#t-lock-board').textContent = boardLocked ? 'Let everyone draw' : 'Only I can draw';
    $('#board-note').hidden = !(boardLocked && myRole !== 'teacher');
  }

  // ---------- whiteboard ----------
  let ctx, color = '#1B2A4A', drawing = null, boardReady = false;
  function setupBoard() {
    const cv = $('#board');
    cv.width = BOARD_W; cv.height = BOARD_H;
    ctx = cv.getContext('2d');
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    clearBoard();
    if (boardReady) return;
    boardReady = true;
    $$('.sw').forEach((s) => { if (s.dataset.c !== 'eraser') s.style.background = s.dataset.c; s.addEventListener('click', () => { color = s.dataset.c; $$('.sw').forEach((x) => x.setAttribute('aria-pressed', String(x === s))); }); });
    $('#board-big').addEventListener('click', () => { boardBig = !boardBig; pinnedId = null; updateSpotlight(); });

    // map pointer to board coordinates (canvas uses object-fit: contain)
    const toBoard = (e) => {
      const r = cv.getBoundingClientRect();
      const scale = Math.min(r.width / BOARD_W, r.height / BOARD_H);
      const ox = (r.width - BOARD_W * scale) / 2, oy = (r.height - BOARD_H * scale) / 2;
      return [Math.round((e.clientX - r.left - ox) / scale), Math.round((e.clientY - r.top - oy) / scale)];
    };
    let flushTimer;
    const flush = () => {
      if (!drawing || drawing.pts.length < 2) return;
      socket.emit('draw', drawing);
      drawing = { ...drawing, pts: [drawing.pts[drawing.pts.length - 1]] };
    };
    cv.addEventListener('pointerdown', (e) => {
      if (boardLocked && myRole !== 'teacher') return C.toast('Only the teacher can draw right now.');
      cv.setPointerCapture(e.pointerId);
      const w = +$('#brush').value;
      drawing = color === 'eraser' ? { e: 1, w: w * 4, pts: [toBoard(e)] } : { c: color, w, pts: [toBoard(e)] };
      flushTimer = setInterval(flush, 50);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const pt = toBoard(e);
      drawStroke({ ...drawing, pts: [drawing.pts[drawing.pts.length - 1], pt] });
      drawing.pts.push(pt);
    });
    const end = () => {
      if (!drawing) return;
      if (drawing.pts.length === 1) { drawing.pts.push([drawing.pts[0][0] + 0.1, drawing.pts[0][1]]); drawStroke(drawing); }
      clearInterval(flushTimer); flush(); drawing = null;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }
  function sizeBoard() { /* canvas keeps a fixed 1600×1000 surface; CSS scales it */ }
  function drawStroke(s) {
    if (!ctx || !s?.pts?.length) return;
    ctx.save();
    ctx.globalCompositeOperation = s.e ? 'destination-out' : 'source-over';
    ctx.strokeStyle = s.c || '#000';
    ctx.lineWidth = s.w;
    ctx.beginPath();
    ctx.moveTo(...s.pts[0]);
    s.pts.slice(1).forEach((p) => ctx.lineTo(...p));
    ctx.stroke();
    ctx.restore();
  }
  function clearBoard() { ctx?.clearRect(0, 0, BOARD_W, BOARD_H); }

  // ---------- clock / leave ----------
  function tickClock() {
    const s = Math.floor((Date.now() - joinedAt) / 1000);
    $('#room-clock').textContent = `${s >= 3600 ? Math.floor(s / 3600) + ':' : ''}${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  function stopMedia() {
    camStream?.getTracks().forEach((t) => t.stop()); camStream = null;
    screenTrack?.stop(); screenTrack = null;
  }
  R.leave = (silent) => {
    if (!R.active && !silent) { location.hash = '#/today'; return; }
    R.active = false;
    clearInterval(clockTimer); clearInterval(speakTimer);
    peers.forEach((_, id) => removePeer(id));
    socket?.disconnect(); socket = null;
    stopMedia();
    meAnalyser = null;
    if ($('#spotlight').contains($('#board'))) $('#board-wrap').append($('#board'));
    pinnedId = null; spotId = null; boardBig = false;
    $('#spotlight').hidden = true; $('#stage').classList.remove('has-spot');
    $('#side').classList.remove('open');
    $('#view-room').hidden = true;
    document.body.classList.toggle('is-teacher', C.profile?.role === 'teacher');
    if (!silent) location.hash = '#/today';
  };
  window.addEventListener('beforeunload', () => socket?.disconnect());
})();
