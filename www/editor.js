let lastBlob = null, lastExt = 'webm';
const wait = ms => new Promise(r => setTimeout(r, ms));

function pickMime() {
  const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const m of list) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

function loadVideo(file) {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    v.playsInline = true; v.preload = 'auto';
    v.onloadeddata = () => res(v);
    v.onerror = () => rej(new Error('Could not load ' + file.name));
    v.src = URL.createObjectURL(file);
  });
}

function seekTo(v, t) {
  return new Promise(r => {
    if (Math.abs(v.currentTime - t) < 0.02) return r();
    const done = () => { v.removeEventListener('seeked', done); r(); };
    v.addEventListener('seeked', done);
    v.currentTime = t;
    setTimeout(done, 3000);
  });
}

function drawFrame(ctx, v, W, H, zoom) {
  const s = Math.max(W / v.videoWidth, H / v.videoHeight) * zoom;
  const dw = v.videoWidth * s, dh = v.videoHeight * s;
  ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function wrapLines(ctx, text, maxW) {
  const words = String(text).split(/\s+/), lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function drawCaption(ctx, W, H, text) {
  const fs = Math.round(W * 0.065);
  ctx.font = 'bold ' + fs + 'px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.lineJoin = 'round'; ctx.lineWidth = fs * 0.18;
  ctx.strokeStyle = '#000'; ctx.fillStyle = '#fff';
  const lines = wrapLines(ctx, text, W * 0.88);
  let y = H * 0.82 - (lines.length - 1) * fs * 1.2;
  lines.forEach(l => { ctx.strokeText(l, W / 2, y); ctx.fillText(l, W / 2, y); y += fs * 1.2; });
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(new Error('Could not read video'));
    r.readAsDataURL(blob);
  });
}

async function saveVideo() {
  const st = document.getElementById('rstatus');
  try {
    const P = window.Capacitor && window.Capacitor.Plugins;
    if (!P || !P.Filesystem || !P.Share) throw new Error('Save plugins missing, rebuild the app');
    st.textContent = '💾 Preparing file...';
    const data = await blobToBase64(lastBlob);
    const w = await P.Filesystem.writeFile({ path: 'edit_' + Date.now() + '.' + lastExt, data, directory: 'CACHE' });
    await P.Share.share({ title: 'Edited video', url: w.uri });
    st.textContent = '✅ Done. Choose Gallery / Files / any app.';
  } catch (e) { st.textContent = '❌ ' + e.message; }
}

async function renderEdit() {
  const st = document.getElementById('rstatus');
  const btn = document.getElementById('render');
  const prev = document.getElementById('preview');
  const old = document.getElementById('savebtn'); if (old) old.remove();
  if (!lastPlan || !Array.isArray(lastPlan.segments) || !lastPlan.segments.length) {
    st.textContent = '⚠️ Tap Generate edit first and wait for the plan.'; return;
  }
  if (!window.MediaRecorder) { st.textContent = '❌ This phone cannot record video here.'; return; }
  btn.disabled = true;
  try {
    const videos = {};
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    await actx.resume();
    const dest = actx.createMediaStreamDestination();
    async function getVid(i) {
      if (!videos[i]) {
        const v = await loadVideo(clips[i]);
        actx.createMediaElementSource(v).connect(dest);
        videos[i] = v;
      }
      return videos[i];
    }
    const segs = lastPlan.segments.filter(s => clips[s.clip] != null);
    if (!segs.length) throw new Error('Plan has no valid clips');
    const first = await getVid(segs[0].clip);
    let W = first.videoWidth, H = first.videoHeight;
    const sc = Math.min(1, 1280 / Math.max(W, H));
    W = Math.round(W * sc / 2) * 2; H = Math.round(H * sc / 2) * 2;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    const caps = Array.isArray(lastPlan.captions) ? lastPlan.captions : [];
    const grade = String(lastPlan.colorGrade || 'none').toLowerCase();
    const filter = (grade === 'none' || grade === '') ? 'none' : 'contrast(1.08) saturate(1.15) brightness(1.03)';

    const stream = canvas.captureStream(30);
    dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    const mime = pickMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6000000 } : {});
    lastExt = (rec.mimeType || '').includes('mp4') ? 'mp4' : 'webm';
    const chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise(r => rec.onstop = r);
    rec.start(1000);

    for (let n = 0; n < segs.length; n++) {
      const s = segs[n];
      const v = await getVid(s.clip);
      const start = Math.max(0, Number(s.start) || 0);
      const end = Math.min(v.duration || 1e9, Number(s.end) || 0);
      if (end - start < 0.1) continue;
      const speed = Math.min(2, Math.max(0.5, Number(s.speed) || 1));
      await seekTo(v, start);
      v.playbackRate = speed;
      await v.play();
      await new Promise(resolve => {
        const tick = () => {
          const t = v.currentTime;
          const prog = Math.min(1, Math.max(0, (t - start) / (end - start)));
          ctx.filter = filter;
          drawFrame(ctx, v, W, H, s.zoom ? 1 + 0.15 * prog : 1);
          ctx.filter = 'none';
          const c = caps.find(c => Number(c.clip) === Number(s.clip) && t >= c.start && t < c.end);
          if (c && c.text) drawCaption(ctx, W, H, c.text);
          st.textContent = '🎞️ Rendering part ' + (n + 1) + ' of ' + segs.length + '...\nKeep the app open and screen on.';
          if (t >= end || v.ended) { resolve(); return; }
          requestAnimationFrame(tick);
        };
        tick();
      });
      v.pause();
    }
    await wait(300);
    rec.stop();
    await stopped;
    actx.close();
    lastBlob = new Blob(chunks, { type: rec.mimeType || 'video/webm' });
    prev.src = URL.createObjectURL(lastBlob);
    prev.style.display = 'block';
    st.textContent = '✅ Done (' + Math.round(lastBlob.size / 1048576 * 10) / 10 + ' MB). Preview below.';
    const sb = document.createElement('button');
    sb.id = 'savebtn'; sb.className = 'btn primary';
    sb.textContent = '💾 Save / Share video';
    sb.onclick = saveVideo;
    prev.insertAdjacentElement('afterend', sb);
  } catch (e) {
    st.textContent = '❌ ' + e.message;
  }
  btn.disabled = false;
}
