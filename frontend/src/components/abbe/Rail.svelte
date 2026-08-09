<script lang="ts">
  /**
   * The conversation history: a sticky column beside the chat on a wide screen,
   * a sideways-scrolling strip above it on a narrow one.
   */

  import type { ChatSummary } from '../../lib/abbe/types'

  type Props = {
    chats: ChatSummary[]
    currentId: string | null
    onnew: () => void
    onopen: (id: string) => void
  }

  let { chats, currentId, onnew, onopen }: Props = $props()

  /**
   * Handled here rather than by the browser: a full navigation would re-run
   * auth and re-fetch the whole list to move between two conversations this
   * page already has. Modified clicks are left alone so open-in-new-tab works.
   */
  function open(event: MouseEvent, id: string) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    onopen(id)
  }
</script>

<nav class="rail" aria-label="Konversationer">
  <button class="new" type="button" onclick={onnew}>ny</button>

  <div class="rail-list">
    {#each chats as chat (chat.id)}
      <a
        class="entry"
        href="/abbe/{chat.id}"
        title={new Date(chat.updated_at).toLocaleString('sv-SE')}
        aria-current={chat.id === currentId ? 'page' : undefined}
        onclick={(event) => open(event, chat.id)}
      >
        {chat.title}
      </a>
    {/each}
  </div>
</nav>

<style>
  /* Narrow first. This scrolls sideways instead of down: the conversations are
     one line each, and a vertical list of them would push the prompt off the
     screen. The top margin is what clears the corner back arrow. */
  .rail {
    display: flex;
    align-items: baseline;
    gap: 1.25rem;
    margin-top: 4rem;
    padding: 0 1.5rem 0.75rem;
    border-bottom: 1px solid rgba(239, 237, 234, 0.12);
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scroll-snap-type: x proximity;
    /* A `start`-aligned snap target aligns to the scroll port's edge, which on
       load meant snapping the first item flush to the screen and scrolling the
       rail's own left padding out of view. This insets the snap edge instead. */
    scroll-padding-inline-start: 1.5rem;
    /* The strip is short and the entries are obviously draggable; a scrollbar
       across them costs more than it explains. */
    scrollbar-width: none;
  }

  .rail::-webkit-scrollbar {
    display: none;
  }

  /* `contents` so the entries become children of .rail itself and take part in
     its row directly — one scroll container instead of two nested ones. */
  .rail-list {
    display: contents;
  }

  .entry,
  .new {
    white-space: nowrap;
    scroll-snap-align: start;
    opacity: 0.45;
    transition: opacity 0.15s ease;
  }

  .entry:hover,
  .new:hover {
    opacity: 1;
  }

  /* The conversation on screen. Not underlined — it is where you already are. */
  .entry[aria-current='page'] {
    opacity: 1;
  }

  /* Keyboard only. Without this, tabbing through the rail moves an invisible
     focus: the hover rule is the only thing that ever lit a row up. */
  .entry:focus-visible,
  .new:focus-visible {
    outline: 1px solid var(--white);
    outline-offset: 3px;
    opacity: 1;
  }

  .new {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
    /* Left, not centred: as a stretched flex item in the desktop column a
       button centres its own label, which put "ny" in the middle of the rail
       while every title below it started at the edge. */
    text-align: left;
    cursor: pointer;
  }

  @media (min-width: 768px) {
    /* Stays put while the conversation scrolls past it. `max-height` rather
       than `height`, so a short list makes a short column and the moon below is
       not pushed off a mostly empty page. */
    .rail {
      position: sticky;
      top: 0;
      flex: 0 0 13rem;
      /* A flex item will not shrink below its content's min-content width, and
         `nowrap` titles make that the width of the longest one — so the basis
         above was ignored and the rail grew to fit a whole first sentence,
         taking the ellipsis with it. This is what makes 13rem mean 13rem. */
      min-width: 0;
      flex-direction: column;
      align-items: stretch;
      max-height: 100vh;
      margin-top: 0;
      /* Top padding clears the back arrow, and stays out of the scrolling area
         below — only .rail-list scrolls. */
      padding: 4.5rem 1.25rem 2rem 1.5rem;
      border-bottom: 0;
      border-right: 1px solid rgba(239, 237, 234, 0.12);
      overflow-x: visible;
    }

    /* The one thing that scrolls. `min-height: 0` is what lets a flex child
       shrink below its content and actually overflow. */
    .rail-list {
      display: block;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior-y: contain;
      scrollbar-width: thin;
    }

    /* One conversation per row. `display: block` is what stacks them; without
       it they are inline boxes that flow into each other. */
    .entry {
      display: block;
      position: relative;
      /* Titles are as long as the first thing said; the column is not. */
      overflow: hidden;
      text-overflow: ellipsis;
      /* The left inset holds the marker below. Kept on every row, not just the
         current one, so the titles do not shift sideways as it moves. */
      padding: 0.3rem 0 0.3rem 0.85rem;
      font-size: 0.95rem;
    }

    /* Which one you are in. Opacity alone reads as "slightly less faded" in a
       list where the row above may be hovered; a mark is unambiguous. */
    .entry[aria-current='page']::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0.95em;
      width: 0.28rem;
      height: 0.28rem;
      border-radius: 50%;
      background: currentColor;
    }

    /* Lines up with the titles rather than sitting 0.85rem to their left. */
    .new {
      padding-left: 0.85rem;
    }
  }
</style>
