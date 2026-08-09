<script lang="ts">
  /**
   * The prompt line: a transparent textarea over a mirror that draws the text
   * and a block caret.
   *
   * The mirror is split around the selection so the block sits where typing
   * will actually land. Drawn from `start`/`end` rather than from the end of
   * the value — the version that assumed the end left nothing on screen saying
   * where the next character would go, which on a phone meant tapping into the
   * middle of a line and guessing.
   */

  type Props = {
    value: string
    /** Whether the caret sits at the very end. The ghost depends on it. */
    atEnd?: boolean
    busy?: boolean
    ghost?: string
    onkeydown?: (event: KeyboardEvent) => void
    onsubmit?: () => void
  }

  let {
    value = $bindable(''),
    atEnd = $bindable(true),
    busy = false,
    ghost = '',
    onkeydown,
    onsubmit,
  }: Props = $props()

  let el: HTMLTextAreaElement | undefined = $state()
  let start = $state(0)
  let end = $state(0)
  let focused = $state(false)

  /**
   * The caret moves for more reasons than typing: arrow keys, a tap into the
   * middle of a line, a drag, undo, autocorrect. `selectionchange` covers all
   * of them on current browsers; the input/keyup/click handlers below are belt
   * for older ones and cost two derived strings.
   */
  export function readSelection() {
    if (!el) return
    start = el.selectionStart ?? 0
    end = el.selectionEnd ?? start
    atEnd = start === end && end === el.value.length
  }

  export function focus() {
    el?.focus()
  }

  /** Replace the whole line and put the caret at the end, as recall does. */
  export function replace(next: string) {
    value = next
    // The textarea has not been updated by Svelte yet at this point, so the
    // caret is moved once it has.
    queueMicrotask(() => {
      if (!el) return
      el.value = next
      el.setSelectionRange(next.length, next.length)
      readSelection()
    })
  }

  const before = $derived(value.slice(0, start))
  const selected = $derived(value.slice(start, end))
  const after = $derived(value.slice(end))

  // With a range there is no single insertion point to mark, and the highlight
  // already says what is going to be replaced.
  const caretShown = $derived(start === end)

  $effect(() => {
    const onSelectionChange = () => {
      if (document.activeElement === el) readSelection()
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  })

  function handleKeydown(event: KeyboardEvent) {
    onkeydown?.(event)
    if (event.defaultPrevented) return

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onsubmit?.()
    }
  }
</script>

<!-- The prompt while a turn is in flight dims rather than emptying, and the
     textarea is only readOnly — disabling a focused textarea hands focus back
     to the document, and the caret is drawn from this element's selection, so
     it would leave the screen mid-turn. -->
<form class="line" class:busy onsubmit={(e) => { e.preventDefault(); onsubmit?.() }}>
  <span class="who">Albert</span>

  <div class="field" class:focused>
    <!-- aria-hidden: a duplicate of the textarea's own value. -->
    <div class="mirror" aria-hidden="true"><span>{before}</span><span
        class="cursor"
        class:hidden={!caretShown}
        class:idle={!focused}
      ></span><span class="sel">{selected}</span><span>{after}</span><span class="ghost"
      >{ghost}</span></div>

    <textarea
      bind:this={el}
      bind:value
      rows="1"
      autocomplete="off"
      spellcheck="false"
      readonly={busy}
      onkeydown={handleKeydown}
      oninput={readSelection}
      onkeyup={readSelection}
      onclick={readSelection}
      onpointerup={readSelection}
      onselect={readSelection}
      onfocus={() => { focused = true; readSelection() }}
      onblur={() => (focused = false)}
    ></textarea>
  </div>
</form>

<style>
  .line {
    display: grid;
    grid-template-columns: var(--label) 1fr;
    gap: 0 var(--gap);
    align-items: start;
    margin-bottom: 1.15rem;
  }

  .line.busy {
    opacity: 0.45;
  }

  /* Joan ships Regular only, so the browser synthesises this weight. */
  .who {
    font-weight: 700;
    color: var(--me);
  }

  .field {
    display: grid;
  }

  .mirror,
  textarea {
    grid-area: 1 / 1;
    font: inherit;
    line-height: inherit;
    padding: 0;
    margin: 0;
    border: 0;
  }

  .mirror {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  textarea {
    width: 100%;
    resize: none;
    overflow: hidden;
    background: none;
    /* Both transparent: the mirror above is the visible text and the caret. */
    color: transparent;
    caret-color: transparent;
  }

  textarea:focus {
    outline: none;
  }

  /* The mirror draws the selection. Left alone, the textarea paints its own
     highlight on top of text that is deliberately invisible, so a selection
     came out as a bar with nothing in it. */
  textarea::selection {
    background: transparent;
  }

  .sel {
    background: rgba(239, 237, 234, 0.22);
  }

  /* The rest of the command being typed. Dim enough to read as a suggestion
     rather than as something you already wrote. */
  .ghost {
    opacity: 0.28;
  }

  .cursor {
    display: inline-block;
    width: 0.5em;
    height: 1em;
    background: var(--white);
    vertical-align: -0.15em;
    animation: blink 1s steps(1, end) infinite;
  }

  .cursor.hidden {
    display: none;
  }

  .cursor.idle {
    animation: none;
    opacity: 0.3;
  }

  @keyframes blink {
    50% {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .cursor {
      animation: none;
    }
  }
</style>
