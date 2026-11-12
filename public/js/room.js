/* Cartable — live classroom: WebRTC mesh video, screen share, chat, whiteboard */
(() => {
  const C = window.Cartable;
  const { $, $$, esc } = C;
  const tr = (k, v) => C.t(k, v);
  const loc = () => window.I18N.locale();
  let ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
  fetch('/api/config').then((r) => r.json()).then((c) => { if (c.iceServers?.length) ICE = { iceServers: c.iceServers }; }).catch(() => {});
  const BOARD_W = 1600, BOARD_H = 1000;

  const R = (window.Room = { active: false });
  let socket, myId, myRole, code, course;
  let camStream = null, screenTrack = null;
  let micOn = true, camOn = true, hand = false;
  let joinedAt = 0, clockTimer, speakTimer, audioCtx;
  let boardLocked = false, roomLocked = false;
  let chatMode = 'all', chatMuted = false;
  let spotId = null, pinnedId = null, boardBig = false;
  let rec = null; // teacher's recording: { recorder, chunks, display, ac, type, startedAt }
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
    $('#prejoin-title').textContent = c ? tr('Ready for {title}?', { title: c.title }) : tr('Ready to join?');
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
    $('#room-name').textContent = course?.title || tr('Live class');
    $('#room-meta').textContent = [course?.subject && tr(course.subject), course?.group, tr('Code {code}', { code })].filter(Boolean).join(', ');
    $('#chat-log').innerHTML = '';
    chatMode = 'all'; chatMuted = false; captionsOn = false; showCC = true;
    $('#btn-cc-show').setAttribute('aria-pressed', 'true');
    $('#tiles').innerHTML = '';
    if (audioTrack()) audioTrack().enabled = micOn;
    if (camTrack()) camTrack().enabled = camOn;
    setPressed('#btn-mic', micOn); setPressed('#btn-cam', camOn); setPressed('#btn-hand', false); setPressed('#btn-share', false);
    hand = false;
    selectTab('chat');
    setupBoard();

    socket = io({ transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      socket.emit('join', { room: code, name: C.profile.name, token: C.profile.token }, (res) => {
        if (res.error) { C.toast(tr(res.error, { n: res.n })); R.leave(); return; }
        C.rememberRoom(code);
        if (res.inLobby) { $('#lobby-wait').hidden = false; return; }
        entered(res);
      });
    });

    function entered(res) {
      if (res.error) { C.toast(tr(res.error, { n: res.n })); R.leave(); return; }
      $('#lobby-wait').hidden = true;
      myId = res.id; myRole = res.role;
      document.body.classList.toggle('is-teacher', myRole === 'teacher');
      addTile('me', { name: res.name || C.profile.name, role: myRole, mic: micOn, cam: camOn, hand: false }, camStream, true);
      sendState();
      chatMuted = !!res.chatMuted;
      applyFlags(res);
      if (saver) applySaver(false);
      setRecording(res.recording, null, true);
      loadBoard(res.strokes, res.bg);
      setPoll(res.poll, true);
      applyBreakout(res.breakout);
      renderLobby(res.lobby || []);
      media = res.media === 'livekit' ? 'livekit' : 'mesh';
      res.peers.forEach((p) => { createPeer(p.id, p); if (media === 'mesh') call(p.id); });
      if (media === 'livekit') {
        lkConnect(res.lk).catch((err) => { console.warn('LiveKit', err); C.toast('Could not connect the video. Check your connection, then leave and join again.'); });
      }
      joinedAt = Date.now();
      clockTimer = setInterval(tickClock, 1000); tickClock();
      speakTimer = setInterval(detectSpeaking, 250);
      sys(tr('You joined the class.'));
      renderPeople();
    }
    socket.on('admitted', entered);
    socket.on('denied', () => { C.toast("The teacher didn't let you in this time."); R.leave(); });
    socket.on('lobby', (list) => renderLobby(list, true));
    socket.on('board-bg', ({ v }) => showBackground(v));
    socket.on('board-remove', removeStroke);
    socket.on('poll', (p) => setPoll(p));
    socket.on('breakout', applyBreakout);
    socket.on('lk-token', (d) => { if (media === 'livekit') lkSwitch(d); });
    socket.on('files-changed', ({ name }) => {
      C.refreshFiles(code);
      if (name && myRole !== 'teacher') C.toast(tr('The teacher shared {name}. Open Files to see it.', { name }));
    });

    socket.on('peer-joined', (p) => { createPeer(p.id, p); sys(tr('{name} joined.', { name: p.name })); renderPeople(); });
    socket.on('peer-left', ({ id }) => { const p = peers.get(id); if (p) sys(tr('{name} left.', { name: p.info.name })); removePeer(id); });
    socket.on('peer-state', (s) => {
      if (s.id === myId) return;
      const p = peers.get(s.id); if (!p) return;
      const raised = !p.info.hand && s.hand;
      const resend = !!p.info.saver !== !!s.saver || !!p.info.sharing !== !!s.sharing;
      p.info = { ...p.info, ...s };
      updateTile(s.id);
      renderPeople();
      if (raised) { sys(tr('{name} raised their hand ✋', { name: s.name })); if (myRole === 'teacher') C.toast(tr('{name} raised their hand', { name: s.name })); }
      updateSpotlight();
      if (resend) { syncSenders(); lkApplySaver(); }
    });
    socket.on('signal', onSignal);
    socket.on('caption', (m) => showCaption(m.name, m.text, m.final));
    socket.on('star', onStar);
    socket.on('chat', onChat);
    socket.on('chat-delete', (id) => {
      const li = $(`#chat-log li[data-id="${CSS.escape(String(id))}"]`); if (!li) return;
      li.classList.add('deleted');
      li.querySelector('.bubble').textContent = tr('Message deleted by the teacher');
      li.querySelector('.chat-del')?.remove();
    });
    socket.on('chat-muted', (on) => {
      chatMuted = !!on; syncChatForm();
      C.toast(on ? 'The teacher turned off your messages.' : 'You can write in the chat again.');
    });
    socket.on('react', ({ name, emoji }) => floatReaction(emoji, name));
    socket.on('draw', addStroke);
    socket.on('clear-board', clearBoard);
    socket.on('room-flags', applyFlags);
    socket.on('recording', ({ on, name }) => setRecording(on, name));
    socket.on('force-mute', () => { if (micOn) { toggleMic(); C.toast('The teacher muted your microphone'); } });
    socket.on('force-lower-hand', () => { if (hand) { toggleHand(); C.toast('The teacher lowered your hand'); } });
    socket.on('removed', () => { C.toast('The teacher removed you from the class.'); R.leave(); });
    socket.on('ended', () => { C.toast('The teacher ended the class. See you next time!'); R.leave(); });
    socket.on('disconnect', (reason) => { if (R.active && reason !== 'io client disconnect') sys(tr('Connection lost. Trying to reconnect…')); });
  }

  // ---------- peers ----------
  // show a newly arrived camera/microphone track on someone's tile
  function addRemoteTrack(p, track) {
    if (!p.stream.getTracks().includes(track)) p.stream.addTrack(track);
    const v = p.tile?.querySelector('video');
    if (v) { v.srcObject = null; v.srcObject = p.stream; }
    if (track.kind === 'audio') attachAnalyser(p);
    updateSpotlight();
  }

  function createPeer(id, info) {
    if (peers.has(id)) return peers.get(id);
    // with LiveKit, media comes from the LiveKit room instead of a direct connection
    const pc = media === 'mesh' ? new RTCPeerConnection(ICE) : null;
    const stream = new MediaStream();
    const p = { pc, stream, info, pending: [] };
    peers.set(id, p);
    if (pc) {
      pc.onicecandidate = (e) => e.candidate && socket.emit('signal', { to: id, data: { candidate: e.candidate } });
      pc.ontrack = (e) => addRemoteTrack(p, e.track);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') pc.restartIce?.();
        if (pc.connectionState === 'connected') tuneSender(id);
      };
    }
    addTile(id, info, stream, false);
    applyVisibility(id);
    return p;
  }

  async function call(id) {
    const { pc } = peers.get(id);
    pc.addTransceiver(trackFor(id, 'audio') || 'audio', { direction: 'sendrecv' });
    pc.addTransceiver(trackFor(id, 'video') || 'video', { direction: 'sendrecv' });
    await pc.setLocalDescription(await pc.createOffer());
    socket.emit('signal', { to: id, data: { sdp: pc.localDescription } });
  }

  async function onSignal({ from, data }) {
    if (media !== 'mesh') return;
    const p = peers.get(from) || createPeer(from, { name: 'Guest', role: 'student' });
    const pc = p.pc;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          const [ta, tv] = pc.getTransceivers();
          if (ta) { ta.direction = 'sendrecv'; await ta.sender.replaceTrack(trackFor(from, 'audio')); }
          if (tv) { tv.direction = 'sendrecv'; await tv.sender.replaceTrack(trackFor(from, 'video')); }
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
    p.pc?.close();
    p.tile?.remove();
    peers.delete(id);
    if (pinnedId === id) pinnedId = null;
    updateSpotlight(); renderPeople(); layoutTiles();
  }

  // ---------- LiveKit (optional media server for bigger classes) ----------
  // The server says which to use when you join: 'mesh' (direct connections) or 'livekit'.
  // With LiveKit you send your camera and voice once, to the LiveKit room for your group.
  let media = 'mesh', lk = null, lkVideoPub = null, lkLoad = null;
  function loadLiveKit() {
    lkLoad = lkLoad || new Promise((resolve, reject) => {
      if (window.LivekitClient) return resolve(window.LivekitClient);
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/livekit-client@2.22.4/dist/livekit-client.umd.js';
      s.integrity = 'sha384-5qI/UmLG0CvuWCt6vqjMW1oRwzXu+MNhbw4x6yo9NARdlqi94LwQfq9wvDTIcfrD';
      s.crossOrigin = 'anonymous';
      s.onload = () => (window.LivekitClient ? resolve(window.LivekitClient) : reject(new Error('LiveKit did not load')));
      s.onerror = () => { lkLoad = null; reject(new Error('LiveKit did not load')); };
      document.head.append(s);
    });
    return lkLoad;
  }
  async function lkConnect({ url, token }) {
    const L = await loadLiveKit();
    // keep our own camera/microphone alive when LiveKit unpublishes them (we switch rooms for groups)
    const room = new L.Room({ adaptiveStream: true, dynacast: true, stopLocalTrackOnUnpublish: false });
    lk = room;
    room.on(L.RoomEvent.TrackSubscribed, (track, pub, part) => {
      if (lk !== room) return;
      const p = peers.get(part.identity) || createPeer(part.identity, { name: part.name || 'Guest', role: 'student' });
      addRemoteTrack(p, track.mediaStreamTrack);
    });
    room.on(L.RoomEvent.TrackPublished, () => lkApplySaver());
    room.on(L.RoomEvent.TrackUnsubscribed, (track, pub, part) => {
      const p = peers.get(part.identity);
      if (p) { p.stream.removeTrack(track.mediaStreamTrack); updateSpotlight(); }
    });
    room.on(L.RoomEvent.Disconnected, () => {
      if (lk === room && R.active) sys(tr('The video connection was lost. Leave and join again if you cannot see or hear the class.'));
    });
    await room.connect(url, token);
    if (lk !== room) { room.disconnect(false); return; } // left or switched groups while connecting
    if (audioTrack()) await room.localParticipant.publishTrack(audioTrack(), { source: L.Track.Source.Microphone });
    lkVideoPub = null;
    await lkSyncVideo();
    lkApplySaver();
  }
  // With LiveKit, saving data means not receiving students' cameras, and the teacher's in low quality.
  function lkApplySaver() {
    const L = window.LivekitClient;
    if (!lk || !L) return;
    for (const part of lk.remoteParticipants.values()) {
      const info = peers.get(part.identity)?.info;
      for (const pub of part.trackPublications.values()) {
        if (pub.kind !== 'video') continue;
        const want = !saver || info?.role === 'teacher' || !!info?.sharing;
        try {
          pub.setSubscribed(want);
          if (want) pub.setVideoQuality(saver ? L.VideoQuality.LOW : L.VideoQuality.HIGH);
        } catch {}
      }
    }
  }
  // publish whatever we show (camera or shared screen), or nothing
  async function lkSyncVideo() {
    const room = lk, L = window.LivekitClient;
    if (!room || !L || room.state !== 'connected') return;
    const v = outVideo();
    try {
      if (lkVideoPub && v) await lkVideoPub.track.replaceTrack(v, true);
      else if (!lkVideoPub && v) lkVideoPub = await room.localParticipant.publishTrack(v, { source: L.Track.Source.Camera, simulcast: true });
      else if (lkVideoPub && !v) { await room.localParticipant.unpublishTrack(lkVideoPub.track, false); lkVideoPub = null; }
    } catch (err) { console.warn('LiveKit video', err); }
  }
  // breakout groups: move to the LiveKit room of our new group (the server sends a token for it)
  async function lkSwitch(data) {
    lkLeave();
    peers.forEach((p) => { p.stream.getTracks().forEach((t) => p.stream.removeTrack(t)); });
    updateSpotlight();
    try { await lkConnect(data); }
    catch (err) { console.warn('LiveKit', err); C.toast('Could not connect the video. Check your connection, then leave and join again.'); }
  }
  function lkLeave() {
    const room = lk;
    lk = null; lkVideoPub = null;
    room?.disconnect(false); // false: do not stop our camera and microphone
  }

  // ---------- breakout groups ----------
  // During group work you only send your camera and voice to people in your group,
  // and other groups' tiles are hidden and muted.
  let breakout = { active: false };
  const groupOf = (id) => (breakout.active ? (breakout.groups[id === 'me' ? myId : id] ?? null) : null);
  const canSee = (id) => !breakout.active || groupOf(id) === groupOf('me');
  const groupName = (g) => (g === null ? tr('Main room') : tr('Group {n}', { n: g + 1 }));
  function trackFor(id, kind) {
    if (!canSee(id)) return null;
    if (kind === 'audio') return audioTrack();
    // someone saving data only gets video from the teacher and shared screens
    if (peers.get(id)?.info.saver && myRole !== 'teacher' && !screenTrack) return null;
    return outVideo();
  }
  // Lower the quality of the video we send to one person when either of us saves data.
  async function tuneSender(id) {
    const tv = peers.get(id)?.pc?.getTransceivers()[1];
    if (!tv) return;
    try {
      const prm = tv.sender.getParameters();
      if (!prm.encodings?.length) return;
      const low = saver || !!peers.get(id).info.saver;
      const e = prm.encodings[0];
      if (low) { e.maxBitrate = screenTrack ? 500000 : 150000; e.scaleResolutionDownBy = screenTrack ? 1 : 2; e.maxFramerate = screenTrack ? 8 : 12; }
      else { delete e.maxBitrate; e.scaleResolutionDownBy = 1; delete e.maxFramerate; }
      await tv.sender.setParameters(prm);
    } catch {}
  }
  function syncSenders() {
    if (media === 'livekit') return lkSyncVideo(); // groups are separate LiveKit rooms; only camera vs screen changes here
    return Promise.all([...peers].map(([id, p]) => {
      const [ta, tv] = p.pc.getTransceivers();
      return Promise.all([
        ta?.sender.replaceTrack(trackFor(id, 'audio')).catch(() => {}),
        tv?.sender.replaceTrack(trackFor(id, 'video')).catch(() => {}),
      ]).then(() => tuneSender(id));
    }));
  }
  function applyVisibility(id) {
    const p = peers.get(id);
    if (!p?.tile) return;
    const see = canSee(id);
    p.tile.hidden = !see;
    layoutTiles();
    p.tile.querySelector('video').muted = !see;
    if (!see && pinnedId === id) pinnedId = null;
  }
  function applyBreakout(b) {
    const before = groupOf('me'), wasActive = breakout.active;
    breakout = b && b.active ? b : { active: false };
    const mine = groupOf('me');
    peers.forEach((_, id) => applyVisibility(id));
    syncSenders();
    $('#group-pill').hidden = !breakout.active;
    $('#group-pill').textContent = groupName(mine);
    $('#bo-setup').hidden = breakout.active;
    $('#bo-live').hidden = !breakout.active;
    if (breakout.active) {
      const opts = [null, ...Array.from({ length: breakout.count }, (_, i) => i)];
      $('#bo-visit').innerHTML = opts.map((g) => `<option value="${g === null ? '' : g}"${g === mine ? ' selected' : ''}>${esc(groupName(g))}</option>`).join('');
    }
    if (breakout.active && (!wasActive || before !== mine)) {
      sys(tr('You are now in: {group}.', { group: groupName(mine) }));
      if (myRole !== 'teacher') C.toast(tr('You are now in: {group}.', { group: groupName(mine) }));
    } else if (!breakout.active && wasActive) {
      sys(tr('Everyone is back together.'));
      if (myRole !== 'teacher') C.toast('Everyone is back together.');
    }
    spotId = undefined;
    updateSpotlight(); renderPeople();
  }
  $('#bo-start').addEventListener('click', () => {
    const count = +$('#bo-count').value;
    const students = [...peers].filter(([, p]) => p.info.role !== 'teacher').map(([id]) => id);
    if (students.length < 2) return C.toast('You need at least two students to make groups.');
    for (let i = students.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [students[i], students[j]] = [students[j], students[i]]; }
    socket.emit('teacher', { action: 'breakout-start', count, assign: Object.fromEntries(students.map((id, i) => [id, i % count])) });
  });
  $('#bo-visit').addEventListener('change', (e) => {
    socket.emit('teacher', { action: 'breakout-move', target: myId, group: e.target.value === '' ? null : +e.target.value });
  });
  $('#bo-end').addEventListener('click', () => socket.emit('teacher', { action: 'breakout-end' }));

  // ---------- tiles ----------
  const MIC_OFF = () => `<svg viewBox="0 0 24 24" aria-label="${tr('Microphone off')}"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16"/></svg>`;

  function addTile(id, info, stream, mine) {
    const el = document.createElement('div');
    el.className = 'tile' + (mine ? ' me' : '');
    el.dataset.id = id;
    el.innerHTML = `<video autoplay playsinline ${mine ? 'muted' : ''}></video>
      <div class="ph">${C.avatar(info.name)}</div>
      <div class="tile-name"></div>
      <button class="btn btn-ghost btn-sm pin" type="button">${tr('Pin')}</button>`;
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
    const hidden = saver && id !== 'me' && i.role !== 'teacher' && !i.sharing;
    el.classList.toggle('cam-on', !!(i.cam || i.sharing) && !hidden);
    el.classList.toggle('hand', !!i.hand);
    el.classList.toggle('sharing', !!i.sharing);
    el.querySelector('.tile-name').innerHTML = `${i.mic === false ? MIC_OFF() : ''}<span>${esc(i.name)}${id === 'me' ? ' ' + tr('(you)') : ''}</span>${i.role === 'teacher' ? `<span class="role">${tr('Teacher')}</span>` : ''}`;
    let flag = el.querySelector('.hand-flag');
    if (i.hand && !flag) { flag = document.createElement('span'); flag.className = 'hand-flag'; flag.textContent = '✋'; el.append(flag); }
    if (!i.hand && flag) flag.remove();
    el.querySelector('.pin').textContent = tr(pinnedId === id ? 'Unpin' : 'Pin');
  }

  // Video tiles fill the stage in a square-ish grid: 2x2 for 4 people, 3x3 for 9.
  // Phones get fewer columns (tiles at least ~150px wide).
  function layoutTiles() {
    const box = $('#tiles');
    $('#people-count').textContent = box.children.length;
    const n = [...box.children].filter((t) => !t.hidden).length || 1;
    const fit = Math.max(1, Math.floor((box.clientWidth || 800) / 150));
    box.style.setProperty('--cols', String(Math.max(1, Math.min(Math.ceil(Math.sqrt(n)), fit))));
  }
  window.addEventListener('resize', () => { if (R.active) layoutTiles(); });

  function updateSpotlight() {
    const sharer = [...peers].find(([id, p]) => p.info.sharing && canSee(id))?.[0] || (screenTrack ? 'me' : null);
    const target = boardBig ? 'board' : pinnedId || sharer;
    const spot = $('#spotlight');
    if (target === spotId && target !== null && target !== 'board' && spot.querySelector('video')?.srcObject) return;
    // return the board if it was out on the stage
    if (target !== 'board' && spot.contains($('#board-stack'))) $('#board-wrap').append($('#board-stack'));
    spotId = target;
    $('#stage').classList.toggle('has-spot', !!target);
    spot.hidden = !target;
    if (!target) { spot.innerHTML = ''; return; }
    if (target === 'board') {
      spot.innerHTML = '';
      spot.append($('#board-stack'));
      $('#board-big').textContent = tr('Back to panel');
      return;
    }
    $('#board-big').textContent = tr('Show big');
    const stream = target === 'me' ? (screenTrack ? new MediaStream([screenTrack]) : camStream) : peers.get(target)?.stream;
    const i = infoOf(target);
    spot.innerHTML = `<video autoplay playsinline muted></video><div class="tile-name"><span>${esc(i?.sharing ? tr('{name} is sharing their screen', { name: i.name }) : i?.name || '')}</span></div>`;
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
  function sendState() { socket?.emit('state', { mic: micOn, cam: camOn, hand, sharing: !!screenTrack, saver }); updateTile('me'); renderPeople(); }

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
    $('#hand-label').textContent = tr(hand ? 'Lower hand' : 'Raise hand');
    sendState();
  }
  async function toggleShare() {
    if (screenTrack) return stopShare();
    if (!navigator.mediaDevices?.getDisplayMedia) return C.toast('Screen sharing is not supported on this device.');
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
      screenTrack = s.getVideoTracks()[0];
      screenTrack.onended = stopShare;
      await syncSenders();
      $('.tile.me video').srcObject = new MediaStream([screenTrack]);
      setPressed('#btn-share', true);
      sendState(); updateSpotlight();
    } catch { /* user cancelled */ }
  }
  async function stopShare() {
    if (!screenTrack) return;
    screenTrack.onended = null; screenTrack.stop(); screenTrack = null;
    await syncSenders();
    $('.tile.me video').srcObject = camStream;
    setPressed('#btn-share', false);
    if (pinnedId === 'me') pinnedId = null;
    sendState(); spotId = undefined; updateSpotlight();
  }

  $('#btn-mic').addEventListener('click', toggleMic);
  $('#btn-cam').addEventListener('click', toggleCam);
  $('#btn-hand').addEventListener('click', toggleHand);
  $('#btn-share').addEventListener('click', toggleShare);
  $('#btn-rec').addEventListener('click', () => (rec ? stopRecording() : startRecording()));
  $('#btn-leave').addEventListener('click', () => R.leave());
  $('#btn-end').addEventListener('click', async () => {
    if (await C.sure(tr('End the class for everyone?'), tr('Everyone leaves the live class now.'), tr('End for all'), { icon: 'leave' })) socket?.emit('teacher', { action: 'end' });
  });
  $('#btn-side').addEventListener('click', () => $('#side').classList.toggle('open'));
  $('#btn-files').addEventListener('click', () => C.openFiles(code, course?.title, myRole === 'teacher'));
  $('#btn-copy-link').addEventListener('click', async () => { await navigator.clipboard?.writeText(C.inviteLink(code)).catch(() => {}); C.toast('Invite link copied'); });

  $('#btn-react').addEventListener('click', () => { const m = $('#react-menu'); m.hidden = !m.hidden; $('#btn-react').setAttribute('aria-expanded', String(!m.hidden)); });
  $('#react-menu').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') { socket.emit('react', e.target.textContent); $('#react-menu').hidden = true; } });
  // ---------- save data ----------
  let saver = false;
  try { saver = localStorage.getItem('cartable.saver') === '1'; } catch {}
  $('#btn-saver').setAttribute('aria-pressed', String(saver));
  function applySaver(announce) {
    $('#btn-saver').setAttribute('aria-pressed', String(saver));
    try { localStorage.setItem('cartable.saver', saver ? '1' : '0'); } catch {}
    if (!socket) return;
    sendState();
    syncSenders();
    lkApplySaver();
    $('.tile').forEach((t) => updateTile(t.dataset.id));
    if (announce) C.toast(saver ? 'Saving data: you only get the teacher\'s video and shared screens, in lower quality.' : 'Saving data is off.');
  }
  $('#btn-saver').addEventListener('click', () => { saver = !saver; applySaver(true); });

  // ---------- live captions ----------
  // The teacher's browser turns their speech into text (Web Speech API) and Cartable shows it to the class.
  // Only the teacher's voice is captioned: browsers send the sound to their maker's speech service.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let captionsOn = false, showCC = true, speech = null, ccTimer = null;
  const ccLang = () => ({ en: 'en-GB', fr: 'fr-FR', ar: 'ar-TN' }[window.I18N.lang] || 'en-GB');
  function showCaption(name, text, final) {
    if (!captionsOn || !showCC || !text) return;
    const box = $('#captions');
    box.hidden = false;
    $('#cc-name').textContent = name;
    $('#cc-text').textContent = text;
    if (final) { $('#cc-prev').textContent = text; }
    clearTimeout(ccTimer);
    ccTimer = setTimeout(() => { box.hidden = true; $('#cc-prev').textContent = ''; }, 7000);
  }
  function speechStart() {
    if (speech || !SR) return;
    const r = new SR();
    speech = r;
    r.lang = ccLang(); r.continuous = true; r.interimResults = true;
    let last = 0;
    r.onresult = (e) => {
      if (!micOn || speech !== r) return; // a muted teacher is not captioned
      let text = '', final = false;
      for (let i = e.resultIndex; i < e.results.length; i++) { text += e.results[i][0].transcript; final = e.results[i].isFinal; }
      text = text.trim();
      if (!text || (!final && Date.now() - last < 250)) return;
      last = Date.now();
      socket?.emit('caption', { text, final });
      showCaption(tr('You'), text, final);
    };
    r.onerror = (e) => {
      if (e.error !== 'not-allowed' && e.error !== 'service-not-allowed' && e.error !== 'language-not-supported') return;
      C.toast('Captions are not available in this browser. Try Chrome or Edge.');
      speech = null;
      socket?.emit('teacher', { action: 'captions', on: false });
    };
    // browsers stop listening after a silence: start again while captions are on
    r.onend = () => { if (speech === r) setTimeout(() => { if (speech === r) try { r.start(); } catch {} }, 300); };
    try { r.start(); } catch {}
  }
  function speechStop() { const r = speech; speech = null; try { r?.stop(); } catch {} }
  function applyCaptions(on) {
    const was = captionsOn;
    captionsOn = !!on;
    $('#btn-cc').setAttribute('aria-pressed', String(captionsOn));
    $('#btn-cc-show').hidden = !captionsOn || myRole === 'teacher';
    if (!captionsOn) { $('#captions').hidden = true; $('#cc-prev').textContent = ''; }
    if (myRole === 'teacher') (captionsOn ? speechStart : speechStop)();
    if (was !== captionsOn && R.active && myId) sys(tr(captionsOn ? 'Live captions are on.' : 'Live captions are off.'));
  }
  $('#btn-cc').addEventListener('click', async () => {
    if (!captionsOn) {
      if (!SR) return C.toast('Captions are not available in this browser. Try Chrome or Edge.');
      if (!(await C.sure(tr('Turn on live captions?'),
        tr('What you say is written under the video for the class. To do this, your browser sends your voice to its speech service (Google for Chrome, Microsoft for Edge, Apple for Safari). Only your voice is captioned, never the students\'.'),
        tr('Turn on'), { tone: 'blue', icon: 'cc', kind: 'primary', okFocus: true }))) return;
    }
    socket.emit('teacher', { action: 'captions', on: !captionsOn });
  });
  $('#btn-cc-show').addEventListener('click', () => {
    showCC = !showCC;
    $('#btn-cc-show').setAttribute('aria-pressed', String(showCC));
    if (!showCC) $('#captions').hidden = true;
  });

  // ---------- stars ----------
  function onStar(m) {
    const reason = tr(C.STARS[m.reason] || '');
    floatReaction('⭐', m.name);
    const tile = tileOf(m.id === myId ? 'me' : m.id);
    if (tile) { tile.classList.remove('starred'); void tile.offsetWidth; tile.classList.add('starred'); }
    sys(tr('⭐ {name} got a star: {reason}', { name: m.id === myId ? tr('You') : m.name, reason }));
    if (m.id === myId) C.toast(tr('You got a star: {reason}!', { reason }));
    else if (myRole === 'teacher' && !m.saved) C.toast(tr('{name} joined as a guest, so this star is not kept.', { name: m.name }));
  }
  async function giveStar(id) {
    const name = peers.get(id)?.info.name;
    const reason = await C.ask({
      title: tr('A star for {name}', { name }), text: tr('Why? Everyone in the class sees it. Students who signed in with their code keep their stars.'),
      tone: 'yellow', icon: 'star',
      actions: Object.entries(C.STARS).map(([value, label]) => ({ label: tr(label), value, kind: 'ghost' })),
    });
    if (reason) socket.emit('teacher', { action: 'star', target: id, reason });
  }

  function floatReaction(emoji, name) {
    const f = document.createElement('div');
    f.className = 'float';
    f.style.left = `${10 + Math.random() * 75}%`;
    f.innerHTML = `${esc(emoji)}<small>${esc(name)}</small>`;
    $('#reactions').append(f);
    setTimeout(() => f.remove(), 2700);
  }

  document.addEventListener('keydown', (e) => {
    if (!R.active || !myId || e.target.closest('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === 'z' || k === 'y')) {
      e.preventDefault();
      if (k === 'y' || e.shiftKey) redo(); else undo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser shortcuts such as Ctrl+V alone
    if (e.key === 'm') toggleMic();
    if (e.key === 'v') toggleCam();
    if (e.key === 'h') toggleHand();
  });

  // ---------- recording (teacher only, saved on the teacher's computer) ----------
  function setRecording(on, name, onJoin) {
    $('#rec-pill').hidden = !on;
    if (onJoin) { if (on) { sys(tr('This class is being recorded.')); C.toast('This class is being recorded.'); } return; }
    if (on) sys(tr('{name} started recording the class.', { name: name || '' }));
    else sys(tr('Recording stopped.'));
  }

  function pickType() {
    const types = ['video/mp4;codecs=avc1,opus', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return types.find((x) => MediaRecorder.isTypeSupported(x)) || '';
  }

  async function startRecording() {
    if (myRole !== 'teacher' || rec) return;
    if (!window.MediaRecorder || !navigator.mediaDevices?.getDisplayMedia) return C.toast('Recording is not supported in this browser. Use Chrome or Edge on a computer.');
    if (!(await C.sure(tr('Record this class?'), tr('Everyone in the class sees a Recording badge. The video is saved on this computer only.'),
      tr('Start recording'), { icon: 'record', kind: 'primary', okFocus: true }))) return;
    if (!R.active || rec) return;
    C.toast('Choose this tab and turn on tab audio so students can be heard in the recording.');
    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser', frameRate: 24 },
        audio: { suppressLocalAudioPlayback: false },
        preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', systemAudio: 'include',
      });
    } catch { return; } // cancelled
    if (!R.active) { display.getTracks().forEach((x) => x.stop()); return; }

    // one audio track: what the tab plays (students) + the teacher's microphone
    const ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    const tabAudio = display.getAudioTracks();
    if (tabAudio.length) ac.createMediaStreamSource(new MediaStream(tabAudio)).connect(dest);
    else setTimeout(() => C.toast("Students won't be heard in the recording because tab audio was not shared."), 3500);
    if (audioTrack()) ac.createMediaStreamSource(new MediaStream([audioTrack()])).connect(dest);

    const stream = new MediaStream([display.getVideoTracks()[0], ...dest.stream.getAudioTracks()]);
    const type = pickType();
    let recorder;
    try { recorder = new MediaRecorder(stream, { ...(type && { mimeType: type }), videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 96_000 }); }
    catch { display.getTracks().forEach((x) => x.stop()); ac.close(); return C.toast('Recording is not supported in this browser. Use Chrome or Edge on a computer.'); }

    const chunks = [];
    rec = { recorder, chunks, display, ac, type: recorder.mimeType || type || 'video/webm', startedAt: new Date(), title: course?.title || tr('Live class') };
    const mine = rec;
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => saveRecording(mine);
    recorder.start(5000);
    display.getVideoTracks()[0].addEventListener('ended', stopRecording); // "Stop sharing" in the browser bar
    setPressed('#btn-rec', true);
    $('#rec-label').textContent = tr('Stop recording');
    socket?.emit('teacher', { action: 'record-start' });
  }

  function stopRecording() {
    if (!rec) return;
    const r = rec;
    rec = null;
    if (r.recorder.state !== 'inactive') r.recorder.stop();
    r.display.getTracks().forEach((x) => x.stop());
    setPressed('#btn-rec', false);
    $('#rec-label').textContent = tr('Record');
    socket?.emit('teacher', { action: 'record-stop' });
  }

  function saveRecording(r) {
    r.ac.close().catch(() => {});
    if (!r.chunks.length) return;
    const blob = new Blob(r.chunks, { type: r.type.split(';')[0] });
    const ext = r.type.includes('mp4') ? 'mp4' : 'webm';
    const d = r.startedAt;
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}h${String(d.getMinutes()).padStart(2, '0')}`;
    const safe = r.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'class';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Cartable - ${safe} - ${stamp}.${ext}`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
    C.toast('Recording saved to your downloads.');
  }

  // ---------- side tabs ----------
  function selectTab(name) {
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    $$('.tab-panel').forEach((p) => (p.hidden = p.id !== `tab-${name}`));
    if (name === 'chat') { unread = 0; $('#chat-badge').hidden = true; }
    if (name === 'poll') $('#poll-badge').hidden = true;
    if (name === 'board') sizeBoard();
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  // ---------- chat ----------
  let unread = 0;
  function sys(text) { const li = document.createElement('li'); li.className = 'sys'; li.textContent = text; appendChat(li); }
  function appendChat(li) { const log = $('#chat-log'); const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60; log.append(li); if (atBottom) log.scrollTop = log.scrollHeight; }
  // during group work, say where a message came from
  function chatScope(m) {
    if (m.toAll) return ` <span class="role">${tr('to everyone')}</span>`;
    if (m.group === undefined || m.group === groupOf('me')) return '';
    return ` <span class="role">${esc(groupName(m.group))}</span>`;
  }
  function onChat(m) {
    const li = document.createElement('li');
    if (m.from === myId) li.className = 'mine';
    if (m.id) li.dataset.id = m.id;
    // a message only the teacher can read ("students write to me only")
    if (m.private) li.classList.add('private');
    const time = new Date(m.at).toLocaleTimeString(loc(), { hour: 'numeric', minute: '2-digit', hourCycle: window.I18N.lang === 'en' ? undefined : 'h23' });
    li.innerHTML = `<div class="who">${m.from === myId ? tr('You') : esc(m.name)}${m.role === 'teacher' && m.from !== myId ? ` <span class="role">${tr('(Teacher)')}</span>` : ''}${chatScope(m)}${m.private ? ` <span class="role">${tr(m.from === myId ? 'to the teacher' : 'only you see this')}</span>` : ''}, ${time}${myRole === 'teacher' && m.id ? ` <button class="chat-del" type="button" data-del-msg="${esc(m.id)}" aria-label="${esc(tr('Delete this message'))}" title="${esc(tr('Delete this message'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>` : ''}</div><div class="bubble">${esc(m.text)}</div>`;
    appendChat(li);
    if ($('#tab-chat').hidden && m.from !== myId) { unread++; $('#chat-badge').textContent = unread; $('#chat-badge').hidden = false; }
  }
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#chat-input').value.trim();
    if (!v) return;
    socket.emit('chat', v, (res) => {
      if (res?.error) { C.toast(res.error); $('#chat-input').value ||= v; }
    });
    $('#chat-input').value = '';
  });
  $('#chat-log').addEventListener('click', (e) => {
    const b = e.target.closest('[data-del-msg]');
    if (b && myRole === 'teacher') socket.emit('teacher', { action: 'chat-delete', id: b.dataset.delMsg });
  });
  $('#chat-mode').addEventListener('change', (e) => socket.emit('teacher', { action: 'chat-mode', mode: e.target.value }));
  // students: say who can read what they write, or why they cannot write
  function syncChatForm() {
    const student = myRole !== 'teacher';
    const blocked = student && (chatMuted || chatMode === 'off');
    const note = !student ? '' : chatMuted ? 'The teacher turned off your messages.'
      : chatMode === 'off' ? 'Only the teacher can write in the chat right now.'
      : chatMode === 'teacher' ? 'Your messages go to the teacher only.' : '';
    $('#chat-note').hidden = !note;
    $('#chat-note').textContent = tr(note);
    $('#chat-input').disabled = blocked;
    $('#chat-form button').disabled = blocked;
    $('#chat-input').placeholder = tr(blocked ? 'Chat is closed' : 'Write a message');
  }

  // ---------- people & teacher tools ----------
  function renderPeople() {
    // during group work, students only list their own group; the teacher lists everyone
    const rows = [['me', infoOf('me')], ...[...peers].map(([id, p]) => [id, p.info])]
      .filter(([id, i]) => i && (myRole === 'teacher' || canSee(id)));
    rows.sort((a, b) => (b[1].hand - a[1].hand) || (a[1].role === 'teacher' ? -1 : 1));
    $('#people-list').innerHTML = rows.map(([id, i]) => `
      <li>
        ${C.avatar(i.name)}
        <div class="nm"><b>${esc(i.name)}${id === 'me' ? ' ' + tr('(you)') : ''}</b><small>${tr(i.role === 'teacher' ? 'Teacher' : 'Student')}${myRole === 'teacher' && id !== 'me' && i.role !== 'teacher' ? ', ' + tr(i.verified ? 'signed in with a code' : 'guest') : ''}${i.mic === false ? ', ' + tr('muted') : ''}${i.chatMuted && myRole === 'teacher' ? ', ' + tr('chat off') : ''}${i.sharing ? ', ' + tr('sharing screen') : ''}</small>${breakout.active && myRole === 'teacher' && id === 'me' ? ` <span class="grp">${esc(groupName(groupOf('me')))}</span>` : ''}</div>
        ${i.hand ? `<span class="hand-mark" title="${tr('Hand raised')}">✋</span>` : ''}
        ${myRole === 'teacher' && id !== 'me' && breakout.active ? `<select data-move="${id}" aria-label="${esc(tr('Move {name} to a group', { name: i.name }))}">
          ${[null, ...Array.from({ length: breakout.count }, (_, k) => k)].map((g) => `<option value="${g === null ? '' : g}"${g === groupOf(id) ? ' selected' : ''}>${esc(groupName(g))}</option>`).join('')}
        </select>` : ''}
        ${myRole === 'teacher' && id !== 'me' ? `<div class="acts">
          ${i.hand ? `<button data-a="lower-hand" data-id="${id}">${tr('Lower hand')}</button>` : ''}
          ${i.mic !== false ? `<button data-a="mute" data-id="${id}">${tr('Mute')}</button>` : ''}
          ${i.role !== 'teacher' ? `<button data-a="chat-mute" data-id="${id}" aria-pressed="${!!i.chatMuted}">${tr(i.chatMuted ? 'Allow chat' : 'Stop chat')}</button>` : ''}
          ${i.role !== 'teacher' ? `<button data-a="star" data-id="${id}" title="${esc(tr('Give a star'))}">⭐ ${tr('Star')}</button>` : ''}
          <button data-a="remove" data-id="${id}">${tr('Remove')}</button></div>` : ''}
      </li>`).join('');
    $('#people-count').textContent = rows.length;
  }
  $('#people-list').addEventListener('change', (e) => {
    const s = e.target.closest('[data-move]'); if (!s) return;
    socket.emit('teacher', { action: 'breakout-move', target: s.dataset.move, group: s.value === '' ? null : +s.value });
  });
  $('#people-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    if (b.dataset.a === 'star') return giveStar(b.dataset.id);
    if (b.dataset.a === 'remove' && !(await C.sure(tr('Remove {name} from the class?', { name: peers.get(b.dataset.id)?.info.name }),
      tr('They leave the live class now. They can come back with the class link unless you lock the class.'), tr('Remove'), { icon: 'person' }))) return;
    socket.emit('teacher', { action: b.dataset.a, target: b.dataset.id });
  });
  $$('[data-t]').forEach((b) => b.addEventListener('click', async () => {
    const a = b.dataset.t;
    if (a === 'attendance') {
      try {
        const list = await C.api(`/api/attendance/${code}`);
        $('#att-list').innerHTML = list.length ? list.slice().reverse().map((x) => `<li><span>${esc(x.name)}${x.role === 'teacher' ? ' ' + tr('(Teacher)') : x.verified ? ' ✓' : ' ' + tr('(guest)')}</span><span class="muted">${new Date(x.at).toLocaleString(loc(), { dateStyle: 'short', timeStyle: 'short' })}</span></li>`).join('') : `<li>${tr('No one has joined yet.')}</li>`;
        $('#dlg-attendance').showModal();
      } catch (err) { C.toast(err.message); }
      return;
    }
    if (a === 'clear-board' && !(await C.sure(tr('Clear the whiteboard for everyone?'), tr('Everything drawn on it is erased.'), tr('Clear'), { icon: 'eraser' }))) return;
    socket.emit('teacher', { action: a });
    if (a === 'mute-all') C.toast('Everyone is muted');
  }));
  // waiting room (teacher view)
  let lobbyCount = 0;
  function renderLobby(list, notify) {
    if (myRole !== 'teacher') return;
    const fresh = list.length > lobbyCount;
    lobbyCount = list.length;
    $('#lobby').hidden = !list.length;
    $('#lobby-badge').hidden = !list.length;
    $('#lobby-badge').textContent = list.length;
    $('#lobby-list').innerHTML = list.map((p) => `
      <li>
        ${C.avatar(p.name)}
        <div class="nm"><b>${esc(p.name)}</b></div>
        <div class="acts">
          <button data-a="admit" data-id="${esc(p.id)}">${tr('Let in')}</button>
          <button data-a="deny" data-id="${esc(p.id)}">${tr('Turn away')}</button>
        </div>
      </li>`).join('');
    if (notify && fresh) C.toast(tr('{name} is waiting to join', { name: list[list.length - 1].name }));
  }
  $('#lobby-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    socket.emit('teacher', { action: b.dataset.a, target: b.dataset.id });
  });
  $('#lobby-leave').addEventListener('click', () => R.leave());

  function applyFlags(f) {
    boardLocked = !!f.boardLocked; roomLocked = !!f.locked;
    $('#t-waiting').textContent = tr(f.waiting ? 'Turn off waiting room' : 'Turn on waiting room');
    $('#room-lock-pill').hidden = !roomLocked;
    $('#t-lock').textContent = tr(roomLocked ? 'Unlock class' : 'Lock class');
    $('#t-lock-board').textContent = tr(boardLocked ? 'Let everyone draw' : 'Only I can draw');
    $('#board-note').hidden = !(boardLocked && myRole !== 'teacher');
    applyCaptions(f.captions);
    const was = chatMode;
    chatMode = f.chat || 'all';
    $('#chat-mode').value = chatMode;
    syncChatForm();
    if (was !== chatMode && myRole !== 'teacher' && R.active) sys(tr({ all: 'Everyone can write in the chat again.', teacher: 'Your messages now go to the teacher only.', off: 'Only the teacher can write in the chat now.' }[chatMode]));
  }

  // ---------- polls & quizzes ----------
  let poll = null;            // the poll as the server last sent it (students get counts only once results are shown)
  const myVotes = new Map();  // poll id -> my answer
  function setPoll(p, onJoin) {
    const isNew = p && (!poll || poll.id !== p.id);
    const revealed = p && poll && poll.id === p.id && !poll.shown && p.shown;
    poll = p;
    renderPoll();
    if (myRole === 'teacher' || !(isNew || revealed)) return;
    if ($('#tab-poll').hidden) $('#poll-badge').hidden = false;
    if (!onJoin) C.toast(isNew ? 'Your teacher started a poll. Open the Poll tab to answer.' : 'The poll results are in.');
  }

  function renderPoll() {
    const box = $('#poll-live');
    const teacher = myRole === 'teacher';
    $('#poll-form').hidden = !teacher || !!poll;
    if (!poll) {
      box.innerHTML = teacher ? '' : `<p class="poll-empty">${tr('No poll right now. When your teacher asks a question, it will show up here.')}</p>`;
      return;
    }
    const mine = myVotes.get(poll.id);
    const bars = !!poll.counts;
    const items = poll.options.map((o, i) => {
      const n = bars ? poll.counts[i] : 0;
      const pct = bars && poll.total ? Math.round((n * 100) / poll.total) : 0;
      const cls = `poll-choice${poll.correct === i ? ' right' : ''}`;
      const inner = `${bars ? `<span class="bar" style="width:${pct}%"></span>` : ''}
        <span class="label">${esc(o)}</span>
        ${poll.correct === i ? `<span class="mark" title="${esc(tr('Right answer'))}">✓</span>` : ''}
        ${bars ? `<span class="n">${n} · ${pct}%</span>` : ''}`;
      if (!teacher && poll.open) return `<li><button type="button" class="${cls}" data-vote="${i}" aria-pressed="${mine === i}">${inner}</button></li>`;
      return `<li><div class="${cls}"${!teacher && mine === i ? ' aria-pressed="true"' : ''}>${inner}</div></li>`;
    }).join('');

    let note = '';
    if (teacher) {
      note = `${tr(poll.total === 1 ? '1 answer' : '{n} answers', { n: poll.total })}, ${tr(poll.open ? 'voting is open' : poll.shown ? 'results shown to everyone' : 'voting is stopped')}`;
    } else if (poll.open) {
      note = tr(mine === undefined ? 'Choose your answer.' : 'Answer saved. You can change it until the teacher stops the vote.');
    } else if (!poll.shown) {
      note = tr('Voting is closed. Wait for the results.');
    } else if (poll.quiz && mine !== undefined) {
      note = tr(mine === poll.correct ? 'You got it right! 🎉' : 'Not this time. The right answer has a ✓.');
    }

    const actions = teacher ? `<div class="poll-actions">
        ${poll.open ? `<button class="btn btn-ghost btn-sm" data-poll="poll-close" type="button">${tr('Stop voting')}</button>` : ''}
        ${!poll.shown ? `<button class="btn btn-primary btn-sm" data-poll="poll-show" type="button">${tr('Show results to everyone')}</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-poll="poll-end" type="button">${tr('End poll')}</button>
      </div>` : '';
    const voters = teacher && poll.voters?.length ? `<details><summary class="small">${tr('Who answered what')}</summary>
        <ul class="poll-voters">${poll.voters.map((v) => `<li>${esc(v.name)}: ${esc(poll.options[v.choice])}</li>`).join('')}</ul></details>` : '';

    box.innerHTML = `<div class="stack">
      <p class="poll-meta">${tr(poll.quiz ? 'Quiz' : 'Poll')}</p>
      <h3 class="poll-q">${esc(poll.q)}</h3>
      <ul class="poll-choices">${items}</ul>
      <p class="${teacher ? 'poll-meta' : 'poll-result'}">${esc(note)}</p>
      ${actions}${voters}
    </div>`;
  }
  $('#poll-live').addEventListener('click', (e) => {
    const v = e.target.closest('[data-vote]');
    if (v && poll) {
      const id = poll.id, choice = +v.dataset.vote;
      myVotes.set(id, choice);
      renderPoll();
      socket.emit('vote', { id, choice }, (r) => { if (!r?.ok) { myVotes.delete(id); renderPoll(); C.toast('Voting is closed.'); } });
    }
    const a = e.target.closest('[data-poll]');
    if (a) socket.emit('teacher', { action: a.dataset.poll });
  });

  // teacher: the "new poll" form
  function syncPollForm() {
    const items = [...$('#poll-opts').children];
    items.forEach((li, i) => {
      li.querySelector('input[type="text"]').placeholder = tr('Answer {n}', { n: i + 1 });
      li.querySelector('.rm').hidden = items.length <= 2;
      li.querySelector('input[type="radio"]').hidden = !$('#poll-quiz').checked;
    });
    $('#poll-add').hidden = items.length >= 6;
  }
  function addPollOption() {
    if ($('#poll-opts').children.length >= 6) return;
    const li = document.createElement('li');
    li.innerHTML = `<input type="radio" name="poll-correct" aria-label="${esc(tr('Right answer'))}"><input type="text" maxlength="80"><button class="rm" type="button" aria-label="${esc(tr('Remove this answer'))}">×</button>`;
    $('#poll-opts').append(li);
    syncPollForm();
    return li;
  }
  function resetPollForm() { $('#poll-form').reset(); $('#poll-opts').innerHTML = ''; addPollOption(); addPollOption(); }
  resetPollForm();
  $('#poll-add').addEventListener('click', () => addPollOption()?.querySelector('input[type="text"]').focus());
  $('#poll-quiz').addEventListener('change', syncPollForm);
  $('#poll-opts').addEventListener('click', (e) => { if (e.target.closest('.rm')) { e.target.closest('li').remove(); syncPollForm(); } });
  $('#poll-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    const rows = [...$('#poll-opts').children].map((li) => ({ text: li.querySelector('input[type="text"]').value.trim(), right: li.querySelector('input[type="radio"]').checked })).filter((r) => r.text);
    if (rows.length < 2) return C.toast('Write at least two answers.');
    let correct = null;
    if ($('#poll-quiz').checked) {
      correct = rows.findIndex((r) => r.right);
      if (correct < 0) return C.toast('Tick the right answer for the quiz.');
    }
    socket.emit('teacher', { action: 'poll-start', q, options: rows.map((r) => r.text), correct });
    resetPollForm();
  });

  // ---------- whiteboard ----------
  // Every item has an id. A pen stroke is sent in several pieces that share one id,
  // so undo can remove the whole stroke. Three layers: background, drawing, live preview.
  let ctx, fx, bgx, color = '#1B2A4A', tool = 'pen', boardReady = false;
  let items = [];        // everything on the board, in drawing order
  let undoIds = [];      // ids of my own items, newest last
  let redoStack = [];    // my undone items, each an array of pieces
  let drawing = null, shape = null, textAt = null;
  const newStrokeId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const canDraw = () => !(boardLocked && myRole !== 'teacher');
  const textSize = () => Math.round(+$('#brush').value * 4 + 12);

  function paint(g, s) {
    if (!g || !s?.pts?.length) return;
    g.save();
    g.globalCompositeOperation = s.e ? 'destination-out' : 'source-over';
    g.strokeStyle = g.fillStyle = s.c || '#000';
    g.lineWidth = s.w || 4;
    g.lineCap = 'round'; g.lineJoin = 'round';
    const [a, b] = s.pts;
    g.beginPath();
    if (s.k === 'text') {
      g.direction = 'ltr'; g.textAlign = 'left'; g.textBaseline = 'top';
      g.font = `700 ${s.s}px "Atkinson Hyperlegible", sans-serif`;
      g.fillText(s.txt, a[0], a[1]);
    } else if (s.k === 'line' || s.k === 'arrow') {
      g.moveTo(...a); g.lineTo(...b);
      if (s.k === 'arrow') {
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), len = Math.max(14, s.w * 3.5);
        for (const d of [-0.5, 0.5]) { g.moveTo(...b); g.lineTo(b[0] - len * Math.cos(ang + d), b[1] - len * Math.sin(ang + d)); }
      }
      g.stroke();
    } else if (s.k === 'rect') {
      g.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    } else if (s.k === 'ellipse') {
      g.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2);
      g.stroke();
    } else {
      g.moveTo(...a);
      s.pts.slice(1).forEach((p) => g.lineTo(...p));
      g.stroke();
    }
    g.restore();
  }

  function redraw() { if (!ctx) return; ctx.clearRect(0, 0, BOARD_W, BOARD_H); items.forEach((s) => paint(ctx, s)); }
  function addStroke(s) { items.push(s); paint(ctx, s); }
  function removeStroke(id) { const n = items.length; items = items.filter((s) => s.id !== id); if (items.length !== n) redraw(); }
  function updateHistory() { $('#board-undo').disabled = !undoIds.length; $('#board-redo').disabled = !redoStack.length; }
  function clearBoard() { items = []; undoIds = []; redoStack = []; redraw(); updateHistory(); }
  function loadBoard(strokes, bg) { clearBoard(); items = [...(strokes || [])]; redraw(); showBackground(bg); }

  // a finished item of mine: show it, send it, remember it for undo
  function commit(s) {
    addStroke(s);
    socket?.emit('draw', s);
    undoIds.push(s.id); redoStack = []; updateHistory();
  }

  function undo() {
    if (!canDraw()) return C.toast('Only the teacher can draw right now.');
    const id = undoIds.pop(); if (!id) return;
    const pieces = items.filter((s) => s.id === id);
    removeStroke(id);
    socket?.emit('undo', id);
    if (pieces.length) redoStack.push(pieces);
    updateHistory();
  }
  function redo() {
    if (!canDraw()) return C.toast('Only the teacher can draw right now.');
    const pieces = redoStack.pop(); if (!pieces) return;
    // join the pieces of a pen stroke back together (at most 1000 points each)
    let out = pieces;
    if (!pieces[0].k) {
      const pts = pieces.flatMap((p, i) => (i ? p.pts.slice(1) : p.pts));
      out = [];
      for (let i = 0; i < pts.length; i += 999) out.push({ ...pieces[0], pts: pts.slice(Math.max(0, i - 1), i + 999) });
    }
    out.forEach((s) => { addStroke(s); socket?.emit('draw', s); });
    undoIds.push(pieces[0].id);
    updateHistory();
  }

  function setTool(t) {
    if (t !== 'text') commitText();
    tool = t;
    $$('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
    $('#board-fx').classList.toggle('is-text', t === 'text');
  }

  // where the 1600×1000 board sits inside a canvas scaled with object-fit: contain
  function boardBox() {
    const r = $('#board-fx').getBoundingClientRect();
    const scale = Math.min(r.width / BOARD_W, r.height / BOARD_H);
    return { r, scale, ox: (r.width - BOARD_W * scale) / 2, oy: (r.height - BOARD_H * scale) / 2 };
  }
  const toBoard = (e) => {
    const { r, scale, ox, oy } = boardBox();
    return [Math.round((e.clientX - r.left - ox) / scale), Math.round((e.clientY - r.top - oy) / scale)];
  };

  function openText(p) {
    const inp = $('#board-text');
    const { r, scale, ox, oy } = boardBox();
    const sr = $('#board-stack').getBoundingClientRect();
    textAt = { p, size: textSize(), c: color };
    inp.value = '';
    inp.style.left = `${r.left - sr.left + ox + p[0] * scale}px`;
    inp.style.top = `${r.top - sr.top + oy + p[1] * scale}px`;
    inp.style.fontSize = `${Math.max(textAt.size * scale, 10)}px`;
    inp.style.color = color;
    inp.hidden = false;
    setTimeout(() => inp.focus(), 0);
  }
  function commitText() {
    const inp = $('#board-text');
    if (inp.hidden) return;
    inp.hidden = true;
    const txt = inp.value.trim();
    const at = textAt; textAt = null;
    if (txt && at && canDraw()) commit({ id: newStrokeId(), k: 'text', c: at.c, s: at.size, pts: [at.p], txt: txt.slice(0, 200) });
  }

  function setupBoard() {
    const cv = $('#board'), fxc = $('#board-fx'), bgc = $('#board-bg');
    for (const c of [cv, fxc, bgc]) { c.width = BOARD_W; c.height = BOARD_H; }
    ctx = cv.getContext('2d'); fx = fxc.getContext('2d'); bgx = bgc.getContext('2d');
    clearBoard();
    showBackground(0);
    if (boardReady) return;
    boardReady = true;
    $$('.sw').forEach((s) => {
      s.style.background = s.dataset.c;
      s.addEventListener('click', () => {
        color = s.dataset.c;
        $$('.sw').forEach((x) => x.setAttribute('aria-pressed', String(x === s)));
        if (tool === 'eraser') setTool('pen');
      });
    });
    $$('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('#board-undo').addEventListener('click', undo);
    $('#board-redo').addEventListener('click', redo);
    $('#board-big').addEventListener('click', () => { boardBig = !boardBig; pinnedId = null; updateSpotlight(); });
    $('#board-save').addEventListener('click', saveBoard);
    $('#board-share').addEventListener('click', shareBoard);
    $('#bg-file').addEventListener('change', onBackgroundFile);
    $('#bg-prev').addEventListener('click', () => showPdfPage(pdfPage - 1));
    $('#bg-next').addEventListener('click', () => showPdfPage(pdfPage + 1));
    $('#bg-remove').addEventListener('click', removeBackground);

    const inp = $('#board-text');
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitText(); }
      if (e.key === 'Escape') { e.preventDefault(); inp.hidden = true; textAt = null; }
    });
    inp.addEventListener('blur', commitText);

    let flushTimer;
    const flush = () => {
      if (!drawing || drawing.pts.length < 2) return;
      const piece = { ...drawing, pts: drawing.pts.slice() };
      items.push(piece); // already painted while drawing
      socket?.emit('draw', piece);
      drawing.pts = [drawing.pts[drawing.pts.length - 1]];
    };
    fxc.addEventListener('pointerdown', (e) => {
      if (!canDraw()) return C.toast('Only the teacher can draw right now.');
      const p = toBoard(e);
      if (tool === 'text') { e.preventDefault(); commitText(); openText(p); return; }
      fxc.setPointerCapture(e.pointerId);
      const w = +$('#brush').value, id = newStrokeId();
      if (tool === 'pen' || tool === 'eraser') {
        drawing = tool === 'eraser' ? { id, e: 1, w: w * 4, pts: [p] } : { id, c: color, w, pts: [p] };
        undoIds.push(id); redoStack = []; updateHistory();
        flushTimer = setInterval(flush, 50);
      } else {
        shape = { id, k: tool, c: color, w, pts: [p, p] };
      }
    });
    fxc.addEventListener('pointermove', (e) => {
      if (drawing) {
        const pt = toBoard(e);
        paint(ctx, { ...drawing, pts: [drawing.pts[drawing.pts.length - 1], pt] });
        drawing.pts.push(pt);
        if (drawing.pts.length >= 900) flush();
      } else if (shape) {
        shape.pts[1] = toBoard(e);
        fx.clearRect(0, 0, BOARD_W, BOARD_H);
        paint(fx, shape);
      }
    });
    const end = () => {
      if (drawing) {
        if (drawing.pts.length === 1) { drawing.pts.push([drawing.pts[0][0] + 0.1, drawing.pts[0][1]]); paint(ctx, drawing); }
        clearInterval(flushTimer); flush(); drawing = null;
      }
      if (shape) {
        fx.clearRect(0, 0, BOARD_W, BOARD_H);
        const [a, b] = shape.pts;
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 3) commit(shape);
        shape = null;
      }
    };
    fxc.addEventListener('pointerup', end);
    fxc.addEventListener('pointercancel', end);
  }
  function sizeBoard() { /* canvases keep a fixed 1600×1000 surface; CSS scales them */ }

  // ---------- whiteboard background (teacher: a picture or a PDF page) ----------
  let bgVersion = 0, pdfDoc = null, pdfPage = 1, pdfjsPromise;
  function showBackground(v) {
    bgVersion = v || 0;
    $('#bg-remove').hidden = !bgVersion;
    if (!bgVersion) { pdfDoc = null; $('#bg-pages').hidden = true; bgx?.clearRect(0, 0, BOARD_W, BOARD_H); return; }
    const img = new Image();
    img.onload = () => { if (bgVersion === v && bgx) { bgx.clearRect(0, 0, BOARD_W, BOARD_H); bgx.drawImage(img, 0, 0, BOARD_W, BOARD_H); } };
    img.src = `/api/rooms/${encodeURIComponent(code)}/background?v=${v}`;
  }
  function loadPdfJs() {
    pdfjsPromise = pdfjsPromise || new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.integrity = 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e';
      s.crossOrigin = 'anonymous';
      s.onload = () => {
        const lib = window.pdfjsLib;
        if (!lib) return reject(new Error('pdf.js did not load'));
        lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        resolve(lib);
      };
      s.onerror = () => { pdfjsPromise = null; reject(new Error('pdf.js did not load')); };
      document.head.append(s);
    });
    return pdfjsPromise;
  }
  async function onBackgroundFile(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    C.toast('Preparing the background…');
    try {
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        const pdfjs = await loadPdfJs();
        pdfDoc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
        await showPdfPage(1);
      } else {
        pdfDoc = null; $('#bg-pages').hidden = true;
        const bmp = await createImageBitmap(file);
        await uploadBackground(bmp, bmp.width, bmp.height);
        bmp.close?.();
      }
    } catch (err) {
      console.warn(err);
      C.toast('That file could not be opened. Try a picture or a PDF.');
    }
  }
  async function showPdfPage(n) {
    if (!pdfDoc || n < 1 || n > pdfDoc.numPages) return;
    pdfPage = n;
    const page = await pdfDoc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(BOARD_W / base.width, BOARD_H / base.height) });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    $('#bg-pages').hidden = pdfDoc.numPages < 2;
    $('#bg-page-label').textContent = tr('Page {n} of {total}', { n, total: pdfDoc.numPages });
    $('#bg-prev').disabled = n <= 1;
    $('#bg-next').disabled = n >= pdfDoc.numPages;
    await uploadBackground(c, c.width, c.height);
  }
  async function uploadBackground(src, w, h) {
    const c = document.createElement('canvas');
    c.width = BOARD_W; c.height = BOARD_H;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, BOARD_W, BOARD_H);
    const s = Math.min(BOARD_W / w, BOARD_H / h);
    g.drawImage(src, (BOARD_W - w * s) / 2, (BOARD_H - h * s) / 2, w * s, h * s);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    if (!blob) throw new Error('Could not encode the background');
    const res = await fetch(`/api/rooms/${encodeURIComponent(code)}/background`, {
      method: 'PUT', headers: { 'content-type': 'image/jpeg', authorization: `Bearer ${C.profile.token}` }, body: blob,
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); C.toast(d.error || 'Something went wrong. Try again.'); }
  }
  async function removeBackground() {
    pdfDoc = null; $('#bg-pages').hidden = true;
    await fetch(`/api/rooms/${encodeURIComponent(code)}/background`, { method: 'DELETE', headers: { authorization: `Bearer ${C.profile.token}` } }).catch(() => {});
  }

  // The whiteboard as a PNG: white paper, the same light grid, the background, then the drawing on top.
  function boardPng() {
    const out = document.createElement('canvas');
    out.width = BOARD_W; out.height = BOARD_H;
    const g = out.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, BOARD_W, BOARD_H);
    g.strokeStyle = 'rgba(185, 201, 236, .5)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 32; x < BOARD_W; x += 32) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, BOARD_H); }
    for (let y = 32; y < BOARD_H; y += 32) { g.moveTo(0, y + 0.5); g.lineTo(BOARD_W, y + 0.5); }
    g.stroke();
    g.drawImage($('#board-bg'), 0, 0);
    g.drawImage($('#board'), 0, 0);
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}`;
    const title = (course?.title || '').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60);
    const name = [tr('Whiteboard'), title, stamp].filter(Boolean).join(' - ') + '.png';
    return new Promise((resolve) => out.toBlob((blob) => resolve(blob && { blob, name }), 'image/png'));
  }
  async function saveBoard() {
    const png = await boardPng();
    if (!png) return C.toast('Something went wrong. Try again.');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(png.blob);
    a.download = png.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30e3);
    C.toast('Whiteboard saved to your downloads.');
  }
  // Teacher: keep the board with the class, so students can download it after class from Files.
  async function shareBoard() {
    const b = $('#board-share');
    const png = await boardPng();
    if (!png) return C.toast('Something went wrong. Try again.');
    b.disabled = true;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(code)}/files`, {
        method: 'POST',
        headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent(png.name), authorization: `Bearer ${C.profile?.token || ''}` },
        body: png.blob,
      });
      if (!res.ok) throw new Error(tr((await res.json().catch(() => ({}))).error || 'Something went wrong. Try again.'));
      C.toast('The whiteboard is in the class files. Everyone can download it from Files.');
    } catch (err) { C.toast(err.message); }
    finally { b.disabled = false; }
  }

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
    stopRecording();
    speechStop(); captionsOn = false; $('#captions').hidden = true;
    lkLeave();
    $('#rec-pill').hidden = true;
    clearInterval(clockTimer); clearInterval(speakTimer);
    peers.forEach((_, id) => removePeer(id));
    socket?.disconnect(); socket = null;
    stopMedia();
    meAnalyser = null;
    if ($('#spotlight').contains($('#board-stack'))) $('#board-wrap').append($('#board-stack'));
    $('#lobby-wait').hidden = true;
    $('#board-text').hidden = true; textAt = null;
    lobbyCount = 0; $('#lobby').hidden = true; $('#lobby-badge').hidden = true;
    pdfDoc = null; $('#bg-pages').hidden = true;
    myId = null;
    breakout = { active: false }; $('#group-pill').hidden = true; $('#bo-setup').hidden = false; $('#bo-live').hidden = true;
    poll = null; $('#poll-badge').hidden = true;
    pinnedId = null; spotId = null; boardBig = false;
    $('#spotlight').hidden = true; $('#stage').classList.remove('has-spot');
    $('#side').classList.remove('open');
    $('#view-room').hidden = true;
    document.body.classList.toggle('is-teacher', C.profile?.role === 'teacher');
    if (!silent) location.hash = '#/today';
  };
  window.addEventListener('beforeunload', (e) => {
    if (rec) { e.preventDefault(); e.returnValue = ''; return; } // ask before losing a recording
    socket?.disconnect();
  });
})();
