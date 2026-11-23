/* 404 page - Xiao / Anemo theme */
(() => {
  'use strict';

  const canvas = document.getElementById('anemo');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let w = 0, h = 0, frame = 0, raf = 0;
  let motes = [];

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    motes = Array.from({ length: Math.max(18, Math.min(42, Math.round(w / 18))) }, (_, i) => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 1 + Math.random() * 2.2,
      speed: .18 + Math.random() * .48,
      drift: (Math.random() - .5) * .34,
      phase: i * .8
    }));
    draw();
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    const t = reduced ? 0 : frame * .012;
    const cx = w * .5;
    const cy = h * .79;
    const rx = Math.min(w * .48, 340);
    const ry = Math.min(h * .14, 145);

    // Soft swirling Anemo rings beneath Xiao.
    for (let ring = 0; ring < 3; ring++) {
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const a = i / 120 * Math.PI * 2;
        const wave = Math.sin(a * 4 + t + ring) * 7;
        const x = cx + Math.cos(a + t * (ring % 2 ? -.22 : .22)) * (rx * (.58 + ring * .16) + wave);
        const y = cy + Math.sin(a + t * (ring % 2 ? -.22 : .22)) * (ry * (.58 + ring * .16) + wave * .25);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `rgba(116,255,232,${.15 - ring * .035})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Tiny floating wind particles.
    for (const p of motes) {
      const pulse = .55 + Math.sin(t * 2 + p.phase) * .28;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * pulse, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(191,255,246,${.35 + pulse * .45})`;
      ctx.shadowColor = '#69ffe8';
      ctx.shadowBlur = 12;
      ctx.fill();
      if (!reduced) {
        p.y -= p.speed;
        p.x += p.drift + Math.sin(t + p.phase) * .12;
        if (p.y < -8) { p.y = h + 8; p.x = Math.random() * w; }
        if (p.x < -8) p.x = w + 8;
        if (p.x > w + 8) p.x = -8;
      }
    }
    ctx.shadowBlur = 0;
  }

  function animate() {
    draw();
    frame++;
    raf = requestAnimationFrame(animate);
  }

  resize();
  if (!reduced) raf = requestAnimationFrame(animate);
  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('pagehide', () => { if (raf) cancelAnimationFrame(raf); }, { once: true });
})();
