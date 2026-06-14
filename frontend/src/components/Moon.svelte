<script>
    import { onMount } from 'svelte';
    import { navigate } from 'astro:transitions/client';

    export let clicky = false;

    let svg;
    let cursorEl;
    let cursorX = 0, cursorY = 0;
    let locked = false;
    let relock = false;

    const WHITE_CX = 117, WHITE_CY = 117, WHITE_R = 114;
    const BLACK_CX = 120, BLACK_CY = 117, BLACK_R = 119;
    const DENT_WIDTH = Math.PI / 4;
    const DENT_DEPTH = 1;

    function buildDentPath(cx, cy, R, angle, depth) {
        const N = 120;
        let d = '';
        for (let i = 0; i <= N; i++) {
            const phi = (i / N) * Math.PI * 2;
            let delta = phi - angle;
            delta = Math.atan2(Math.sin(delta), Math.cos(delta));
            const f = Math.abs(delta) < DENT_WIDTH
                ? 0.5 * (1 + Math.cos(Math.PI * delta / DENT_WIDTH))
                : 0;
            const rad = R - depth * f;
            const x = cx + rad * Math.cos(phi);
            const y = cy + rad * Math.sin(phi);
            d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2) + ' ';
        }
        return d + 'Z';
    }

    let whitePath = buildDentPath(WHITE_CX, WHITE_CY, WHITE_R, 0, 0);
    let blackPath = buildDentPath(BLACK_CX, BLACK_CY, BLACK_R, 0, 0);

    function setDent(angle, depth) {
        whitePath = buildDentPath(WHITE_CX, WHITE_CY, WHITE_R, angle, depth);
        blackPath = buildDentPath(BLACK_CX, BLACK_CY, BLACK_R, angle, depth);
    }

    function render() {
        cursorEl.style.transform = `translate(${cursorX}px, ${cursorY}px)`;
        cursorEl.style.opacity = locked ? 1 : 0;
    }

    function onMouseMove(e) {
        if (!locked) return;

        const rect = svg.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const moonR = WHITE_R * rect.height / 235;

        const toCenterX = cx - cursorX, toCenterY = cy - cursorY;
        const dist = Math.hypot(toCenterX, toCenterY);
        const r = dist / moonR;

        let mx = e.movementX, my = e.movementY;

        if (r < 1 && dist > 0) {
            const nx = toCenterX / dist, ny = toCenterY / dist;
            const inward = mx * nx + my * ny;
            if (inward > 0) {
                const resistance = Math.min(1, 0.8 + (1 - r) * 0.4);
                mx -= inward * resistance * nx;
                my -= inward * resistance * ny;
            }
        }

        cursorX = Math.max(0, Math.min(window.innerWidth, cursorX + mx));
        cursorY = Math.max(0, Math.min(window.innerHeight, cursorY + my));
        render();

        if (r < 1 && dist > 0) {
            const angle = Math.atan2(cursorY - cy, cursorX - cx);
            const push = (1 - r) * 0.5 * moonR;
            svg.style.transform = `translate(${-Math.cos(angle) * push}px, ${-Math.sin(angle) * push}px)`;
            setDent(angle, (1 - r) * DENT_DEPTH * WHITE_R);
        } else {
            svg.style.transform = 'translate(0px, 0px)';
            setDent(0, 0);
        }
    }

    function lockCursor() {
        const p = document.documentElement.requestPointerLock();
        if (p && typeof p.catch === 'function') p.catch(() => {});
    }

    function enableClicky(e) {
        const icon = e.currentTarget.querySelector('img');
        const rect = (icon ?? e.currentTarget).getBoundingClientRect();
        cursorX = rect.left;
        cursorY = rect.top;
        lockCursor();
    }

    function onClick(e) {
        if (!locked) return;
        e.preventDefault();
        const target = document.elementFromPoint(cursorX, cursorY);
        const clickable = target?.closest('a, button');
        if (!clickable) return;
        const href = clickable.getAttribute('href');
        if (href) {
            relock = true;
            navigate(href);
        } else {
            clickable.click();
        }
    }

    function onLockChange() {
        locked = document.pointerLockElement === document.documentElement;
        render();
    }

    function onAfterSwap() {
        if (!relock) return;
        relock = false;
        if (document.pointerLockElement !== document.documentElement) {
            lockCursor();
        }
    }

    onMount(() => {
        if (!clicky) return;
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('click', onClick);
        document.addEventListener('pointerlockchange', onLockChange);
        document.addEventListener('astro:after-swap', onAfterSwap);
        return () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('click', onClick);
            document.removeEventListener('pointerlockchange', onLockChange);
            document.removeEventListener('astro:after-swap', onAfterSwap);
        };
    });
</script>

{#if clicky}
  <img bind:this={cursorEl} class="cursor" src="/mouse.svg" alt="" />
  {#if !locked}
    <button class="clicky-toggle" on:click={enableClicky} aria-label="Aktivera musläge">
      <img src="/mouse.svg" alt="" />
    </button>
  {/if}
{/if}

<svg bind:this={svg} role="img" width="248" height="235" viewBox="0 0 248 235" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d={blackPath} fill="black"/>
  <path d={whitePath} fill="#EFEDEA"/>
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
    width: 32px;
    height: auto;
    pointer-events: none;
    opacity: 0;
    z-index: 9999;
    will-change: transform;
  }

  .clicky-toggle {
    position: fixed;
    bottom: 1.5rem;
    left: 1.5rem;
    padding: 0.5rem;
    background: none;
    border: none;
    line-height: 0;
    cursor: pointer;
    opacity: 0.45;
    transform-origin: left bottom;
    transition: opacity 0.15s ease, transform 0.15s ease;
    z-index: 9998;
  }

  .clicky-toggle:hover {
    opacity: 1;
    transform: scale(var(--hover-scale));
  }

  .clicky-toggle img {
    width: 28px;
    height: auto;
    display: block;
  }

</style>
