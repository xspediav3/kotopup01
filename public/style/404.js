/* 404 page - Xiao / Anemo theme */
(() => {
  "use strict";

  function drawAnemo() {
    const canvas = document.getElementById("anemo");
    if (!canvas || !canvas.getContext) return;

    const ctx = canvas.getContext("2d");
    let width = 0;
    let height = 0;
    let frame = 0;
    let animationId = 0;
    const reduceMotion = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    }

    function draw() {
      ctx.clearRect(0, 0, width, height);
      const t = reduceMotion ? 0 : frame * 0.012;
      const centerX = width * 0.5;
      const centerY = height * 0.76;
      const maxRadius = Math.min(width, height) * 0.34;

      // Soft Anemo rings around Xiao
      for (let ring = 0; ring < 3; ring++) {
        ctx.beginPath();
        const radius = maxRadius * (0.48 + ring * 0.19);
        for (let step = 0; step <= 100; step++) {
          const angle = (step / 100) * Math.PI * 2;
          const wave = Math.sin(angle * 3 + t + ring) * 9;
          const x = centerX + Math.cos(angle + t * (ring % 2 ? -1 : 1)) * (radius + wave);
          const y = centerY + Math.sin(angle + t * (ring % 2 ? -1 : 1)) * (radius * 0.34 + wave * 0.4);
          if (step === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = `rgba(99, 255, 226, ${0.10 - ring * 0.02})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Floating Anemo motes
      for (let i = 0; i < 16; i++) {
        const angle = i * 2.399 + t * (i % 2 ? 1 : -1);
        const distance = maxRadius * (0.55 + (i % 4) * 0.12);
        const x = centerX + Math.cos(angle) * distance;
        const y = centerY + Math.sin(angle) * distance * 0.42;
        const size = 1.8 + (i % 3);
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(174, 255, 242, 0.72)";
        ctx.shadowColor = "#45f4d6";
        ctx.shadowBlur = 12;
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }

    function animate() {
      draw();
      frame++;
      animationId = window.requestAnimationFrame(animate);
    }

    resize();
    if (!reduceMotion) animationId = window.requestAnimationFrame(animate);
    window.addEventListener("resize", resize, { passive: true });

    window.addEventListener("pagehide", () => {
      if (animationId) window.cancelAnimationFrame(animationId);
    }, { once: true });
  }

  document.addEventListener("DOMContentLoaded", drawAnemo);

  // Keep existing navigation behavior and routes.
  window.goHome = function goHome() {
    window.location.href = "/";
  };

  window.reportIssue = function reportIssue() {
    window.location.href = "/dashboard";
  };
})();
