<script>
    import { onMount } from 'svelte';

    let svg;
    let cursorEl;
    let cursorX = 0, cursorY = 0;
    let locked = false;
    let gsap;

    function render() {
        gsap.set(cursorEl, { x: cursorX, y: cursorY, opacity: locked ? 1 : 0 });
    }

    function onMouseMove(e) {
        if (!locked) return;

        const rect = svg.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const moonR = (114 / 117.5) * (rect.height / 2);

        const toCenterX = cx - cursorX, toCenterY = cy - cursorY;
        const dist = Math.sqrt(toCenterX * toCenterX + toCenterY * toCenterY);
        const r = dist / moonR;

        let mx = e.movementX, my = e.movementY;

        if (r < 1 && dist > 0) {
            const nx = toCenterX / dist, ny = toCenterY / dist;
            const inward = mx * nx + my * ny;
            if (inward > 0) {
                const baseResistance = Math.min(1, 0.8 + (1 - r) * 0.4);
                const tangX = mx - inward * nx;
                const tangY = my - inward * ny;
                const newInward = inward * (1 - baseResistance);
                mx = tangX + newInward * nx;
                my = tangY + newInward * ny;
            }
        }

        cursorX = Math.max(0, Math.min(window.innerWidth, cursorX + mx));
        cursorY = Math.max(0, Math.min(window.innerHeight, cursorY + my));
        render();

        if (r < 1 && dist > 0) {
            const angle = Math.atan2(cursorY - cy, cursorX - cx);
            const pushAmount = (1-r) * 0.5 * moonR;
            gsap.set(svg, { x: -Math.cos(angle) * pushAmount, y: -Math.sin(angle) * pushAmount });
        } else {
            gsap.set(svg, { x: 0, y: 0 });
        }
    }

    function onClick(e) {
        if (locked) return;
        cursorX = e.clientX;
        cursorY = e.clientY;
        document.body.requestPointerLock();
    }

    function onLockChange() {
        locked = document.pointerLockElement === document.body;
        render();
    }

    onMount(async () => {
        ({ default: gsap } = await import('gsap'));
        cursorX = window.innerWidth / 2;
        cursorY = window.innerHeight / 2;
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('click', onClick);
        document.addEventListener('pointerlockchange', onLockChange);
        return () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('click', onClick);
            document.removeEventListener('pointerlockchange', onLockChange);
        };
    });
</script>

<img bind:this={cursorEl} class="cursor" src="/mouse.svg" alt="" />

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
    width: 32px;
    height: auto;
    pointer-events: none;
    opacity: 0;
    z-index: 9999;
    will-change: transform;
  }

</style>
