<script>
    import { onMount } from 'svelte';

    const SLOW = 0.2;

    let svg;
    let cursorEl;
    let targetX = 0, targetY = 0;
    let fakeX = 0, fakeY = 0;
    let insideMoon = false;
    let locked = false;
    let gsap;

    function isInsideMoon(x, y) {
        const rect = svg.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const r = (114 / 117.5) * (rect.height / 2);
        const dx = x - cx, dy = y - cy;
        return dx * dx + dy * dy < r * r;
    }

    function tick() {
        fakeX += (targetX - fakeX) * 0.35;
        fakeY += (targetY - fakeY) * 0.35;
        gsap.set(cursorEl, { x: fakeX, y: fakeY, opacity: locked ? 1 : 0 });
    }

    function onMouseMove(e) {
        if (!locked) return;

        insideMoon = isInsideMoon(targetX, targetY);
        const factor = insideMoon ? SLOW : 1;
        targetX = Math.max(0, Math.min(window.innerWidth, targetX + e.movementX * factor));
        targetY = Math.max(0, Math.min(window.innerHeight, targetY + e.movementY * factor));

        const rect = svg.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const angle = Math.atan2(targetY - cy, targetX - cx);
        const radius = Math.sqrt((targetX - cx) ** 2 + (targetY - cy) ** 2);

        // TODO: drive animations with angle (radians, −π..π) and radius (pixels)
    }

    function onClick(e) {
        if (locked) return;
        fakeX = targetX = e.clientX;
        fakeY = targetY = e.clientY;
        document.body.requestPointerLock();
    }

    function onLockChange() {
        locked = document.pointerLockElement === document.body;
    }

    onMount(async () => {
        ({ default: gsap } = await import('gsap'));
        fakeX = targetX = window.innerWidth / 2;
        fakeY = targetY = window.innerHeight / 2;
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('click', onClick);
        document.addEventListener('pointerlockchange', onLockChange);
        gsap.ticker.add(tick);
        return () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('click', onClick);
            document.removeEventListener('pointerlockchange', onLockChange);
            gsap.ticker.remove(tick);
        };
    });
</script>

<div bind:this={cursorEl} class="cursor"></div>

{#if !locked}
  <div class="hint">click to enter</div>
{/if}

<svg bind:this={svg} role="img" width="248" height="235" viewBox="0 0 248 235" fill="none" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="118.433" cy="117.5" rx="118.433" ry="117.5" fill="black"/>
  <ellipse cx="129.567" cy="117.5" rx="118.433" ry="117.5" fill="black"/>
  <rect x="112.359" width="12.1469" height="235" fill="black"/>
  <circle cx="117" cy="117" r="114" fill="#EFEDEA"/>
</svg>

<style>
  svg {
    width: 100%;
    height: 100%;
  }

  .cursor {
    position: fixed;
    top: 0;
    left: 0;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: black;
    pointer-events: none;
    translate: -50% -50%;
    opacity: 0;
    z-index: 9999;
  }

  .hint {
    position: fixed;
    bottom: 1.5rem;
    left: 1.5rem;
    font-size: 0.9rem;
    opacity: 0.5;
    pointer-events: none;
  }
</style>
